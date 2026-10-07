import { describe, expect, it } from "vitest";
import {
  ARRIVAL_ID,
  AUDITION_FIXTURES,
  insights,
  MOON_ID,
  O_BROTHER_ID,
  OUTER_WILDS_ID,
  LANTERNFOLD_ENTITY_ID,
} from "../../fixtures/qloo/audition";
import type { QlooEnv } from "../../src/server/config";
import {
  QLOO_ERROR_CODES,
  QlooError,
  scoreComps,
  searchComps,
  UNLIMITED_LAUNCHES,
} from "../../src/server/qloo/client";
import { compScoreFingerprint, readCompScoreCache, writeCompScoreCapture } from "../../src/server/qloo/audition";
import { MemoryGateway } from "./support/memory-gateway";

const ENV: QlooEnv = {
  apiKey: "test-key-not-a-real-credential",
  baseUrl: "https://qloo.invalid",
  host: "qloo.invalid",
};

function transport(responses: readonly (() => Response)[]) {
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  }) as unknown as typeof fetch;
  return {
    urls,
    deps: { env: ENV, fetchImpl, launch: UNLIMITED_LAUNCHES, sleep: async () => undefined },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(QlooError);
    return (error as QlooError).code;
  }
  throw new Error("expected a QlooError");
}

describe("searchComps", () => {
  it("asks for one domain's type and returns candidates in returned order, choosing none", async () => {
    const { urls, deps } = transport([() => json(AUDITION_FIXTURES.searchMoon)]);
    const result = await searchComps("movie", "Moon", deps);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("types")).toBe("urn:entity:movie");
    expect(url.searchParams.get("take")).toBe("5");
    expect(result.snapshot.kind).toBe("comp_search");
    expect(result.snapshot.candidates.map((c) => [c.name, c.original_rank, c.year])).toEqual([
      ["Moon", 1, 2009],
      ["Moonrise Kingdom", 2, 2012],
    ]);
  });

  it("sends the verified videogame type for a game comp", async () => {
    const { urls, deps } = transport([() => json(AUDITION_FIXTURES.searchOuterWilds)]);
    await searchComps("videogame", "Outer Wilds", deps);
    expect(new URL(urls[0]!).searchParams.get("types")).toBe("urn:entity:videogame");
  });

  it("refuses a search whose rows are typed as another domain", async () => {
    const { deps } = transport([() => json(AUDITION_FIXTURES.searchMoonWrongType)]);
    expect(await codeOf(searchComps("movie", "Moon", deps))).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
  });
});

describe("scoreComps", () => {
  const audience = LANTERNFOLD_ENTITY_ID;

  it("sends one audience, one domain, and exactly the confirmed candidate ids", async () => {
    const { urls, deps } = transport([
      () => json(insights("urn:entity:movie", [[MOON_ID, "Moon", 0.8], [ARRIVAL_ID, "Arrival", 0.6]])),
    ]);
    await scoreComps({ audienceEntityId: audience.toLowerCase(), domain: "movie", candidateEntityIds: [ARRIVAL_ID, MOON_ID.toLowerCase()] }, deps);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/v2/insights");
    expect(url.searchParams.get("filter.type")).toBe("urn:entity:movie");
    expect(url.searchParams.get("signal.interests.entities")).toBe(audience);
    expect(url.searchParams.get("filter.results.entities")).toBe([ARRIVAL_ID, MOON_ID].sort().join(","));
    expect(url.searchParams.get("take")).toBe("2");
    // Nothing else: no second signal, no second domain, no extra filter.
    expect([...url.searchParams.keys()].sort()).toEqual([
      "filter.results.entities",
      "filter.type",
      "signal.interests.entities",
      "take",
    ]);
  });

  it("keeps the returned affinity and the returned name", async () => {
    const { deps } = transport([
      () => json(insights("urn:entity:movie", [[MOON_ID, "Moon", 0.812345], [ARRIVAL_ID, "Arrival", 0.6]])),
    ]);
    const { capture } = await scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID, ARRIVAL_ID] }, deps);
    expect(capture.scores).toEqual([
      { entity_id: MOON_ID, name: "Moon", affinity: 0.812345 },
      { entity_id: ARRIVAL_ID, name: "Arrival", affinity: 0.6 },
    ]);
    expect(capture.missing_entity_ids).toEqual([]);
  });

  it("records a requested candidate Qloo did not return as missing, never scored", async () => {
    const { deps } = transport([() => json(insights("urn:entity:movie", [[MOON_ID, "Moon", 0.7]]))]);
    const { capture } = await scoreComps(
      { audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID, ARRIVAL_ID, O_BROTHER_ID] },
      deps,
    );
    expect(capture.scores.map((s) => s.entity_id)).toEqual([MOON_ID]);
    expect(capture.missing_entity_ids).toEqual([ARRIVAL_ID, O_BROTHER_ID].sort());
  });

  it("keeps a returned row with no affinity as a null score", async () => {
    const { deps } = transport([
      () => json(insights("urn:entity:movie", [[MOON_ID, "Moon", null], [ARRIVAL_ID, "Arrival", 0.4]])),
    ]);
    const { capture } = await scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID, ARRIVAL_ID] }, deps);
    expect(capture.scores[0]).toEqual({ entity_id: MOON_ID, name: "Moon", affinity: null });
  });

  it("refuses the whole capture when Qloo returns an entity that was not requested", async () => {
    const { deps } = transport([
      () => json(insights("urn:entity:movie", [[MOON_ID, "Moon", 0.8], [O_BROTHER_ID, "O Brother, Where Art Thou?", 0.9]])),
    ]);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID, ARRIVAL_ID] }, deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
  });

  it("refuses a videogame row in a movie score capture", async () => {
    const { deps } = transport([() => json(insights("urn:entity:videogame", [[MOON_ID, "Moon", 0.8]]))]);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID] }, deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
  });

  it("refuses an error-shaped success and an envelope with no entities", async () => {
    const failed = transport([() => json({ success: false, results: { entities: [] } })]);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID] }, failed.deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
    const empty = transport([() => json({ success: true })]);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID] }, empty.deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
  });

  it("retries a 5xx once and never retries a 401", async () => {
    const flaky = transport([
      () => json({}, 503),
      () => json(insights("urn:entity:movie", [[MOON_ID, "Moon", 0.5]])),
    ]);
    const { diagnostics } = await scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID] }, flaky.deps);
    expect(diagnostics.attempts).toBe(2);

    const denied = transport([() => json({}, 401)]);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [MOON_ID] }, denied.deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_UNAUTHORIZED);
    expect(denied.urls).toHaveLength(1);
  });

  it("makes no call at all for a malformed or oversized candidate set", async () => {
    const { urls, deps } = transport([() => json({})]);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: ["not-a-uuid"] }, deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
    expect(
      await codeOf(scoreComps({ audienceEntityId: audience, domain: "movie", candidateEntityIds: [] }, deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_CONTRACT);
    expect(
      await codeOf(scoreComps({ audienceEntityId: "nope", domain: "movie", candidateEntityIds: [MOON_ID] }, deps)),
    ).toBe(QLOO_ERROR_CODES.QLOO_BAD_REQUEST);
    expect(urls).toHaveLength(0);
  });
});

describe("score capture storage", () => {
  it("keys movies and videogames, and each candidate set, separately", () => {
    const base = { host: ENV.host, audienceEntityId: audienceId(), candidateIds: [MOON_ID] };
    const movie = compScoreFingerprint({ ...base, domain: "movie" });
    expect(compScoreFingerprint({ ...base, domain: "videogame" })).not.toBe(movie);
    expect(compScoreFingerprint({ ...base, domain: "movie", candidateIds: [MOON_ID, ARRIVAL_ID] })).not.toBe(movie);
    // Order and case of the confirmed ids do not matter.
    expect(
      compScoreFingerprint({ ...base, domain: "movie", candidateIds: [ARRIVAL_ID, MOON_ID.toLowerCase()] }),
    ).toBe(compScoreFingerprint({ ...base, domain: "movie", candidateIds: [MOON_ID, ARRIVAL_ID] }));
  });

  it("stores a score capture where the earlier product's stale lookup cannot see it", async () => {
    const gateway = new MemoryGateway();
    const now = new Date("2026-10-07T10:00:00.000Z");
    gateway.setClock(() => now);
    const { deps } = transport([() => json(insights("urn:entity:videogame", [[OUTER_WILDS_ID, "Outer Wilds", 0.5]]))]);
    const { capture } = await scoreComps({ audienceEntityId: audienceId(), domain: "videogame", candidateEntityIds: [OUTER_WILDS_ID] }, deps);
    const stored = await writeCompScoreCapture(gateway, capture, null, now);
    expect(stored.cache).toBe("live");
    expect(await gateway.findLatestQlooCapture(audienceId(), "videogame")).toBeNull();
    const hit = await readCompScoreCache(gateway, capture.request_fingerprint, now);
    expect(hit?.cache).toBe("cached");
    expect(hit?.scores).toEqual(capture.scores);
  });
});

function audienceId(): string {
  return LANTERNFOLD_ENTITY_ID;
}
