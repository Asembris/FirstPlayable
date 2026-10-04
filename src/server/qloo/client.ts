/**
 * The three-operation Qloo adapter (specification section 6, "Typed surface").
 *
 * ```ts
 * resolveArtist(query)
 * getMovieReferences(artistId)
 * getVideogameReferences(artistId)
 * ```
 *
 * That is the whole surface. There is no `request(path, params)`, no caller
 * supplied URL, no caller-supplied filter, and no pass-through of a query
 * string from a route body. A new Qloo capability would require a new function
 * here and a new frozen request shape, which is exactly the point: no route in
 * this application can be used as a general Qloo proxy.
 *
 * The exact bytes on the wire, verified live on 4 October 2026:
 *
 * ```http
 * GET {base}/search?query=<encoded>&types=urn:entity:artist&take=5
 * GET {base}/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=<uuid>&take=10
 * GET {base}/v2/insights?filter.type=urn:entity:videogame&signal.interests.entities=<uuid>&take=10
 * X-Api-Key: <server secret>
 * ```
 *
 * `urn:entity:videogame` is the verified type. `urn:entity:video_game` does
 * not appear anywhere in this repository.
 *
 * Discipline enforced here:
 *
 *   * **TLS verification stays on.** Nothing in this module touches
 *     `NODE_TLS_REJECT_UNAUTHORIZED`, `strict-ssl`, or an agent option.
 *   * **The key is never returned, logged, or echoed.** It exists in one
 *     header on one request.
 *   * **The application owns the retry budget.** One retry, only for a
 *     connection failure, a 429, or a 5xx. Never for 400/401/403 and never for
 *     a malformed success. Retries consume quota and are counted.
 *   * **Every launch, including a retry, takes a global lease first.** The
 *     lease is held across the network call and released afterwards; no
 *     database transaction is open while the socket is.
 */

import { qlooEnv, type QlooEnv } from "../config";
import {
  ARTIST_SEARCH_TAKE,
  type ArtistSearchSnapshot,
  QLOO_ARTIST_TYPE,
  QLOO_DOMAIN_FILTER_TYPE,
  type QlooDomain,
  type QuotaDiagnostics,
  type ReferenceCapture,
  REFERENCES_TAKE,
} from "@/domain/qloo";
import { QUOTA_HEADERS } from "./contracts";
import {
  artistSearchFingerprint,
  normalizeArtistSearch,
  normalizeQuery,
  normalizeReferences,
  QlooNormalizeError,
  referenceFingerprint,
} from "./normalize";

/** Specification section 6: 8 seconds for search, 25 for insights. */
export const ARTIST_SEARCH_TIMEOUT_MS = 8_000;
export const INSIGHTS_TIMEOUT_MS = 25_000;

/** Specification section 6: bounded body reads, at most 3 MiB per response. */
export const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

/** One retry, so at most two attempts per operation. */
export const MAX_ATTEMPTS_PER_CALL = 2;

/** A `Retry-After` longer than this does not fit the stage budget and is refused. */
export const MAX_HONOURED_RETRY_AFTER_MS = 10_000;

export const QLOO_ERROR_CODES = {
  /** The socket failed, or the request timed out. Retryable once. */
  QLOO_TRANSPORT: "QLOO_TRANSPORT",
  /** HTTP 429. Retryable once, respecting `Retry-After` when it fits. */
  QLOO_RATE_LIMITED: "QLOO_RATE_LIMITED",
  /** HTTP 5xx. Retryable once. */
  QLOO_UPSTREAM: "QLOO_UPSTREAM",
  /** HTTP 400. Never retried: the request shape is ours and is frozen. */
  QLOO_BAD_REQUEST: "QLOO_BAD_REQUEST",
  /** HTTP 401 or 403. Never retried: a credential problem, not a transient one. */
  QLOO_UNAUTHORIZED: "QLOO_UNAUTHORIZED",
  /** Any other unexpected status. Never retried. */
  QLOO_UNEXPECTED_STATUS: "QLOO_UNEXPECTED_STATUS",
  /** The body exceeded the read cap. Never retried. */
  QLOO_RESPONSE_TOO_LARGE: "QLOO_RESPONSE_TOO_LARGE",
  /** A successful response whose body was not parseable JSON. Never retried. */
  QLOO_MALFORMED_BODY: "QLOO_MALFORMED_BODY",
  /** Normalization refused the payload. Never retried. */
  QLOO_CONTRACT: "QLOO_CONTRACT",
  /** The global launch policy could not grant a lease in time. */
  QLOO_LAUNCH_UNAVAILABLE: "QLOO_LAUNCH_UNAVAILABLE",
  /** The local conservative allowance, or the judging reserve, blocks the call. */
  QLOO_QUOTA_RESERVED: "QLOO_QUOTA_RESERVED",
} as const;

export type QlooErrorCode = (typeof QLOO_ERROR_CODES)[keyof typeof QLOO_ERROR_CODES];

export class QlooError extends Error {
  readonly code: QlooErrorCode;
  /** How many upstream attempts this operation actually spent. */
  readonly attempts: number;
  readonly quota: QuotaDiagnostics | null;

  constructor(
    code: QlooErrorCode,
    detail: string,
    attempts: number,
    quota: QuotaDiagnostics | null = null,
  ) {
    super(`${code}: ${detail}`);
    this.name = "QlooError";
    this.code = code;
    this.attempts = attempts;
    this.quota = quota;
  }
}

const RETRYABLE: readonly QlooErrorCode[] = [
  QLOO_ERROR_CODES.QLOO_TRANSPORT,
  QLOO_ERROR_CODES.QLOO_RATE_LIMITED,
  QLOO_ERROR_CODES.QLOO_UPSTREAM,
];

// ---------------------------------------------------------------------------
// Launch leases
// ---------------------------------------------------------------------------

/**
 * A granted global launch lease. Released by the client once the socket is
 * closed, whether the attempt succeeded or failed.
 */
export type QlooLaunchLease = { release: () => Promise<void> };

/**
 * The global launch policy, supplied by the caller.
 *
 * In production this is the database-backed reservation in
 * `src/server/qloo/limiter.ts`, which is why the policy holds across
 * serverless instances. A test supplies a deterministic fake and asserts the
 * number of launches.
 */
export type QlooLaunchGuard = {
  acquire: (label: string) => Promise<QlooLaunchLease>;
};

/** A guard that grants immediately. Only for a unit test that is not measuring pacing. */
export const UNLIMITED_LAUNCHES: QlooLaunchGuard = {
  acquire: async () => ({ release: async () => undefined }),
};

export type QlooClientDeps = {
  env?: QlooEnv;
  fetchImpl?: typeof fetch;
  launch?: QlooLaunchGuard;
  /** Called with whatever quota headers the API actually returned. */
  onQuota?: (quota: QuotaDiagnostics) => void | Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type QlooCallDiagnostics = {
  attempts: number;
  retried: boolean;
  quota: QuotaDiagnostics | null;
  /** Elapsed wall-clock milliseconds across every attempt. */
  elapsed_ms: number;
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function readQuota(headers: Headers, observedAt: string): QuotaDiagnostics | null {
  const int = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const float = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const quota: QuotaDiagnostics = {
    month_limit: int(QUOTA_HEADERS.monthLimit),
    month_remaining: int(QUOTA_HEADERS.monthRemaining),
    month_reset_seconds: float(QUOTA_HEADERS.monthReset),
    second_limit: int(QUOTA_HEADERS.secondLimit),
    observed_at: observedAt,
  };
  const anyPresent =
    quota.month_limit !== null ||
    quota.month_remaining !== null ||
    quota.month_reset_seconds !== null ||
    quota.second_limit !== null;
  return anyPresent ? quota : null;
}

/** Reads at most {@link MAX_RESPONSE_BYTES}, cancelling the stream past the cap. */
async function readBoundedText(response: Response, attempts: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number.parseInt(declared, 10);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new QlooError(
        QLOO_ERROR_CODES.QLOO_RESPONSE_TOO_LARGE,
        `declared ${length} bytes, over the ${MAX_RESPONSE_BYTES} cap`,
        attempts,
      );
    }
  }

  const body = response.body;
  if (body === null) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new QlooError(
          QLOO_ERROR_CODES.QLOO_RESPONSE_TOO_LARGE,
          `read past the ${MAX_RESPONSE_BYTES} cap`,
          attempts,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function statusError(status: number, attempts: number, quota: QuotaDiagnostics | null): QlooError {
  if (status === 429) {
    return new QlooError(QLOO_ERROR_CODES.QLOO_RATE_LIMITED, "status 429", attempts, quota);
  }
  if (status >= 500) {
    return new QlooError(
      QLOO_ERROR_CODES.QLOO_UPSTREAM,
      `status ${status}`,
      attempts,
      quota,
    );
  }
  if (status === 400) {
    return new QlooError(QLOO_ERROR_CODES.QLOO_BAD_REQUEST, "status 400", attempts, quota);
  }
  if (status === 401 || status === 403) {
    return new QlooError(
      QLOO_ERROR_CODES.QLOO_UNAUTHORIZED,
      `status ${status}`,
      attempts,
      quota,
    );
  }
  return new QlooError(
    QLOO_ERROR_CODES.QLOO_UNEXPECTED_STATUS,
    `status ${status}`,
    attempts,
    quota,
  );
}

type AttemptOutcome = {
  body: unknown;
  quota: QuotaDiagnostics | null;
};

/**
 * One bounded GET with the key header, a lease, a timeout, and one retry.
 *
 * The lease is acquired per attempt, so a retry is paced by the same global
 * policy as a first launch. It is released in a `finally`, so an aborted
 * request cannot strand concurrency.
 */
async function getJson(
  url: string,
  options: {
    label: string;
    timeoutMs: number;
    env: QlooEnv;
    deps: QlooClientDeps;
  },
): Promise<{ outcome: AttemptOutcome; diagnostics: QlooCallDiagnostics }> {
  const { deps } = options;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const launch = deps.launch ?? UNLIMITED_LAUNCHES;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock().getTime();

  let attempts = 0;
  let lastQuota: QuotaDiagnostics | null = null;
  let lastError: QlooError | null = null;

  while (attempts < MAX_ATTEMPTS_PER_CALL) {
    attempts += 1;
    const lease = await launch.acquire(options.label);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { "X-Api-Key": options.env.apiKey, accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (cause) {
        // A timeout and a refused socket are the same thing to the caller: one
        // spent attempt that reached no usable response.
        lastError = new QlooError(
          QLOO_ERROR_CODES.QLOO_TRANSPORT,
          cause instanceof Error ? cause.name : "unknown transport failure",
          attempts,
          lastQuota,
        );
        continue;
      }

      const observedAt = clock().toISOString();
      const quota = readQuota(response.headers, observedAt);
      if (quota !== null) {
        lastQuota = quota;
        await deps.onQuota?.(quota);
      }

      if (!response.ok) {
        const error = statusError(response.status, attempts, lastQuota);
        // Drain nothing: an error body may carry provider diagnostics that
        // must not be read into this application's state.
        await response.body?.cancel();
        if (!RETRYABLE.includes(error.code) || attempts >= MAX_ATTEMPTS_PER_CALL) throw error;
        const after = retryAfterMs(response.headers);
        if (after !== null && after > MAX_HONOURED_RETRY_AFTER_MS) throw error;
        lastError = error;
        await sleep((after ?? 250) + Math.floor(Math.random() * 120));
        continue;
      }

      const text = await readBoundedText(response, attempts);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // A malformed success is never retried: the request was answered.
        throw new QlooError(
          QLOO_ERROR_CODES.QLOO_MALFORMED_BODY,
          "a successful response was not parseable JSON",
          attempts,
          lastQuota,
        );
      }

      return {
        outcome: { body, quota: lastQuota },
        diagnostics: {
          attempts,
          retried: attempts > 1,
          quota: lastQuota,
          elapsed_ms: clock().getTime() - startedAt,
        },
      };
    } finally {
      clearTimeout(timer);
      await lease.release();
    }
  }

  throw (
    lastError ??
    new QlooError(QLOO_ERROR_CODES.QLOO_TRANSPORT, "no attempt produced a response", attempts)
  );
}

function wrapNormalizeError(cause: unknown, attempts: number, quota: QuotaDiagnostics | null): never {
  if (cause instanceof QlooNormalizeError) {
    throw new QlooError(QLOO_ERROR_CODES.QLOO_CONTRACT, cause.message, attempts, quota);
  }
  throw cause;
}

// ---------------------------------------------------------------------------
// The three frozen operations
// ---------------------------------------------------------------------------

export type ResolveArtistResult = {
  snapshot: Omit<ArtistSearchSnapshot, "capture_id" | "cache">;
  diagnostics: QlooCallDiagnostics;
};

/**
 * `GET /search?query=<encoded>&types=urn:entity:artist&take=5`
 *
 * Returns every well-formed returned artist, in the order the API returned
 * them. It deliberately does **not** pick one: identity confirmation is an
 * explicit creator action (specification section 6).
 */
export async function resolveArtist(
  query: string,
  deps: QlooClientDeps = {},
): Promise<ResolveArtistResult> {
  const env = deps.env ?? qlooEnv();
  const normalizedQuery = normalizeQuery(query);
  const fingerprint = artistSearchFingerprint({ host: env.host, normalizedQuery });

  const url =
    `${env.baseUrl}/search?query=${encodeURIComponent(query)}` +
    `&types=${encodeURIComponent(QLOO_ARTIST_TYPE)}` +
    `&take=${ARTIST_SEARCH_TAKE}`;

  const { outcome, diagnostics } = await getJson(url, {
    label: "artist_search",
    timeoutMs: ARTIST_SEARCH_TIMEOUT_MS,
    env,
    deps,
  });

  try {
    return {
      snapshot: normalizeArtistSearch(outcome.body, {
        query,
        normalizedQuery,
        requestFingerprint: fingerprint,
        retrievedAt: (deps.now ?? (() => new Date()))().toISOString(),
      }),
      diagnostics,
    };
  } catch (cause) {
    wrapNormalizeError(cause, diagnostics.attempts, diagnostics.quota);
  }
}

export type ReferenceResult = {
  capture: Omit<ReferenceCapture, "capture_id" | "cache">;
  diagnostics: QlooCallDiagnostics;
};

/**
 * One first hop. Private, because only the two exported wrappers below may
 * choose a domain: there is no caller-supplied `filter.type` anywhere.
 */
async function getReferences(
  domain: QlooDomain,
  artistEntityId: string,
  deps: QlooClientDeps,
): Promise<ReferenceResult> {
  const env = deps.env ?? qlooEnv();
  const upper = artistEntityId.toUpperCase();
  const fingerprint = referenceFingerprint({
    host: env.host,
    artistEntityId: upper,
    domain,
  });

  const url =
    `${env.baseUrl}/v2/insights` +
    `?filter.type=${encodeURIComponent(QLOO_DOMAIN_FILTER_TYPE[domain])}` +
    `&signal.interests.entities=${encodeURIComponent(upper)}` +
    `&take=${REFERENCES_TAKE}`;

  const { outcome, diagnostics } = await getJson(url, {
    label: domain === "movie" ? "references_movie" : "references_videogame",
    timeoutMs: INSIGHTS_TIMEOUT_MS,
    env,
    deps,
  });

  try {
    return {
      capture: normalizeReferences(outcome.body, {
        domain,
        artistEntityId: upper,
        requestFingerprint: fingerprint,
        retrievedAt: (deps.now ?? (() => new Date()))().toISOString(),
      }),
      diagnostics,
    };
  } catch (cause) {
    wrapNormalizeError(cause, diagnostics.attempts, diagnostics.quota);
  }
}

/**
 * `GET /v2/insights?filter.type=urn:entity:movie&signal.interests.entities=<uuid>&take=10`
 */
export function getMovieReferences(
  artistEntityId: string,
  deps: QlooClientDeps = {},
): Promise<ReferenceResult> {
  return getReferences("movie", artistEntityId, deps);
}

/**
 * `GET /v2/insights?filter.type=urn:entity:videogame&signal.interests.entities=<uuid>&take=10`
 *
 * `urn:entity:videogame` is the verified working type.
 */
export function getVideogameReferences(
  artistEntityId: string,
  deps: QlooClientDeps = {},
): Promise<ReferenceResult> {
  return getReferences("videogame", artistEntityId, deps);
}

/** The exact request URLs, for the evidence record and for contract tests. */
export function frozenRequestShapes(baseUrl: string): Record<string, string> {
  return {
    artist_search:
      `GET ${baseUrl}/search?query=<encoded>&types=${QLOO_ARTIST_TYPE}&take=${ARTIST_SEARCH_TAKE}`,
    references_movie:
      `GET ${baseUrl}/v2/insights?filter.type=${QLOO_DOMAIN_FILTER_TYPE.movie}` +
      `&signal.interests.entities=<uuid>&take=${REFERENCES_TAKE}`,
    references_videogame:
      `GET ${baseUrl}/v2/insights?filter.type=${QLOO_DOMAIN_FILTER_TYPE.videogame}` +
      `&signal.interests.entities=<uuid>&take=${REFERENCES_TAKE}`,
  };
}
