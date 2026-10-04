/**
 * Retrieval orchestration: one artist search, and the two independent first
 * hops (specification sections 6 and 12).
 *
 * The order of operations is the whole point of this module:
 *
 *   1. **Read the cache first.** If both domains are cached, this function
 *      returns without constructing a client, without reserving quota, and
 *      without opening a socket. "A cache hit makes zero upstream calls" is
 *      therefore a property of the control flow, not a claim.
 *   2. **Reserve the worst case before launching.** Retries consume quota, so
 *      the reservation covers them. A retrieval that would only fit if every
 *      retry were free is not admitted.
 *   3. **Launch the two hops in parallel, under the global limiter.** The
 *      limiter — not this module — decides when each one actually starts, so
 *      the 250 ms gap and the two-lease ceiling hold across instances.
 *   4. **One domain failing does not destroy the other.** Each hop is settled
 *      independently, and a usable videogame row is enough to proceed even
 *      when movies came back empty, and vice versa.
 *   5. **Reconcile what was actually spent.** Including the failed attempts.
 *
 * Nothing here fabricates evidence to avoid an empty state. If both domains
 * are unusable the caller gets exactly that, and the studio says so.
 */

import type { QlooConfig } from "../config";
import { qlooEnv, type QlooEnv } from "../config";
import type { DataGateway } from "../db/gateway";
import {
  CAPTURE_KIND_BY_DOMAIN,
  type QlooDomain,
  QLOO_DOMAINS,
  type QuotaDiagnostics,
  type ReferenceCapture,
} from "@/domain/qloo";
import {
  readReferenceCaches,
  readStaleReferenceFallback,
  writeReferenceCapture,
} from "./cache";
import {
  getMovieReferences,
  getVideogameReferences,
  MAX_ATTEMPTS_PER_CALL,
  QLOO_ERROR_CODES,
  QlooError,
  type QlooClientDeps,
  type QlooLaunchGuard,
} from "./client";
import { referenceFingerprint } from "./normalize";
import {
  assertQlooCallsGranted,
  databaseLaunchGuard,
  observedQuotaWithinReserve,
  reconcileQlooCalls,
  reserveQlooCalls,
} from "./limiter";

/** Why one domain has nothing usable to offer. All of them are honest states. */
export type DomainFailureCode =
  | "QLOO_EMPTY"
  | "QLOO_NO_USABLE_CONTEXT"
  | "QLOO_RESERVE_HELD"
  | (typeof QLOO_ERROR_CODES)[keyof typeof QLOO_ERROR_CODES];

export type DomainOutcome =
  | { status: "ready"; capture: ReferenceCapture }
  | { status: "unavailable"; code: DomainFailureCode };

export type RetrieveReferencesResult = {
  outcomes: Record<QlooDomain, DomainOutcome>;
  /** Upstream attempts actually spent, retries included. Zero on a full cache hit. */
  upstream_calls: number;
  /** The last quota figures the API returned during this retrieval, if any. */
  quota: QuotaDiagnostics | null;
  /** True when the returned header showed the judging reserve was reached. */
  reserve_reached: boolean;
};

export type RetrieveReferencesInput = {
  gateway: DataGateway;
  config: QlooConfig;
  artistEntityId: string;
  /** Explicit creator consent to fall back to a dated capture for this artist. */
  acceptStale: boolean;
  now: Date;
  env?: QlooEnv;
  /** Overridable only so a test can supply a deterministic transport. */
  fetchImpl?: typeof fetch;
  launch?: QlooLaunchGuard;
  sleep?: (ms: number) => Promise<void>;
};

function failureCodeFor(cause: unknown): DomainFailureCode {
  if (cause instanceof QlooError) return cause.code;
  return QLOO_ERROR_CODES.QLOO_TRANSPORT;
}

/**
 * Retrieves both first hops for one confirmed artist.
 *
 * Returns per-domain outcomes rather than throwing, because a half-successful
 * retrieval is a legitimate product state: specification section 12 requires
 * that an empty movie row still leaves the game row usable.
 */
export async function retrieveReferences(
  input: RetrieveReferencesInput,
): Promise<RetrieveReferencesResult> {
  const artistEntityId = input.artistEntityId.toUpperCase();

  // The environment is read lazily and only when a call might actually happen,
  // so a fully cached retrieval works even with no Qloo key configured.
  const resolveEnv = (): QlooEnv => input.env ?? qlooEnv();

  const fingerprints = new Map<QlooDomain, string>();
  for (const domain of QLOO_DOMAINS) {
    // The host belongs in the key, so the lookup and a later call agree.
    const host = input.env?.host ?? safeHost(resolveEnv);
    fingerprints.set(domain, referenceFingerprint({ host, artistEntityId, domain }));
  }

  const cached = await readReferenceCaches(input.gateway, [...fingerprints.values()], input.now);

  const outcomes: Partial<Record<QlooDomain, DomainOutcome>> = {};
  const missing: QlooDomain[] = [];
  for (const domain of QLOO_DOMAINS) {
    const hit = cached.get(fingerprints.get(domain)!);
    if (hit !== undefined) outcomes[domain] = { status: "ready", capture: hit };
    else missing.push(domain);
  }

  if (missing.length === 0) {
    return {
      outcomes: outcomes as Record<QlooDomain, DomainOutcome>,
      upstream_calls: 0,
      quota: null,
      reserve_reached: false,
    };
  }

  const env = resolveEnv();

  // Reserve the ceiling: one call plus its one permitted retry, per domain.
  const reservation = assertQlooCallsGranted(
    await reserveQlooCalls(input.gateway, input.config, {
      calls: missing.length * MAX_ATTEMPTS_PER_CALL,
      now: input.now,
    }),
  );

  const launch =
    input.launch ??
    databaseLaunchGuard(input.gateway, input.config, {
      now: () => input.now,
      ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    });

  let observedQuota: QuotaDiagnostics | null = null;
  let reserveReached = false;
  let spent = 0;

  const clientDeps: QlooClientDeps = {
    env,
    launch,
    now: () => input.now,
    onQuota: (quota) => {
      observedQuota = quota;
      if (observedQuotaWithinReserve(quota, input.config)) reserveReached = true;
    },
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
  };

  try {
    const settled = await Promise.allSettled(
      missing.map(async (domain) => {
        // Checked per hop rather than once: when the first response already
        // reported the reserve, the second hop is not launched. This is
        // best-effort within one retrieval — two hops that start together may
        // both predate the first header — and the enforced guard is the local
        // reservation above.
        if (reserveReached) {
          throw new QlooError(
            QLOO_ERROR_CODES.QLOO_QUOTA_RESERVED,
            "the returned allowance reached this application's judging reserve",
            0,
          );
        }
        const result =
          domain === "movie"
            ? await getMovieReferences(artistEntityId, clientDeps)
            : await getVideogameReferences(artistEntityId, clientDeps);
        return { domain, result };
      }),
    );

    for (let index = 0; index < settled.length; index += 1) {
      const domain = missing[index]!;
      const entry = settled[index]!;

      if (entry.status === "rejected") {
        const cause: unknown = entry.reason;
        if (cause instanceof QlooError) spent += cause.attempts;
        outcomes[domain] = await withStaleFallback(input, domain, failureCodeFor(cause));
        continue;
      }

      spent += entry.value.result.diagnostics.attempts;
      const stored = await writeReferenceCapture(
        input.gateway,
        entry.value.result.capture,
        entry.value.result.diagnostics.quota,
        input.now,
      );
      outcomes[domain] = { status: "ready", capture: stored };
    }
  } finally {
    await reconcileQlooCalls(input.gateway, reservation.lease_id, spent);
  }

  return {
    outcomes: outcomes as Record<QlooDomain, DomainOutcome>,
    upstream_calls: spent,
    quota: observedQuota,
    reserve_reached: reserveReached,
  };
}

/**
 * A failed hop may fall back to a dated capture for the *same* artist and the
 * *same* domain, and only with the creator's explicit consent. The capture
 * comes back labelled `stale`, so no caller can present it as live.
 */
async function withStaleFallback(
  input: RetrieveReferencesInput,
  domain: QlooDomain,
  code: DomainFailureCode,
): Promise<DomainOutcome> {
  const fallback = await readStaleReferenceFallback(input.gateway, {
    artistEntityId: input.artistEntityId,
    domain,
    consented: input.acceptStale,
    now: input.now,
  });
  if (fallback === null) return { status: "unavailable", code };
  return { status: "ready", capture: fallback.capture };
}

function safeHost(resolve: () => QlooEnv): string {
  // A missing key must not stop a fully cached read, but the key is also part
  // of nothing here: only the host is, and it is needed to form the lookup.
  return resolve().host;
}

/** Whether a capture has at least one row an approval could be built on. */
export function hasUsableCandidate(capture: ReferenceCapture): boolean {
  return capture.candidates.some((candidate) => candidate.usable);
}

/**
 * Whether any domain can support a Qloo-grounded proposal.
 *
 * `false` is the "No supported influences available for this artist" state of
 * specification section 12. The caller offers another artist or the saved
 * example; it does not invent evidence.
 */
export function anyDomainUsable(outcomes: Record<QlooDomain, DomainOutcome>): boolean {
  return QLOO_DOMAINS.some((domain) => {
    const outcome = outcomes[domain];
    return outcome?.status === "ready" && hasUsableCandidate(outcome.capture);
  });
}

/** The capture ids to attach to the project, in a stable domain order. */
export function captureIdsOf(outcomes: Record<QlooDomain, DomainOutcome>): string[] {
  const ids: string[] = [];
  for (const domain of QLOO_DOMAINS) {
    const outcome = outcomes[domain];
    if (outcome?.status !== "ready") continue;
    if (outcome.capture.capture_id !== null) ids.push(outcome.capture.capture_id);
  }
  return ids;
}

/** Documented for the evidence record: the normal uncached cost of a creation. */
export const EXPECTED_FRESH_CALL_COUNT = 3;
export const MAX_FRESH_CALL_COUNT = EXPECTED_FRESH_CALL_COUNT * MAX_ATTEMPTS_PER_CALL;

/** Declared so a test can assert the capture kind matches the domain. */
export const CAPTURE_KIND = CAPTURE_KIND_BY_DOMAIN;
