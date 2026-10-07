/**
 * Normalization, fingerprints, and capture storage for the comp audition's two
 * Qloo operations:
 *
 * ```http
 * GET {base}/search?query=<encoded>&types=urn:entity:movie|urn:entity:videogame&take=5
 * GET {base}/v2/insights?filter.type=<domain type>&signal.interests.entities=<audience uuid>
 *     &filter.results.entities=<confirmed uuid,...>&take=<count>
 * ```
 *
 * The same disciplines as `normalize.ts`, applied to these shapes:
 *
 *   * **Identity is Qloo's.** A comp's name is the name Qloo returned. Nothing
 *     here can introduce a title no response contained.
 *   * **A contradicted type fails the capture.** A search row typed as
 *     something other than the requested domain, or an insights row whose
 *     `subtype` contradicts `filter.type`, means the request was not applied
 *     as sent. That is refused, not coerced.
 *   * **Exact candidate filtering is checked, not trusted.** HTTP 200 does not
 *     prove `filter.results.entities` was honoured, so a returned entity that
 *     was not requested fails the whole score capture. A requested entity
 *     that did not come back is recorded as missing and is never scored.
 *
 * Storage reuses `qloo_captures` without a migration. Search captures use the
 * `search` kind; score captures use the domain's kind with a null
 * `artist_entity_id`, so the earlier product's artist-and-domain stale lookup
 * can never surface one. Every audition payload carries a literal `kind`
 * field the earlier product's strict schemas reject, so a capture id cannot
 * smuggle one product's evidence into the other.
 */

import { sha256Hex } from "@/engine/hash";
import {
  AUDITION_NORMALIZER_VERSION,
  type CompCandidate,
  COMP_SEARCH_TAKE,
  type CompScore,
  type CompScoreCapture,
  CompScoreCaptureSchema,
  type CompSearchSnapshot,
  CompSearchSnapshotSchema,
  MAX_COMPS_PER_DOMAIN,
} from "@/domain/audition";
import {
  CAPTURE_KIND_BY_DOMAIN,
  isQlooUuid,
  QLOO_DOMAIN_FILTER_TYPE,
  type QlooDomain,
  type QuotaDiagnostics,
} from "@/domain/qloo";
import { z } from "zod";
import type { DataGateway } from "../db/gateway";
import { CACHE_TTL_SECONDS } from "./cache";
import { RawInsightsResponseSchema } from "./contracts";
import { normalizeQuery, QLOO_NORMALIZE_CODES, QlooNormalizeError } from "./normalize";

// ---------------------------------------------------------------------------
// Raw search shape for movies and videogames
// ---------------------------------------------------------------------------

const RawCompSearchEntitySchema = z.object({
  name: z.string().nullish(),
  entity_id: z.string().nullish(),
  types: z.array(z.string()).nullish(),
  disambiguation: z.string().nullish(),
  properties: z
    .object({
      release_year: z.number().nullish(),
      release_date: z.string().nullish(),
    })
    .nullish(),
});

const RawCompSearchResponseSchema = z.object({
  success: z.boolean().nullish(),
  results: z.array(RawCompSearchEntitySchema).nullish(),
});

type RawCompSearchEntity = z.infer<typeof RawCompSearchEntitySchema>;

function bounded(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function yearOf(entity: RawCompSearchEntity): number | null {
  const p = entity.properties ?? {};
  if (typeof p.release_year === "number" && Number.isInteger(p.release_year)) return p.release_year;
  if (typeof p.release_date === "string") {
    const match = /^(\d{4})/u.exec(p.release_date.trim());
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

export function compSearchFingerprint(input: {
  host: string;
  domain: QlooDomain;
  normalizedQuery: string;
}): string {
  const digest = sha256Hex(
    [
      "comp_search",
      input.host,
      QLOO_DOMAIN_FILTER_TYPE[input.domain],
      String(COMP_SEARCH_TAKE),
      input.normalizedQuery,
      AUDITION_NORMALIZER_VERSION,
    ].join("|"),
  );
  return `audition-search|${AUDITION_NORMALIZER_VERSION}|${digest}`;
}

/** The candidate set, canonicalised: validated, upper-cased, de-duplicated, sorted. */
export function canonicalCandidateIds(ids: readonly string[]): string[] {
  for (const id of ids) {
    if (!isQlooUuid(id)) {
      throw new QlooNormalizeError(
        QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
        "a candidate id is not a Qloo UUID",
      );
    }
  }
  const unique = [...new Set(ids.map((id) => id.toUpperCase()))].sort();
  if (unique.length === 0 || unique.length > MAX_COMPS_PER_DOMAIN) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      `a score request needs 1 to ${MAX_COMPS_PER_DOMAIN} candidates`,
    );
  }
  return unique;
}

export function compScoreFingerprint(input: {
  host: string;
  domain: QlooDomain;
  audienceEntityId: string;
  candidateIds: readonly string[];
}): string {
  const ids = canonicalCandidateIds(input.candidateIds);
  const digest = sha256Hex(
    [
      "comp_scores",
      input.host,
      QLOO_DOMAIN_FILTER_TYPE[input.domain],
      input.audienceEntityId.toUpperCase(),
      ids.join(","),
      String(ids.length),
      AUDITION_NORMALIZER_VERSION,
    ].join("|"),
  );
  return `audition-scores|${AUDITION_NORMALIZER_VERSION}|${digest}`;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

export function normalizeCompSearch(
  raw: unknown,
  input: { domain: QlooDomain; query: string; requestFingerprint: string; retrievedAt: string },
): Omit<CompSearchSnapshot, "capture_id" | "cache"> {
  const parsed = RawCompSearchResponseSchema.safeParse(raw);
  if (!parsed.success || !Array.isArray(parsed.data.results)) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the comp search envelope did not match the observed shape",
    );
  }
  if (parsed.data.success === false) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ERROR_SHAPED_SUCCESS,
      "the comp search reported failure inside an HTTP success",
    );
  }

  const expected = QLOO_DOMAIN_FILTER_TYPE[input.domain];
  const candidates: CompCandidate[] = [];
  const seen = new Set<string>();
  parsed.data.results.slice(0, COMP_SEARCH_TAKE).forEach((entity, index) => {
    const types = Array.isArray(entity.types) ? entity.types : [];
    if (types.length > 0 && !types.includes(expected)) {
      throw new QlooNormalizeError(
        QLOO_NORMALIZE_CODES.SEARCH_TYPE_MISMATCH,
        `a returned row declared ${types.join(",")} where ${expected} was requested`,
      );
    }
    const name = bounded(entity.name, 300);
    if (!isQlooUuid(entity.entity_id) || name === null || types.length === 0) return;
    const id = entity.entity_id.toUpperCase();
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push({
      entity_id: id,
      name,
      domain: input.domain,
      year: yearOf(entity),
      disambiguation: bounded(entity.disambiguation, 200),
      original_rank: index + 1,
    });
  });

  return {
    kind: "comp_search",
    domain: input.domain,
    query: input.query,
    normalized_query: normalizeQuery(input.query),
    request_fingerprint: input.requestFingerprint,
    normalizer_version: AUDITION_NORMALIZER_VERSION,
    retrieved_at: input.retrievedAt,
    candidates,
  };
}

export function normalizeCompScores(
  raw: unknown,
  input: {
    domain: QlooDomain;
    audienceEntityId: string;
    candidateIds: readonly string[];
    requestFingerprint: string;
    retrievedAt: string;
  },
): Omit<CompScoreCapture, "capture_id" | "cache"> {
  const requested = canonicalCandidateIds(input.candidateIds);
  const parsed = RawInsightsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the insights envelope did not match the observed shape",
    );
  }
  if (parsed.data.success === false) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ERROR_SHAPED_SUCCESS,
      "the insights response reported failure inside an HTTP success",
    );
  }
  const entities = parsed.data.results?.entities;
  if (!Array.isArray(entities)) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the insights response carried no results.entities array",
    );
  }

  const expected = QLOO_DOMAIN_FILTER_TYPE[input.domain];
  const wanted = new Set(requested);
  const scores: CompScore[] = [];
  const seen = new Set<string>();

  for (const entity of entities) {
    if (typeof entity.subtype === "string" && entity.subtype !== expected) {
      throw new QlooNormalizeError(
        QLOO_NORMALIZE_CODES.DOMAIN_MISMATCH,
        `a row returned ${entity.subtype} where ${expected} was requested`,
      );
    }
    if (!isQlooUuid(entity.entity_id)) {
      throw new QlooNormalizeError(
        QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
        "a scored row carried no Qloo entity id",
      );
    }
    const id = entity.entity_id.toUpperCase();
    if (!wanted.has(id)) {
      // The candidate filter was not applied as sent. Showing this row would
      // display a title the creator never confirmed.
      throw new QlooNormalizeError(
        QLOO_NORMALIZE_CODES.UNREQUESTED_ENTITY,
        "a returned entity was not among the requested candidates",
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const name = bounded(entity.name, 300);
    if (name === null) continue;
    const affinity = entity.query?.affinity;
    scores.push({
      entity_id: id,
      name,
      affinity: typeof affinity === "number" && Number.isFinite(affinity) ? affinity : null,
    });
  }

  return {
    kind: "comp_scores",
    domain: input.domain,
    audience_entity_id: input.audienceEntityId.toUpperCase(),
    requested_entity_ids: requested,
    request_fingerprint: input.requestFingerprint,
    normalizer_version: AUDITION_NORMALIZER_VERSION,
    retrieved_at: input.retrievedAt,
    scores,
    missing_entity_ids: requested.filter((id) => !scores.some((score) => score.entity_id === id)),
  };
}

// ---------------------------------------------------------------------------
// Capture storage
// ---------------------------------------------------------------------------

const StoredCompSearchSchema = CompSearchSnapshotSchema.omit({ capture_id: true, cache: true });
const StoredCompScoreSchema = CompScoreCaptureSchema.omit({ capture_id: true, cache: true });

function isFresh(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) > now.getTime();
}

function expiryFrom(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export async function readCompSearchCache(
  gateway: DataGateway,
  fingerprint: string,
  now: Date,
): Promise<CompSearchSnapshot | null> {
  const row = await gateway.findQlooCaptureByFingerprint(fingerprint, now.toISOString());
  if (row === null || row.kind !== "search" || !isFresh(row.cache_expires_at, now)) return null;
  const parsed = StoredCompSearchSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { ...parsed.data, capture_id: row.id, cache: "cached" };
}

/**
 * Reads a comp search by capture id, whatever its TTL. This is how a creator's
 * confirmation is re-checked: the confirmed id must be one of these
 * candidates, and the name shown is copied from here.
 */
export async function readCompSearchById(
  gateway: DataGateway,
  captureId: string,
): Promise<CompSearchSnapshot | null> {
  const [row] = await gateway.findQlooCapturesByIds([captureId]);
  if (row === undefined || row.kind !== "search") return null;
  const parsed = StoredCompSearchSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { ...parsed.data, capture_id: row.id, cache: "cached" };
}

export async function writeCompSearchCapture(
  gateway: DataGateway,
  snapshot: Omit<CompSearchSnapshot, "capture_id" | "cache">,
  quota: QuotaDiagnostics | null,
  now: Date,
): Promise<CompSearchSnapshot> {
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
    capturedAt: snapshot.retrieved_at,
    quotaDiagnostics: quota,
    normalizerVersion: snapshot.normalizer_version,
    cacheExpiresAt: expiryFrom(now, ttl),
  });
  return { ...snapshot, capture_id: row.id, cache: "live" };
}

export async function readCompScoreCache(
  gateway: DataGateway,
  fingerprint: string,
  now: Date,
): Promise<CompScoreCapture | null> {
  const row = await gateway.findQlooCaptureByFingerprint(fingerprint, now.toISOString());
  if (row === null || row.kind === "search" || !isFresh(row.cache_expires_at, now)) return null;
  const parsed = StoredCompScoreSchema.safeParse(row.results);
  if (!parsed.success) return null;
  return { ...parsed.data, capture_id: row.id, cache: "cached" };
}

export async function writeCompScoreCapture(
  gateway: DataGateway,
  capture: Omit<CompScoreCapture, "capture_id" | "cache">,
  quota: QuotaDiagnostics | null,
  now: Date,
): Promise<CompScoreCapture> {
  const row = await gateway.insertQlooCapture({
    kind: CAPTURE_KIND_BY_DOMAIN[capture.domain],
    requestFingerprint: capture.request_fingerprint,
    normalizedQuery: null,
    // Null on purpose: the audience id lives in the payload and the
    // fingerprint, and leaving it off the column keeps the earlier product's
    // artist-and-domain stale fallback from ever reading this row.
    artistEntityId: null,
    domain: capture.domain,
    results: capture,
    capturedAt: capture.retrieved_at,
    quotaDiagnostics: quota,
    normalizerVersion: capture.normalizer_version,
    cacheExpiresAt: expiryFrom(now, CACHE_TTL_SECONDS.firstHop),
  });
  return { ...capture, capture_id: row.id, cache: "live" };
}
