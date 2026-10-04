/**
 * Qloo capture persistence and the cache policy
 * (specification section 6, "Timeouts, retries, caching, and quota").
 *
 * The rules, and what each one is protecting:
 *
 *   * **Artist search: 24 hours. An empty artist search: 10 minutes.** A
 *     misspelling should not be remembered for a day, and a newly indexed
 *     artist should become findable quickly.
 *   * **First-hop references: 7 days.** The expensive calls, and the stable
 *     ones.
 *   * **A lookup TTL is not a retention policy.** `readCapturesByIds` reads a
 *     capture a frozen decision points at *regardless* of its cache expiry, so
 *     expiring a lookup never deletes the evidence an approval cites.
 *   * **A stale capture is never relabelled as live.** A capture past its TTL
 *     can be used only for the exact same artist and domain, only inside 30
 *     days, and only when the caller passes explicit creator consent. It comes
 *     back marked `stale` with its capture date, which the UI shows.
 *   * **Another artist is never substituted.** Every read is keyed by a
 *     fingerprint that contains the artist UUID and the domain, and the stale
 *     path additionally re-checks both against the row.
 *
 * A cache hit makes zero upstream calls. That is a property of this module:
 * the retrieval functions in `references.ts` call the client only after a read
 * here has returned nothing usable.
 */

import {
  ArtistSearchSnapshotSchema,
  type ArtistSearchSnapshot,
  type QlooDomain,
  type QuotaDiagnostics,
  ReferenceCaptureSchema,
  type ReferenceCapture,
} from "@/domain/qloo";
import type { DataGateway, QlooCaptureRow } from "../db/gateway";

/** Specification section 6, exactly. */
export const CACHE_TTL_SECONDS = {
  artistSearch: 24 * 60 * 60,
  emptyArtistSearch: 10 * 60,
  firstHop: 7 * 24 * 60 * 60,
} as const;

/** A stale capture may be offered, with consent, up to 30 days old. */
export const STALE_FALLBACK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** The persisted form of each capture kind: the normalized payload, no more. */
const StoredSearchSchema = ArtistSearchSnapshotSchema.omit({
  capture_id: true,
  cache: true,
});

const StoredReferenceSchema = ReferenceCaptureSchema.omit({
  capture_id: true,
  cache: true,
});

function expiryFrom(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function isFresh(row: QlooCaptureRow, now: Date): boolean {
  return Date.parse(row.cache_expires_at) > now.getTime();
}

function ageSeconds(row: QlooCaptureRow, now: Date): number {
  return (now.getTime() - Date.parse(row.captured_at)) / 1000;
}

// ---------------------------------------------------------------------------
// Artist search
// ---------------------------------------------------------------------------

/**
 * A fresh cached artist search, or null.
 *
 * A row whose stored payload no longer satisfies the contract is treated as a
 * miss rather than as an error: the normalizer version is part of the
 * fingerprint, so this should not happen, and refetching is the safe answer
 * if it ever does. It is never returned as a degraded hit.
 */
export async function readArtistSearchCache(
  gateway: DataGateway,
  fingerprint: string,
  now: Date,
): Promise<ArtistSearchSnapshot | null> {
  const row = await gateway.findQlooCaptureByFingerprint(fingerprint);
  if (row === null || row.kind !== "search" || !isFresh(row, now)) return null;
  const parsed = StoredSearchSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { ...parsed.data, capture_id: row.id, cache: "cached" };
}

export async function writeArtistSearchCapture(
  gateway: DataGateway,
  snapshot: Omit<ArtistSearchSnapshot, "capture_id" | "cache">,
  quota: QuotaDiagnostics | null,
  now: Date,
): Promise<ArtistSearchSnapshot> {
  // An empty result gets the short TTL, so a typo is not remembered for a day.
  const ttl =
    snapshot.candidates.length === 0
      ? CACHE_TTL_SECONDS.emptyArtistSearch
      : CACHE_TTL_SECONDS.artistSearch;

  const row = await gateway.insertQlooCapture({
    kind: "search",
    requestFingerprint: snapshot.request_fingerprint,
    normalizedQuery: snapshot.normalized_query,
    artistEntityId: null,
    domain: null,
    results: snapshot,
    quotaDiagnostics: quota,
    normalizerVersion: snapshot.normalizer_version,
    cacheExpiresAt: expiryFrom(now, ttl),
  });
  return { ...snapshot, capture_id: row.id, cache: "live" };
}

/**
 * Reads one capture by id and returns the artist search it holds, whatever its
 * TTL. Used to re-check that a confirmed anchor really came from a snapshot
 * this application retrieved, which is what makes "the creator chose rank 2 of
 * 5 from this capture" verifiable rather than asserted.
 */
export async function readArtistSearchById(
  gateway: DataGateway,
  captureId: string,
): Promise<ArtistSearchSnapshot | null> {
  const [row] = await gateway.findQlooCapturesByIds([captureId]);
  if (row === undefined || row.kind !== "search") return null;
  const parsed = StoredSearchSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { ...parsed.data, capture_id: row.id, cache: "cached" };
}

// ---------------------------------------------------------------------------
// First-hop references
// ---------------------------------------------------------------------------

function toReferenceCapture(
  row: QlooCaptureRow,
  cache: ReferenceCapture["cache"],
): ReferenceCapture | null {
  if (row.kind !== "movies" && row.kind !== "videogames") return null;
  const parsed = StoredReferenceSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { ...parsed.data, capture_id: row.id, cache };
}

/** A fresh cached first hop, or null. A hit here costs zero upstream calls. */
export async function readReferenceCache(
  gateway: DataGateway,
  fingerprint: string,
  now: Date,
): Promise<ReferenceCapture | null> {
  const row = await gateway.findQlooCaptureByFingerprint(fingerprint);
  if (row === null || !isFresh(row, now)) return null;
  return toReferenceCapture(row, "cached");
}

/** Both first hops in one round trip, for the parallel retrieval path. */
export async function readReferenceCaches(
  gateway: DataGateway,
  fingerprints: readonly string[],
  now: Date,
): Promise<Map<string, ReferenceCapture>> {
  const rows = await gateway.findQlooCapturesByFingerprints(fingerprints);
  const hits = new Map<string, ReferenceCapture>();
  for (const row of rows) {
    if (!isFresh(row, now)) continue;
    const capture = toReferenceCapture(row, "cached");
    if (capture !== null) hits.set(row.request_fingerprint, capture);
  }
  return hits;
}

export async function writeReferenceCapture(
  gateway: DataGateway,
  capture: Omit<ReferenceCapture, "capture_id" | "cache">,
  quota: QuotaDiagnostics | null,
  now: Date,
): Promise<ReferenceCapture> {
  const row = await gateway.insertQlooCapture({
    kind: capture.kind,
    requestFingerprint: capture.request_fingerprint,
    normalizedQuery: null,
    artistEntityId: capture.artist_entity_id,
    domain: capture.domain,
    results: capture,
    quotaDiagnostics: quota,
    normalizerVersion: capture.normalizer_version,
    cacheExpiresAt: expiryFrom(now, CACHE_TTL_SECONDS.firstHop),
  });
  return { ...capture, capture_id: row.id, cache: "live" };
}

export type StaleFallback = {
  capture: ReferenceCapture;
  /** How old the capture is, so the label can state the date honestly. */
  age_seconds: number;
};

/**
 * The explicit stale fallback.
 *
 * Four conditions, all required: the row must be for this exact artist, for
 * this exact domain, no older than 30 days, and the caller must have passed
 * the creator's explicit consent. The result is labelled `stale`, never
 * `live`, and the capture date travels with it.
 *
 * `consented: false` returns null rather than the capture, so a caller cannot
 * forget to check a flag on a value it has already been handed.
 */
export async function readStaleReferenceFallback(
  gateway: DataGateway,
  input: {
    artistEntityId: string;
    domain: QlooDomain;
    consented: boolean;
    now: Date;
  },
): Promise<StaleFallback | null> {
  if (!input.consented) return null;
  const row = await gateway.findLatestQlooCapture(
    input.artistEntityId.toUpperCase(),
    input.domain,
  );
  if (row === null) return null;

  // Re-checked on the row itself, not inferred from the query that found it.
  if (row.artist_entity_id?.toUpperCase() !== input.artistEntityId.toUpperCase()) return null;
  if (row.domain !== input.domain) return null;

  const age = ageSeconds(row, input.now);
  if (age > STALE_FALLBACK_MAX_AGE_SECONDS) return null;

  const capture = toReferenceCapture(row, "stale");
  if (capture === null) return null;
  if (capture.artist_entity_id.toUpperCase() !== input.artistEntityId.toUpperCase()) return null;
  if (capture.domain !== input.domain) return null;

  return { capture, age_seconds: age };
}

/**
 * Reads the captures a frozen decision points at, ignoring cache expiry
 * entirely. This is the retention rule of specification section 11: a lookup
 * TTL is not deletion of evidence linked to a decision.
 */
export async function readCapturesByIds(
  gateway: DataGateway,
  ids: readonly string[],
): Promise<ReferenceCapture[]> {
  const rows = await gateway.findQlooCapturesByIds(ids);
  const captures: ReferenceCapture[] = [];
  for (const row of rows) {
    const capture = toReferenceCapture(row, "cached");
    if (capture !== null) captures.push(capture);
  }
  // Returned in the order the caller asked for, so a movie row and a game row
  // keep their intended positions in the studio.
  const byId = new Map(captures.map((capture) => [capture.capture_id, capture]));
  return ids
    .map((id) => byId.get(id))
    .filter((capture): capture is ReferenceCapture => capture !== undefined);
}
