import { describe, expect, it } from "vitest";
import { QLOO_FIXTURES, RADIOHEAD_ENTITY_ID } from "../../fixtures/qloo";
import type { QlooEnv } from "../../src/server/config";
import {
  ARTIST_SEARCH_TIMEOUT_MS,
  frozenRequestShapes,
  getMovieReferences,
  getVideogameReferences,
  INSIGHTS_TIMEOUT_MS,
  MAX_ATTEMPTS_PER_CALL,
  MAX_RESPONSE_BYTES,
  QLOO_ERROR_CODES,
  QlooError,
  resolveArtist,
  type QlooClientDeps,
  type QlooLaunchGuard,
} from "../../src/server/qloo/client";

const ENV: QlooEnv = {
  apiKey: "test-key-not-a-real-credential",
  baseUrl: "https://qloo.invalid",
  host: "qloo.invalid",
};

type Recorded = { url: string; headers: Record<string, string> };

/** A fake transport that records every request and replays scripted responses. */
function transport(responses: readonly (() => Response | Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(input), headers });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error("no scripted response");
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A launch guard that counts acquisitions and releases, as the limiter would. */
function countingGuard(): QlooLaunchGuard & { acquired: string[]; released: number } {
  const state = {
    acquired: [] as string[],
    released: 0,
    acquire: async (label: string) => {
      state.acquired.push(label);
      return {
        release: async () => {
          state.released += 1;
        },
      };
    },
  };
  return state;
}

function deps(
  fetchImpl: typeof fetch,
  overrides: Partial<QlooClientDeps> = {},
): QlooClientDeps {
  return {
    env: ENV,
    fetchImpl,
    sleep: async () => undefined,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    ...overrides,
  };
}

describe("the three frozen request shapes", () => {
  it("sends exactly the verified artist-search URL and the key header", async () => {
    const { fetchImpl, calls } = transport([() => json(QLOO_FIXTURES.searchRadiohead)]);
    await resolveArtist("Radiohead", deps(fetchImpl));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://qloo.invalid/search?query=Radiohead&types=urn%3Aentity%3Aartist&take=5",
    );
    expect(calls[0]?.headers["x-api-key"]).toBe(ENV.apiKey);
  });

  it("percent-encodes a hostile query instead of letting it add a parameter", async () => {
    const { fetchImpl, calls } = transport([() => json({ results: [] })]);
    await resolveArtist("a&filter.type=urn:entity:movie&x= #", deps(fetchImpl));
    const url = new URL(calls[0]?.url ?? "");
    // One query, one types, one take. Nothing the creator typed became a parameter.
    expect([...url.searchParams.keys()].sort()).toEqual(["query", "take", "types"]);
    expect(url.searchParams.get("query")).toBe("a&filter.type=urn:entity:movie&x= #");
    expect(url.searchParams.get("types")).toBe("urn:entity:artist");
  });

  it("sends the verified movie first-hop URL", async () => {
    const { fetchImpl, calls } = transport([() => json(QLOO_FIXTURES.moviesRadiohead)]);
    await getMovieReferences(RADIOHEAD_ENTITY_ID, deps(fetchImpl));
    expect(calls[0]?.url).toBe(
      "https://qloo.invalid/v2/insights?filter.type=urn%3Aentity%3Amovie" +
        `&signal.interests.entities=${RADIOHEAD_ENTITY_ID}&take=10`,
    );
  });

  it("sends urn:entity:videogame, the type that was actually verified", async () => {
    const { fetchImpl, calls } = transport([() => json(QLOO_FIXTURES.videogamesRadiohead)]);
    await getVideogameReferences(RADIOHEAD_ENTITY_ID.toLowerCase(), deps(fetchImpl));
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("filter.type")).toBe("urn:entity:videogame");
    expect(url.searchParams.get("filter.type")).not.toBe("urn:entity:video_game");
    // The confirmed UUID is sent in the canonical case the API returned.
    expect(url.searchParams.get("signal.interests.entities")).toBe(RADIOHEAD_ENTITY_ID);
    expect(url.pathname).toBe("/v2/insights");
  });

  it("documents the same shapes it sends", () => {
    const shapes = frozenRequestShapes(ENV.baseUrl);
    expect(Object.keys(shapes).sort()).toEqual([
      "artist_search",
      "comp_scores",
      "comp_search",
      "references_movie",
      "references_videogame",
    ]);
    expect(shapes["references_videogame"]).toContain("urn:entity:videogame");
    expect(JSON.stringify(shapes)).not.toContain("video_game");
  });

  it("never sends a trends, audience, popularity, or explainability parameter", async () => {
    const { fetchImpl, calls } = transport([
      () => json(QLOO_FIXTURES.searchRadiohead),
      () => json(QLOO_FIXTURES.moviesRadiohead),
      () => json(QLOO_FIXTURES.videogamesRadiohead),
    ]);
    const shared = deps(fetchImpl);
    await resolveArtist("Radiohead", shared);
    await getMovieReferences(RADIOHEAD_ENTITY_ID, shared);
    await getVideogameReferences(RADIOHEAD_ENTITY_ID, shared);
    for (const call of calls) {
      for (const forbidden of [
        "trends",
        "audience",
        "demographic",
        "popularity",
        "explain",
        "feature.",
        "bias.",
        "offset",
        "page",
        "tag",
      ]) {
        expect(call.url.includes(forbidden), `${call.url} contains ${forbidden}`).toBe(false);
      }
    }
  });
});

describe("timeouts, body caps, and quota headers", () => {
  it("uses the specified per-operation timeouts", () => {
    expect(ARTIST_SEARCH_TIMEOUT_MS).toBe(8_000);
    expect(INSIGHTS_TIMEOUT_MS).toBe(25_000);
    expect(MAX_RESPONSE_BYTES).toBe(3 * 1024 * 1024);
  });

  it("arms an abort signal on every attempt and refuses a redirect", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return json(QLOO_FIXTURES.searchRadiohead);
    }) as unknown as typeof fetch;
    await resolveArtist("Radiohead", deps(fetchImpl));
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal?.aborted).toBe(false);
    // A redirect to another host would move the key somewhere it must not go.
    expect(seen?.redirect).toBe("error");
    expect(seen?.method).toBe("GET");
  });

  it("treats an aborted request as one spent transport attempt", async () => {
    const { fetchImpl, calls } = transport([
      () => {
        throw new DOMException("aborted", "AbortError");
      },
    ]);
    const error = await resolveArtist("Radiohead", deps(fetchImpl)).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(QlooError);
    expect((error as QlooError).code).toBe(QLOO_ERROR_CODES.QLOO_TRANSPORT);
    // One retry, so a dead socket costs two attempts and then stops.
    expect(calls).toHaveLength(MAX_ATTEMPTS_PER_CALL);
    expect((error as QlooError).attempts).toBe(MAX_ATTEMPTS_PER_CALL);
  });

  it("refuses a declared body over the cap without reading it", async () => {
    const { fetchImpl } = transport([
      () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_RESPONSE_BYTES + 1),
          },
        }),
    ]);
    await expect(resolveArtist("Radiohead", deps(fetchImpl))).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_RESPONSE_TOO_LARGE }) as Error,
    );
  });

  it("refuses a body that grows past the cap while being read", async () => {
    const chunk = new Uint8Array(256 * 1024);
    const { fetchImpl } = transport([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]);
    await expect(resolveArtist("Radiohead", deps(fetchImpl))).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_RESPONSE_TOO_LARGE }) as Error,
    );
  });

  it("records the quota headers the API actually returned", async () => {
    const { fetchImpl } = transport([
      () =>
        json(QLOO_FIXTURES.searchRadiohead, {
          headers: {
            "content-type": "application/json",
            "x-month-ratelimit-limit": "10000",
            "x-month-ratelimit-remaining": "9548",
            "x-month-ratelimit-reset": "2476804.26",
            "x-second-ratelimit-limit": "5",
          },
        }),
    ]);
    const observed: unknown[] = [];
    const result = await resolveArtist(
      "Radiohead",
      deps(fetchImpl, {
        onQuota: (quota) => {
          observed.push(quota);
        },
      }),
    );
    expect(result.diagnostics.quota).toEqual({
      month_limit: 10_000,
      month_remaining: 9_548,
      month_reset_seconds: 2_476_804.26,
      second_limit: 5,
      observed_at: "2026-10-04T10:00:00.000Z",
    });
    expect(observed).toHaveLength(1);
  });

  it("leaves quota null when no header came back, rather than inventing a figure", async () => {
    const { fetchImpl } = transport([() => json(QLOO_FIXTURES.searchRadiohead)]);
    const result = await resolveArtist("Radiohead", deps(fetchImpl));
    expect(result.diagnostics.quota).toBeNull();
  });

  it("rejects a successful response whose body is not JSON, without retrying", async () => {
    const { fetchImpl, calls } = transport([
      () => new Response("<html>nope</html>", { status: 200 }),
    ]);
    await expect(resolveArtist("Radiohead", deps(fetchImpl))).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_MALFORMED_BODY }) as Error,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("the retry budget", () => {
  it("permits exactly one retry, so an operation costs at most two calls", async () => {
    expect(MAX_ATTEMPTS_PER_CALL).toBe(2);
    const { fetchImpl, calls } = transport([
      () => new Response("", { status: 503 }),
      () => json(QLOO_FIXTURES.searchRadiohead),
    ]);
    const result = await resolveArtist("Radiohead", deps(fetchImpl));
    expect(calls).toHaveLength(2);
    expect(result.diagnostics.attempts).toBe(2);
    expect(result.diagnostics.retried).toBe(true);
  });

  it("stops after the retry and reports the upstream failure", async () => {
    const { fetchImpl, calls } = transport([() => new Response("", { status: 502 })]);
    await expect(resolveArtist("Radiohead", deps(fetchImpl))).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_UPSTREAM }) as Error,
    );
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 and honours a Retry-After that fits the stage budget", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = transport([
      () => new Response("", { status: 429, headers: { "retry-after": "1" } }),
      () => json(QLOO_FIXTURES.moviesRadiohead),
    ]);
    await getMovieReferences(
      RADIOHEAD_ENTITY_ID,
      deps(fetchImpl, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    );
    expect(calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1_000);
  });

  it("refuses a Retry-After that does not fit the stage budget", async () => {
    const { fetchImpl, calls } = transport([
      () => new Response("", { status: 429, headers: { "retry-after": "600" } }),
    ]);
    await expect(getMovieReferences(RADIOHEAD_ENTITY_ID, deps(fetchImpl))).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_RATE_LIMITED }) as Error,
    );
    expect(calls).toHaveLength(1);
  });

  it("never retries a 400, a 401, or a 403", async () => {
    for (const [status, code] of [
      [400, QLOO_ERROR_CODES.QLOO_BAD_REQUEST],
      [401, QLOO_ERROR_CODES.QLOO_UNAUTHORIZED],
      [403, QLOO_ERROR_CODES.QLOO_UNAUTHORIZED],
    ] as const) {
      const { fetchImpl, calls } = transport([() => new Response("", { status })]);
      await expect(resolveArtist("Radiohead", deps(fetchImpl))).rejects.toThrow(
        expect.objectContaining({ code }) as Error,
      );
      expect(calls, `status ${status}`).toHaveLength(1);
    }
  });

  it("never retries a payload the normalizer refused", async () => {
    const { fetchImpl, calls } = transport([() => json({ success: false, error: "nope" })]);
    await expect(resolveArtist("Radiohead", deps(fetchImpl))).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_CONTRACT }) as Error,
    );
    expect(calls).toHaveLength(1);
  });

  it("returns no provider diagnostic in the error it raises", async () => {
    const { fetchImpl } = transport([
      () =>
        new Response(JSON.stringify({ internal: "stack trace", key: "secret" }), {
          status: 403,
          headers: { "x-provider-detail": "do not echo me" },
        }),
    ]);
    const error = await resolveArtist("Radiohead", deps(fetchImpl)).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(QlooError);
    const text = `${(error as Error).name}: ${(error as Error).message}`;
    expect(text).not.toContain("stack trace");
    expect(text).not.toContain("do not echo me");
    expect(text).not.toContain(ENV.apiKey);
  });
});

describe("the global launch guard", () => {
  it("takes a lease for every launch and releases it afterwards", async () => {
    const guard = countingGuard();
    const { fetchImpl } = transport([
      () => json(QLOO_FIXTURES.searchRadiohead),
      () => json(QLOO_FIXTURES.moviesRadiohead),
    ]);
    const shared = deps(fetchImpl, { launch: guard });
    await resolveArtist("Radiohead", shared);
    await getMovieReferences(RADIOHEAD_ENTITY_ID, shared);
    expect(guard.acquired).toEqual(["artist_search", "references_movie"]);
    expect(guard.released).toBe(2);
  });

  it("takes a lease for the retry too, because a retry consumes quota", async () => {
    const guard = countingGuard();
    const { fetchImpl } = transport([
      () => new Response("", { status: 500 }),
      () => json(QLOO_FIXTURES.searchRadiohead),
    ]);
    await resolveArtist("Radiohead", deps(fetchImpl, { launch: guard }));
    expect(guard.acquired).toEqual(["artist_search", "artist_search"]);
    expect(guard.released).toBe(2);
  });

  it("releases the lease even when the attempt throws", async () => {
    const guard = countingGuard();
    const { fetchImpl } = transport([() => new Response("", { status: 401 })]);
    await resolveArtist("Radiohead", deps(fetchImpl, { launch: guard })).catch(() => undefined);
    expect(guard.acquired).toHaveLength(1);
    expect(guard.released).toBe(1);
  });
});
