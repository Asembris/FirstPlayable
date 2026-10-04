/**
 * Normalization from real Qloo payloads to this application's evidence model
 * (specification section 6, "Normalization and usable evidence").
 *
 * Every field path below was read off a live capture on 4 October 2026, not
 * recalled from documentation. The mappings are:
 *
 * ```text
 * search    results[]                      -> candidates, in returned order
 *           results[].entity_id            -> ArtistCandidate.entity_id
 *           results[].name                 -> ArtistCandidate.name
 *           results[].types[]              -> must contain urn:entity:artist
 *           results[].properties.short_description -> short_description
 *           results[].disambiguation       -> disambiguation
 *           results[].properties.external  -> identity_hints (catalogue names only)
 *
 * insights  results.entities[]             -> candidates, rank = 1-based index
 *           results.entities[].entity_id   -> ReferenceCandidate.entity_id
 *           results.entities[].name        -> name
 *           results.entities[].subtype     -> must equal the requested filter.type
 *           results.entities[].query.affinity -> affinity (private)
 *           results.entities[].properties.*   -> evidence, by the tables below
 *           results.entities[].tags[]         -> evidence, selected tag types only
 * ```
 *
 * Three disciplines are enforced here rather than trusted:
 *
 *   1. **No enrichment.** An evidence item's text is a returned string, or a
 *      comma-joined list of returned list entries, and nothing else. A thin
 *      videogame stays thin. There is no code path in this module that can
 *      introduce a sentence no field contained.
 *   2. **Original rank survives filtering.** Rank is the position in the raw
 *      array. Dropping an unusable row leaves a gap, which the UI shows.
 *   3. **A contradicted domain fails the capture.** HTTP 200 does not prove
 *      `filter.type` was applied, so the returned `subtype` is checked against
 *      what was asked for, and a mismatch is a hard failure.
 */

import { sha256Hex } from "@/engine/hash";
import {
  ARTIST_SEARCH_TAKE,
  type ArtistCandidate,
  type ArtistSearchSnapshot,
  CAPTURE_KIND_BY_DOMAIN,
  EVIDENCE_CONTEXT_CHARS_PER_CANDIDATE,
  EVIDENCE_ITEM_MAX_CHARS,
  type EvidenceItem,
  type EvidenceKind,
  isQlooUuid,
  QLOO_ARTIST_TYPE,
  QLOO_DOMAIN_FILTER_TYPE,
  QLOO_NORMALIZER_VERSION,
  type QlooDomain,
  type ReferenceCandidate,
  type ReferenceCapture,
  REFERENCES_TAKE,
} from "@/domain/qloo";
import {
  INSIGHTS_ECHO_AVAILABLE,
  type RawInsightEntity,
  RawInsightsResponseSchema,
  type RawSearchEntity,
  RawSearchResponseSchema,
  type RawTag,
} from "./contracts";

/** Stable codes for every way normalization can refuse a payload. */
export const QLOO_NORMALIZE_CODES = {
  /** The envelope did not match either observed shape. */
  ENVELOPE_UNEXPECTED: "QLOO_ENVELOPE_UNEXPECTED",
  /** An HTTP 200 whose body reported failure. */
  ERROR_SHAPED_SUCCESS: "QLOO_ERROR_SHAPED_SUCCESS",
  /** A returned subtype contradicted the requested domain. */
  DOMAIN_MISMATCH: "QLOO_DOMAIN_MISMATCH",
  /** A returned entity type contradicted the requested search type. */
  SEARCH_TYPE_MISMATCH: "QLOO_SEARCH_TYPE_MISMATCH",
} as const;

export type QlooNormalizeCode =
  (typeof QLOO_NORMALIZE_CODES)[keyof typeof QLOO_NORMALIZE_CODES];

export class QlooNormalizeError extends Error {
  readonly code: QlooNormalizeCode;

  constructor(code: QlooNormalizeCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "QlooNormalizeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Keys and fingerprints
// ---------------------------------------------------------------------------

/**
 * The key-forming form of a creator's query: Unicode-normalized, trimmed,
 * internal whitespace collapsed, case-folded. "  RadioHead " and "radiohead"
 * therefore share one cache entry and cannot cost two upstream calls.
 */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * The artist-search cache key: normalized query, the artist type, and the
 * normalizer version (specification section 6). The host is included so a
 * configured base-URL change cannot serve a capture from another host.
 */
export function artistSearchFingerprint(input: {
  host: string;
  normalizedQuery: string;
  take?: number;
}): string {
  const digest = sha256Hex(
    [
      "search",
      input.host,
      QLOO_ARTIST_TYPE,
      String(input.take ?? ARTIST_SEARCH_TAKE),
      input.normalizedQuery,
      QLOO_NORMALIZER_VERSION,
    ].join("|"),
  );
  return `search|${QLOO_NORMALIZER_VERSION}|${digest}`;
}

/**
 * The first-hop cache key: host, confirmed artist UUID, output domain, the
 * exact frozen parameters, and the normalizer version.
 */
export function referenceFingerprint(input: {
  host: string;
  artistEntityId: string;
  domain: QlooDomain;
  take?: number;
}): string {
  const digest = sha256Hex(
    [
      "insights",
      input.host,
      QLOO_DOMAIN_FILTER_TYPE[input.domain],
      input.artistEntityId.toUpperCase(),
      String(input.take ?? REFERENCES_TAKE),
      QLOO_NORMALIZER_VERSION,
    ].join("|"),
  );
  return `${CAPTURE_KIND_BY_DOMAIN[input.domain]}|${QLOO_NORMALIZER_VERSION}|${digest}`;
}

/** The stable application address for one reference. Not a Qloo UUID. */
export function referenceIdFor(domain: QlooDomain, entityId: string): string {
  const prefix = domain === "movie" ? "mv" : "vg";
  const digest = sha256Hex(`${domain}|${entityId.toUpperCase()}`).slice(0, 16);
  return `ref.${prefix}.${digest}`;
}

// ---------------------------------------------------------------------------
// Artist search
// ---------------------------------------------------------------------------

/** Catalogue names only. No listener count, follower count, or popularity. */
function identityHints(external: unknown): string[] {
  if (typeof external !== "object" || external === null) return [];
  const names: string[] = [];
  for (const [source, value] of Object.entries(external as Record<string, unknown>)) {
    if (source.length === 0 || source.length > 40) continue;
    const linked = Array.isArray(value)
      ? value.length > 0
      : typeof value === "object" && value !== null && Object.keys(value).length > 0;
    if (linked) names.push(source);
  }
  return names.sort().slice(0, 12);
}

function bounded(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export type NormalizeSearchInput = {
  query: string;
  normalizedQuery: string;
  requestFingerprint: string;
  retrievedAt: string;
};

/**
 * Normalizes one `/search` response.
 *
 * A row is kept only when it carries a well-formed entity UUID, a nonempty
 * name, and `urn:entity:artist` among its `types`. A row whose types
 * contradict the requested search type fails the whole response: that is the
 * search-side counterpart of the domain check, and it is the only honest
 * reading of a payload that answered a question nobody asked.
 */
export function normalizeArtistSearch(
  raw: unknown,
  input: NormalizeSearchInput,
): Omit<ArtistSearchSnapshot, "capture_id" | "cache"> {
  const parsed = RawSearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the search envelope did not match the observed shape",
    );
  }
  const body = parsed.data;
  if (body.success === false) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ERROR_SHAPED_SUCCESS,
      "the search response reported failure inside an HTTP success",
    );
  }
  if (!Array.isArray(body.results)) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the search response carried no results array",
    );
  }

  const candidates: ArtistCandidate[] = [];
  body.results.slice(0, ARTIST_SEARCH_TAKE).forEach((entity, index) => {
    const candidate = normalizeArtistCandidate(entity, index + 1);
    if (candidate !== null) candidates.push(candidate);
  });

  return {
    query: input.query,
    normalized_query: input.normalizedQuery,
    request_fingerprint: input.requestFingerprint,
    normalizer_version: QLOO_NORMALIZER_VERSION,
    retrieved_at: input.retrievedAt,
    candidates,
  };
}

function normalizeArtistCandidate(
  entity: RawSearchEntity,
  rank: number,
): ArtistCandidate | null {
  const entityId = entity.entity_id;
  const name = bounded(entity.name, 200);
  if (!isQlooUuid(entityId) || name === null) return null;

  const types = Array.isArray(entity.types) ? entity.types : [];
  if (types.length > 0 && !types.includes(QLOO_ARTIST_TYPE)) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.SEARCH_TYPE_MISMATCH,
      `a returned row declared ${types.join(",")} where ${QLOO_ARTIST_TYPE} was requested`,
    );
  }
  if (types.length === 0) return null;

  return {
    entity_id: entityId.toUpperCase(),
    name,
    short_description: bounded(entity.properties?.short_description, 600),
    disambiguation: bounded(entity.disambiguation, 200),
    identity_hints: identityHints(entity.properties?.external),
    original_rank: rank,
  };
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

type Extracted = { path: string; kind: EvidenceKind; text: string };

/** The one place a list of returned strings becomes one evidence string. */
function joinList(values: unknown, limit: number): string | null {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, limit);
  return items.length === 0 ? null : items.join(", ");
}

function englishShortDescription(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const entry of values) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { value?: unknown; languages?: unknown };
    const languages = Array.isArray(row.languages) ? row.languages : [];
    if (!languages.includes("en")) continue;
    if (typeof row.value === "string" && row.value.trim().length > 0) return row.value.trim();
  }
  return null;
}

/** Tag names of one namespaced tag type, for example `urn:tag:theme:qloo`. */
function tagNames(tags: readonly RawTag[] | null | undefined, type: string, limit: number): string | null {
  if (!Array.isArray(tags)) return null;
  const names = tags
    .filter((tag) => tag.type === type)
    .map((tag) => (typeof tag.name === "string" ? tag.name.trim() : ""))
    .filter((name) => name.length > 0)
    .slice(0, limit);
  return names.length === 0 ? null : names.join(", ");
}

/**
 * The movie evidence table, in priority order.
 *
 * Priority decides what survives the per-candidate character budget. The
 * concise interpretive fields come first on purpose: `properties.description`
 * is a 600–700 character marketing-style paragraph in the live payload and
 * would otherwise swallow the budget on its own, leaving theme, tone, and
 * style unrepresented. A card's one context sentence is still drawn from the
 * plot or theme item, so nothing is lost by demoting it.
 */
function movieEvidence(entity: RawInsightEntity): { items: Extracted[]; missing: string[] } {
  const p = entity.properties ?? {};
  const sources: readonly (readonly [string, EvidenceKind, string | null])[] = [
    ["properties.plot_summary", "plot", bounded(p.plot_summary, 4000)],
    ["properties.plot_themes_description", "theme", bounded(p.plot_themes_description, 4000)],
    ["properties.emotional_tone_description", "tone", bounded(p.emotional_tone_description, 4000)],
    ["properties.style_description", "style", bounded(p.style_description, 4000)],
    ["properties.keywords", "keywords", joinList(p.keywords, 12)],
    ["properties.genre_description", "genre", bounded(p.genre_description, 4000)],
    ["properties.description", "description", bounded(p.description, 4000)],
    ["properties.short_descriptions[en].value", "description", englishShortDescription(p.short_descriptions)],
    ["properties.genres", "genre", joinList(p.genres, 8)],
    ["tags[urn:tag:theme:qloo].name", "tags", tagNames(entity.tags, "urn:tag:theme:qloo", 10)],
  ];
  return partition(sources);
}

/**
 * The videogame evidence table, in priority order.
 *
 * Deliberately shorter and deliberately tag-heavy: the live payload simply
 * carries less prose for a game, and specification section 6 forbids covering
 * that gap with a model-written summary.
 */
function videogameEvidence(entity: RawInsightEntity): { items: Extracted[]; missing: string[] } {
  const p = entity.properties ?? {};
  const sources: readonly (readonly [string, EvidenceKind, string | null])[] = [
    ["properties.description", "description", bounded(p.description, 4000)],
    ["properties.short_descriptions[en].value", "description", englishShortDescription(p.short_descriptions)],
    ["properties.emotional_tone", "tone", joinList(p.emotional_tone, 8)],
    ["properties.audience_tags", "tags", joinList(p.audience_tags, 8)],
    ["properties.gameplay_type", "tags", joinList(p.gameplay_type, 8)],
    ["properties.steam_tags", "tags", joinList(p.steam_tags, 8)],
    ["properties.genre", "genre", joinList(p.genre, 8)],
    ["properties.art_style", "style", joinList(p.art_style, 6)],
    ["tags[urn:tag:emotional_tone:qloo].name", "tags", tagNames(entity.tags, "urn:tag:emotional_tone:qloo", 8)],
    ["tags[urn:tag:genre:qloo].name", "tags", tagNames(entity.tags, "urn:tag:genre:qloo", 8)],
  ];
  return partition(sources);
}

function partition(
  sources: readonly (readonly [string, EvidenceKind, string | null])[],
): { items: Extracted[]; missing: string[] } {
  const items: Extracted[] = [];
  const missing: string[] = [];
  for (const [path, kind, text] of sources) {
    if (text === null) missing.push(path);
    else items.push({ path, kind, text });
  }
  return { items, missing };
}

/**
 * Turns extracted strings into bounded, hashed, identified evidence items.
 *
 * The hash is taken over the **full** original text, before bounding, so a
 * later check can tell whether the stored excerpt corresponds to what was
 * returned. Items are admitted in priority order until the per-candidate
 * character budget is spent; a partially admitted item is marked truncated.
 */
function toEvidenceItems(referenceId: string, extracted: readonly Extracted[]): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let spent = 0;
  let index = 0;
  for (const source of extracted) {
    const remaining = EVIDENCE_CONTEXT_CHARS_PER_CANDIDATE - spent;
    if (remaining <= 80) break;
    const allowed = Math.min(EVIDENCE_ITEM_MAX_CHARS, remaining);
    const truncated = source.text.length > allowed;
    const text = truncated ? `${source.text.slice(0, allowed - 1).trimEnd()}…` : source.text;
    index += 1;
    items.push({
      id: `${referenceId}#ev${index}`,
      field_path: source.path,
      kind: source.kind,
      text,
      hash: sha256Hex(source.text),
      truncated,
    });
    spent += text.length;
    if (items.length >= 12) break;
  }
  return items;
}

function yearFrom(entity: RawInsightEntity): number | null {
  const p = entity.properties ?? {};
  if (typeof p.release_year === "number" && Number.isInteger(p.release_year)) {
    return p.release_year;
  }
  if (typeof p.release_date === "string") {
    const match = /^(\d{4})/u.exec(p.release_date.trim());
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// First-hop references
// ---------------------------------------------------------------------------

export type NormalizeReferencesInput = {
  domain: QlooDomain;
  artistEntityId: string;
  requestFingerprint: string;
  retrievedAt: string;
};

/**
 * Normalizes one `/v2/insights` response for one domain.
 *
 * Fails the whole capture on an unexpected envelope, on an error-shaped HTTP
 * 200, and on any row whose `subtype` contradicts the requested `filter.type`.
 * Drops, and counts, rows with a malformed required identity and rows whose
 * entity id was already seen.
 */
export function normalizeReferences(
  raw: unknown,
  input: NormalizeReferencesInput,
): Omit<ReferenceCapture, "capture_id" | "cache"> {
  const parsed = RawInsightsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the insights envelope did not match the observed shape",
    );
  }
  const body = parsed.data;
  if (body.success === false) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ERROR_SHAPED_SUCCESS,
      "the insights response reported failure inside an HTTP success",
    );
  }
  const entities = body.results?.entities;
  if (!Array.isArray(entities)) {
    throw new QlooNormalizeError(
      QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED,
      "the insights response carried no results.entities array",
    );
  }

  const expectedSubtype = QLOO_DOMAIN_FILTER_TYPE[input.domain];
  const candidates: ReferenceCandidate[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let malformed = 0;

  entities.slice(0, REFERENCES_TAKE).forEach((entity, index) => {
    const rank = index + 1;

    // The silent-parameter defense: the subtype that came back is checked
    // against the filter that went out, before anything else is read.
    if (typeof entity.subtype === "string" && entity.subtype !== expectedSubtype) {
      throw new QlooNormalizeError(
        QLOO_NORMALIZE_CODES.DOMAIN_MISMATCH,
        `rank ${rank} returned ${entity.subtype} where ${expectedSubtype} was requested`,
      );
    }

    const entityId = entity.entity_id;
    const name = bounded(entity.name, 300);
    if (!isQlooUuid(entityId) || name === null || typeof entity.subtype !== "string") {
      malformed += 1;
      return;
    }

    const upper = entityId.toUpperCase();
    if (seen.has(upper)) {
      duplicates += 1;
      return;
    }
    seen.add(upper);

    const referenceId = referenceIdFor(input.domain, upper);
    const { items, missing } = input.domain === "movie"
      ? movieEvidence(entity)
      : videogameEvidence(entity);
    const evidence = toEvidenceItems(referenceId, items);

    candidates.push({
      reference_id: referenceId,
      entity_id: upper,
      name,
      domain: input.domain,
      original_rank: rank,
      year: yearFrom(entity),
      disambiguation: bounded(entity.disambiguation, 200),
      evidence,
      missing_fields: missing.slice(0, 24),
      usable: evidence.length > 0,
      unusable_reason: evidence.length > 0 ? null : "no_usable_context",
      affinity: typeof entity.query?.affinity === "number" ? entity.query.affinity : null,
    });
  });

  return {
    kind: CAPTURE_KIND_BY_DOMAIN[input.domain],
    domain: input.domain,
    artist_entity_id: input.artistEntityId.toUpperCase(),
    request_fingerprint: input.requestFingerprint,
    normalizer_version: QLOO_NORMALIZER_VERSION,
    retrieved_at: input.retrievedAt,
    candidates,
    echo_available: INSIGHTS_ECHO_AVAILABLE,
    duplicates_dropped: duplicates,
    malformed_rows: malformed,
  };
}
