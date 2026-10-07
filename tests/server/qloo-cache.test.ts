import { beforeEach, describe, expect, it } from "vitest";
import { QLOO_FIXTURES, RADIOHEAD_ENTITY_ID } from "../../fixtures/qloo";
import type { ArtistSearchSnapshot, ReferenceCapture } from "../../src/domain/qloo";
import {
  CACHE_TTL_SECONDS,
  readArtistSearchById,
  readArtistSearchCache,
  readCapturesByIds,
  readReferenceCache,
  readReferenceCaches,
  readStaleReferenceFallback,
  STALE_FALLBACK_MAX_AGE_SECONDS,
  writeArtistSearchCapture,
  writeReferenceCapture,
} from "../../src/server/qloo/cache";
import {
  artistSearchFingerprint,
  normalizeArtistSearch,
  normalizeQuery,
  normalizeReferences,
  referenceFingerprint,
} from "../../src/server/qloo/normalize";
import { MemoryGateway } from "./support/memory-gateway";

const T0 = new Date("2026-10-04T10:00:00.000Z");
const HOST = "example.invalid";

function at(offsetSeconds: number): Date {
  return new Date(T0.getTime() + offsetSeconds * 1000);
}

function searchSnapshot(
  query = "Radiohead",
  raw: unknown = QLOO_FIXTURES.searchRadiohead,
): Omit<ArtistSearchSnapshot, "capture_id" | "cache"> {
  const normalizedQuery = normalizeQuery(query);
  return normalizeArtistSearch(raw, {
    query,
    normalizedQuery,
    requestFingerprint: artistSearchFingerprint({ host: HOST, normalizedQuery }),
    retrievedAt: T0.toISOString(),
  });
}

function referenceCapture(
  domain: "movie" | "videogame",
  artistEntityId = RADIOHEAD_ENTITY_ID,
  retrievedAt = T0.toISOString(),
): Omit<ReferenceCapture, "capture_id" | "cache"> {
  const raw =
    domain === "movie" ? QLOO_FIXTURES.moviesRadiohead : QLOO_FIXTURES.videogamesRadiohead;
  return normalizeReferences(raw, {
    domain,
    artistEntityId,
    requestFingerprint: referenceFingerprint({ host: HOST, artistEntityId, domain }),
    retrievedAt,
  });
}

describe("the artist-search cache", () => {
  let gateway: MemoryGateway;

  beforeEach(() => {
    gateway = new MemoryGateway();
    gateway.setClock(() => T0);
  });

  it("answers a repeat lookup from the capture, making no upstream call", async () => {
    const snapshot = searchSnapshot();
    const written = await writeArtistSearchCapture(gateway, snapshot, null, T0);
    expect(written.cache).toBe("live");
    expect(written.capture_id).not.toBeNull();

    const hit = await readArtistSearchCache(gateway, snapshot.request_fingerprint, at(60));
    expect(hit?.cache).toBe("cached");
    expect(hit?.candidates[0]?.entity_id).toBe(RADIOHEAD_ENTITY_ID);
    // The capture row was written once and read back; nothing fetched anything.
    expect(gateway.captures.size).toBe(1);
  });

  it("keeps a populated search for twenty-four hours and no longer", async () => {
    const snapshot = searchSnapshot();
    await writeArtistSearchCapture(gateway, snapshot, null, T0);
    const key = snapshot.request_fingerprint;

    expect(await readArtistSearchCache(gateway, key, at(CACHE_TTL_SECONDS.artistSearch - 1)))
      .not.toBeNull();
    expect(await readArtistSearchCache(gateway, key, at(CACHE_TTL_SECONDS.artistSearch + 1)))
      .toBeNull();
  });

  it("keeps an empty search for ten minutes, so a typo is not remembered for a day", async () => {
    const snapshot = searchSnapshot("zzqxvno", QLOO_FIXTURES.searchNoMatch);
    expect(snapshot.candidates).toEqual([]);
    await writeArtistSearchCapture(gateway, snapshot, null, T0);
    const key = snapshot.request_fingerprint;

    expect(
      await readArtistSearchCache(gateway, key, at(CACHE_TTL_SECONDS.emptyArtistSearch - 1)),
    ).not.toBeNull();
    expect(
      await readArtistSearchCache(gateway, key, at(CACHE_TTL_SECONDS.emptyArtistSearch + 1)),
    ).toBeNull();
  });

  it("never answers one query out of another query's capture", async () => {
    await writeArtistSearchCapture(gateway, searchSnapshot("Radiohead"), null, T0);
    const other = artistSearchFingerprint({
      host: HOST,
      normalizedQuery: normalizeQuery("Metallica"),
    });
    expect(await readArtistSearchCache(gateway, other, at(1))).toBeNull();
  });

  it("treats a capture whose stored payload no longer parses as a miss", async () => {
    const snapshot = searchSnapshot();
    await gateway.insertQlooCapture({
      kind: "search",
      requestFingerprint: snapshot.request_fingerprint,
      normalizedQuery: snapshot.normalized_query,
      artistEntityId: null,
      domain: null,
      results: { candidates: "this is not a snapshot" },
      quotaDiagnostics: null,
      normalizerVersion: snapshot.normalizer_version,
      cacheExpiresAt: at(3_600).toISOString(),
    });
    // A miss, so the caller refetches. It is never served as a degraded hit.
    expect(await readArtistSearchCache(gateway, snapshot.request_fingerprint, at(1))).toBeNull();
  });

  it("reads a search snapshot by id regardless of its lookup TTL", async () => {
    const written = await writeArtistSearchCapture(gateway, searchSnapshot(), null, T0);
    const byId = await readArtistSearchById(gateway, written.capture_id!);
    expect(byId?.candidates).toHaveLength(5);
  });
});

describe("the first-hop cache", () => {
  let gateway: MemoryGateway;

  beforeEach(() => {
    gateway = new MemoryGateway();
    gateway.setClock(() => T0);
  });

  it("answers a repeat retrieval from the capture, making no upstream call", async () => {
    const capture = referenceCapture("movie");
    await writeReferenceCapture(gateway, capture, null, T0);
    const hit = await readReferenceCache(gateway, capture.request_fingerprint, at(60));
    expect(hit?.cache).toBe("cached");
    expect(hit?.candidates).toHaveLength(10);
    expect(hit?.artist_entity_id).toBe(RADIOHEAD_ENTITY_ID);
  });

  it("keeps a first hop for seven days and no longer", async () => {
    const capture = referenceCapture("movie");
    await writeReferenceCapture(gateway, capture, null, T0);
    const key = capture.request_fingerprint;
    expect(await readReferenceCache(gateway, key, at(CACHE_TTL_SECONDS.firstHop - 1)))
      .not.toBeNull();
    expect(await readReferenceCache(gateway, key, at(CACHE_TTL_SECONDS.firstHop + 1))).toBeNull();
  });

  it("reads both domains in one round trip and keys them apart", async () => {
    const movies = referenceCapture("movie");
    const games = referenceCapture("videogame");
    await writeReferenceCapture(gateway, movies, null, T0);
    await writeReferenceCapture(gateway, games, null, T0);

    const hits = await readReferenceCaches(
      gateway,
      [movies.request_fingerprint, games.request_fingerprint],
      at(60),
    );
    expect(hits.size).toBe(2);
    expect(hits.get(movies.request_fingerprint)?.domain).toBe("movie");
    expect(hits.get(games.request_fingerprint)?.domain).toBe("videogame");
  });

  it("never answers a movie request out of a videogame capture", async () => {
    await writeReferenceCapture(gateway, referenceCapture("videogame"), null, T0);
    const movieKey = referenceFingerprint({
      host: HOST,
      artistEntityId: RADIOHEAD_ENTITY_ID,
      domain: "movie",
    });
    expect(await readReferenceCache(gateway, movieKey, at(1))).toBeNull();
  });

  it("never answers one artist's request out of another artist's capture", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    await writeReferenceCapture(gateway, referenceCapture("movie", other), null, T0);
    const radioheadKey = referenceFingerprint({
      host: HOST,
      artistEntityId: RADIOHEAD_ENTITY_ID,
      domain: "movie",
    });
    expect(await readReferenceCache(gateway, radioheadKey, at(1))).toBeNull();
  });

  it("reads the captures a frozen decision points at, whatever their TTL", async () => {
    const movies = await writeReferenceCapture(gateway, referenceCapture("movie"), null, T0);
    const games = await writeReferenceCapture(gateway, referenceCapture("videogame"), null, T0);
    const ids = [movies.capture_id!, games.capture_id!];

    // Long past every lookup TTL.
    gateway.setClock(() => at(CACHE_TTL_SECONDS.firstHop * 10));
    const frozen = await readCapturesByIds(gateway, ids);
    expect(frozen.map((capture) => capture.domain)).toEqual(["movie", "videogame"]);
  });
});

describe("the stale fallback", () => {
  let gateway: MemoryGateway;

  beforeEach(() => {
    gateway = new MemoryGateway();
    gateway.setClock(() => T0);
  });

  async function writeExpired(domain: "movie" | "videogame", artist = RADIOHEAD_ENTITY_ID) {
    await writeReferenceCapture(gateway, referenceCapture(domain, artist), null, T0);
  }

  it("refuses to hand back a stale capture without explicit consent", async () => {
    await writeExpired("movie");
    const beyondTtl = at(CACHE_TTL_SECONDS.firstHop + 60);
    expect(
      await readStaleReferenceFallback(gateway, {
        artistEntityId: RADIOHEAD_ENTITY_ID,
        domain: "movie",
        consented: false,
        now: beyondTtl,
      }),
    ).toBeNull();
  });

  it("labels a consented stale capture stale, with its age, and never live", async () => {
    await writeExpired("movie");
    const beyondTtl = at(CACHE_TTL_SECONDS.firstHop + 3_600);
    const fallback = await readStaleReferenceFallback(gateway, {
      artistEntityId: RADIOHEAD_ENTITY_ID,
      domain: "movie",
      consented: true,
      now: beyondTtl,
    });
    expect(fallback?.capture.cache).toBe("stale");
    expect(fallback?.capture.retrieved_at).toBe(T0.toISOString());
    expect(fallback?.age_seconds).toBeGreaterThan(CACHE_TTL_SECONDS.firstHop);
  });

  it("refuses a capture older than thirty days even with consent", async () => {
    await writeExpired("movie");
    expect(
      await readStaleReferenceFallback(gateway, {
        artistEntityId: RADIOHEAD_ENTITY_ID,
        domain: "movie",
        consented: true,
        now: at(STALE_FALLBACK_MAX_AGE_SECONDS + 60),
      }),
    ).toBeNull();
  });

  it("never substitutes another artist, even with consent", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    await writeExpired("movie", other);
    expect(
      await readStaleReferenceFallback(gateway, {
        artistEntityId: RADIOHEAD_ENTITY_ID,
        domain: "movie",
        consented: true,
        now: at(CACHE_TTL_SECONDS.firstHop + 60),
      }),
    ).toBeNull();
  });

  it("never substitutes another domain, even with consent", async () => {
    await writeExpired("videogame");
    expect(
      await readStaleReferenceFallback(gateway, {
        artistEntityId: RADIOHEAD_ENTITY_ID,
        domain: "movie",
        consented: true,
        now: at(CACHE_TTL_SECONDS.firstHop + 60),
      }),
    ).toBeNull();
  });
});

describe("capture immutability", () => {
  it("keeps distinct immutable evidence when two instances race the same key", async () => {
    const gateway = new MemoryGateway();
    gateway.setClock(() => T0);
    const capture = referenceCapture("movie");

    const [first, second] = await Promise.all([
      writeReferenceCapture(gateway, capture, null, T0),
      writeReferenceCapture(gateway, { ...capture, candidates: [] }, null, T0),
    ]);
    expect(first.capture_id).not.toBe(second.capture_id);
    expect(gateway.captures.size).toBe(2);
    const frozen = await readCapturesByIds(gateway, [first.capture_id!, second.capture_id!]);
    expect(frozen.map((row) => row.candidates.length)).toEqual([10, 0]);
    const newest = await gateway.findQlooCaptureByFingerprint(capture.request_fingerprint);
    // Identical retrieval times use the same deterministic UUID tie-break in both gateways.
    expect(newest?.id).toBe([first.capture_id!, second.capture_id!].sort().at(-1));
  });
});


it("refreshes first-hop evidence without changing frozen IDs and selects the newest stale fallback", async () => {
  const gateway = new MemoryGateway();
  gateway.setClock(() => T0);
  const capture = referenceCapture("movie");
  const old = await writeReferenceCapture(gateway, capture, null, T0);
  const oldRows = await gateway.findQlooCapturesByIds([old.capture_id!]);
  const now = at(CACHE_TTL_SECONDS.firstHop + 60);
  const fresh = await writeReferenceCapture(gateway, { ...capture, retrieved_at: now.toISOString() }, null, now);
  expect(fresh.capture_id).not.toBe(old.capture_id);
  expect(await gateway.findQlooCapturesByIds([old.capture_id!])).toEqual(oldRows);
  expect((await readReferenceCache(gateway, capture.request_fingerprint, now))?.capture_id).toBe(fresh.capture_id);
  expect((await readReferenceCaches(gateway, [capture.request_fingerprint], now)).get(capture.request_fingerprint)?.capture_id).toBe(fresh.capture_id);
  const stale = await readStaleReferenceFallback(gateway, {
    artistEntityId: RADIOHEAD_ENTITY_ID, domain: "movie", consented: true,
    now: new Date(now.getTime() + (CACHE_TTL_SECONDS.firstHop + 60) * 1000),
  });
  expect(stale?.capture.capture_id).toBe(fresh.capture_id);
  expect(stale?.capture.cache).toBe("stale");
});

it("selects the newest still-fresh row when a newer empty search has already expired", async () => {
  const gateway = new MemoryGateway();
  const snapshot = searchSnapshot();
  const old = await writeArtistSearchCapture(gateway, snapshot, null, T0);
  const empty = await writeArtistSearchCapture(gateway, { ...snapshot, candidates: [], retrieved_at: at(60).toISOString() }, null, at(60));
  expect((await gateway.findQlooCaptureByFingerprint(snapshot.request_fingerprint))?.id).toBe(empty.capture_id);
  expect((await readArtistSearchCache(gateway, snapshot.request_fingerprint, at(700)))?.capture_id).toBe(old.capture_id);
});
