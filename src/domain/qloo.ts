/**
 * Qloo contracts shared by the server and the browser (specification section 6).
 *
 * These describe *normalized* retrieval evidence, not upstream JSON. The raw
 * upstream shapes live in `src/server/qloo/contracts.ts` and never leave the
 * server; this module is what a route returns and what a React component
 * renders.
 *
 * Three rules shape every type here:
 *
 *   1. **Identity is Qloo's; reference ids are ours.** `entity_id` is the real
 *      Qloo UUID. `reference_id` is an application address assigned by this
 *      application, so a model or a browser cannot smuggle a forged UUID in
 *      through a field the compiler trusts (specification section 4).
 *   2. **Every piece of context names where it came from.** An
 *      {@link EvidenceItem} carries the observed field path and a hash of the
 *      original returned text. Nothing in this module can hold a sentence a
 *      model wrote about a reference.
 *   3. **Affinity is private diagnostic information.** It is normalized and
 *      persisted because it was returned, and it is stripped from every public
 *      view, because it is not creative confidence and not an endorsement.
 */

import { z } from "zod";

/**
 * The normalizer's own version. It is part of every cache key, so a change to
 * the extraction rules below cannot be served out of a capture that predates
 * it (specification section 6, "Timeouts, retries, caching, and quota").
 */
export const QLOO_NORMALIZER_VERSION = "qloo-norm-1";

/** The one search entity type this application asks for. */
export const QLOO_ARTIST_TYPE = "urn:entity:artist";

/**
 * The two output domains, and the exact `filter.type` each one sends.
 *
 * `urn:entity:videogame` is the type verified against the live API on
 * 4 October 2026. `urn:entity:video_game` is **not** the working value and is
 * not accepted anywhere in this application.
 */
export const QLOO_DOMAINS = ["movie", "videogame"] as const;
export const QlooDomainSchema = z.enum(QLOO_DOMAINS);
export type QlooDomain = z.infer<typeof QlooDomainSchema>;

export const QLOO_DOMAIN_FILTER_TYPE = {
  movie: "urn:entity:movie",
  videogame: "urn:entity:videogame",
} as const satisfies Record<QlooDomain, string>;

/** The capture kinds the phase 2 schema's check constraint already knows. */
export const QLOO_CAPTURE_KINDS = ["search", "movies", "videogames"] as const;
export const QlooCaptureKindSchema = z.enum(QLOO_CAPTURE_KINDS);
export type QlooCaptureKind = z.infer<typeof QlooCaptureKindSchema>;

export const CAPTURE_KIND_BY_DOMAIN = {
  movie: "movies",
  videogame: "videogames",
} as const satisfies Record<QlooDomain, QlooCaptureKind>;

/**
 * A Qloo entity UUID exactly as the API returns it: canonical hyphenated form,
 * upper case in every observed payload. Matching is case-insensitive and the
 * normalizer upper-cases, so one artist cannot produce two cache keys.
 */
const UUID_SHAPE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export const QlooUuidSchema = z
  .string()
  .refine((value) => UUID_SHAPE.test(value), { message: "must be a Qloo entity UUID" })
  .transform((value) => value.toUpperCase());

export type QlooUuid = z.infer<typeof QlooUuidSchema>;

export function isQlooUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

/** How a lookup was answered. A stale capture is never relabelled as live. */
export const CACHE_STATUSES = ["live", "cached", "stale"] as const;
export const CacheStatusSchema = z.enum(CACHE_STATUSES);
export type CacheStatus = z.infer<typeof CacheStatusSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Which kind of returned field this text came out of. It labels provenance,
 * not quality, and it orders evidence when a candidate has to be trimmed to
 * the per-candidate context cap.
 */
export const EVIDENCE_KINDS = [
  "description",
  "plot",
  "theme",
  "tone",
  "style",
  "genre",
  "keywords",
  "tags",
] as const;

export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** Specification section 6: approximately 1,200 characters per candidate. */
export const EVIDENCE_CONTEXT_CHARS_PER_CANDIDATE = 1_200;

/** One evidence item is itself bounded, so a single long field cannot fill the budget. */
export const EVIDENCE_ITEM_MAX_CHARS = 700;

/** Specification section 6: up to six eligible candidates enter proposal context. */
export const MAX_PROPOSAL_CANDIDATES = 6;

/** Specification section 1: retrieve ten per domain, display the first three usable. */
export const REFERENCES_TAKE = 10;
export const ARTIST_SEARCH_TAKE = 5;
export const DISPLAYED_USABLE_PER_DOMAIN = 3;

export const EvidenceItemSchema = z.strictObject({
  /** Deterministic application id, unique inside its reference. */
  id: z.string().min(1).max(64),
  /** The observed upstream field path, for example `properties.plot_summary`. */
  field_path: z.string().min(1).max(120),
  kind: EvidenceKindSchema,
  /** Bounded original returned text. Never a model's paraphrase. */
  text: z.string().min(1).max(EVIDENCE_ITEM_MAX_CHARS),
  /** SHA-256 of the full original text, taken before any bounding. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** True when {@link text} is shorter than what the hash was taken over. */
  truncated: z.boolean(),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// ---------------------------------------------------------------------------
// Artist search
// ---------------------------------------------------------------------------

/**
 * One returned artist, with enough context to disambiguate and nothing more.
 *
 * `identity_hints` names the external catalogues the row was linked to, which
 * is disambiguation. Listener counts, follower counts, and the returned
 * popularity score are deliberately dropped: they would read as taste
 * inference rather than identity.
 */
export const ArtistCandidateSchema = z.strictObject({
  entity_id: QlooUuidSchema,
  name: z.string().min(1).max(200),
  short_description: z.string().max(600).nullable(),
  disambiguation: z.string().max(200).nullable(),
  identity_hints: z.array(z.string().min(1).max(40)).max(12),
  /** 1-based position in the returned list. Order is preserved, never re-sorted. */
  original_rank: z.number().int().positive(),
});

export type ArtistCandidate = z.infer<typeof ArtistCandidateSchema>;

export const ArtistSearchSnapshotSchema = z.strictObject({
  capture_id: z.uuid().nullable(),
  /** Exactly what the creator typed. */
  query: z.string().min(1).max(80),
  /** The key-forming form: trimmed, whitespace-collapsed, case-folded. */
  normalized_query: z.string().min(1).max(80),
  request_fingerprint: z.string().min(1).max(200),
  normalizer_version: z.string().min(1).max(40),
  retrieved_at: z.string(),
  cache: CacheStatusSchema,
  candidates: z.array(ArtistCandidateSchema).max(ARTIST_SEARCH_TAKE),
});

export type ArtistSearchSnapshot = z.infer<typeof ArtistSearchSnapshotSchema>;

/**
 * The anchor the creator explicitly confirmed, frozen onto the project.
 *
 * It records which search snapshot it was chosen from and at which rank, so
 * "the creator picked result 2 of 5 from this capture" stays checkable. No
 * field here was derived from a model or from the typed query alone.
 */
export const ConfirmedAnchorSchema = z.strictObject({
  entity_id: QlooUuidSchema,
  name: z.string().min(1).max(200),
  short_description: z.string().max(600).nullable(),
  disambiguation: z.string().max(200).nullable(),
  identity_hints: z.array(z.string().min(1).max(40)).max(12),
  query: z.string().min(1).max(80),
  normalized_query: z.string().min(1).max(80),
  search_capture_id: z.uuid().nullable(),
  search_request_fingerprint: z.string().min(1).max(200),
  original_rank: z.number().int().positive(),
  normalizer_version: z.string().min(1).max(40),
  confirmed_at: z.string(),
});

export type ConfirmedAnchor = z.infer<typeof ConfirmedAnchorSchema>;

// ---------------------------------------------------------------------------
// First-hop references
// ---------------------------------------------------------------------------

/**
 * Why a returned row cannot drive an approval, while still being shown.
 *
 * There is exactly one such state: identity arrived but no usable descriptive
 * field or interpretable tag group did. The other failure modes are not
 * candidate flags, because they are not displayable rows:
 *
 *   * a row whose required identity is malformed is dropped and counted in
 *     `malformed_rows`, never coerced into a candidate;
 *   * a duplicate entity id is dropped and counted in `duplicates_dropped`;
 *   * a returned subtype that contradicts the requested domain fails the whole
 *     capture, because that is the silent-parameter signal
 *     (specification section 6, "Identity and silent-failure defense").
 */
export const UNUSABLE_REASONS = ["no_usable_context"] as const;

export const UnusableReasonSchema = z.enum(UNUSABLE_REASONS);
export type UnusableReason = z.infer<typeof UnusableReasonSchema>;

export const ReferenceCandidateSchema = z.strictObject({
  /** Application address. Deterministic per capture, never a Qloo UUID. */
  reference_id: z.string().min(1).max(64),
  entity_id: QlooUuidSchema,
  name: z.string().min(1).max(300),
  domain: QlooDomainSchema,
  /** 1-based position in the raw response. Gaps from unusable rows are kept. */
  original_rank: z.number().int().positive(),
  /** Null is legitimate, especially for a videogame. Never invented. */
  year: z.number().int().nullable(),
  disambiguation: z.string().max(200).nullable(),
  evidence: z.array(EvidenceItemSchema).max(12),
  /** Named expected fields the payload did not carry. Diagnostic, not a defect. */
  missing_fields: z.array(z.string().min(1).max(120)).max(24),
  usable: z.boolean(),
  unusable_reason: UnusableReasonSchema.nullable(),
  /**
   * Returned affinity, persisted because it was returned. Private: every
   * public projection in this application drops it, and it never enters a
   * model payload or a user-visible label.
   */
  affinity: z.number().nullable(),
});

export type ReferenceCandidate = z.infer<typeof ReferenceCandidateSchema>;

/** Quota figures the API actually returned. Absent headers stay absent. */
export const QuotaDiagnosticsSchema = z.strictObject({
  month_limit: z.number().int().nullable(),
  month_remaining: z.number().int().nullable(),
  month_reset_seconds: z.number().nullable(),
  second_limit: z.number().int().nullable(),
  observed_at: z.string(),
});

export type QuotaDiagnostics = z.infer<typeof QuotaDiagnosticsSchema>;

export const ReferenceCaptureSchema = z.strictObject({
  capture_id: z.uuid().nullable(),
  kind: QlooCaptureKindSchema,
  domain: QlooDomainSchema,
  artist_entity_id: QlooUuidSchema,
  request_fingerprint: z.string().min(1).max(200),
  normalizer_version: z.string().min(1).max(40),
  retrieved_at: z.string(),
  cache: CacheStatusSchema,
  candidates: z.array(ReferenceCandidateSchema).max(REFERENCES_TAKE),
  /**
   * Whether the response carried anything echoing the request parameters.
   * The live API does not, so this is `false` on the real path: absence is
   * recorded, never read as proof that the parameters were applied.
   */
  echo_available: z.boolean(),
  /** How many rows were dropped as duplicates of an earlier entity id. */
  duplicates_dropped: z.number().int().nonnegative(),
  /** How many rows were dropped for a malformed required identity field. */
  malformed_rows: z.number().int().nonnegative(),
});

export type ReferenceCapture = z.infer<typeof ReferenceCaptureSchema>;

// ---------------------------------------------------------------------------
// Public projections
// ---------------------------------------------------------------------------

export const PublicReferenceCandidateSchema = ReferenceCandidateSchema.omit({
  affinity: true,
});

export type PublicReferenceCandidate = z.infer<typeof PublicReferenceCandidateSchema>;

/** Strips affinity. Use this for anything that crosses the server boundary. */
export function toPublicCandidate(candidate: ReferenceCandidate): PublicReferenceCandidate {
  const { affinity: _private, ...rest } = candidate;
  return rest;
}

export const PublicReferenceCaptureSchema = ReferenceCaptureSchema.omit({
  candidates: true,
}).extend({
  candidates: z.array(PublicReferenceCandidateSchema).max(REFERENCES_TAKE),
});

export type PublicReferenceCapture = z.infer<typeof PublicReferenceCaptureSchema>;

export function toPublicCapture(capture: ReferenceCapture): PublicReferenceCapture {
  const { candidates, ...rest } = capture;
  return { ...rest, candidates: candidates.map(toPublicCandidate) };
}

/** The usable rows a domain row displays, in original rank order. */
export function displayedCandidates(
  capture: PublicReferenceCapture,
): readonly PublicReferenceCandidate[] {
  return capture.candidates
    .filter((candidate) => candidate.usable)
    .slice(0, DISPLAYED_USABLE_PER_DOMAIN);
}

const CONTEXT_SENTENCE_KINDS: readonly EvidenceKind[] = ["description", "plot", "theme"];

/**
 * One supported context sentence for a card, built only from returned text.
 *
 * It picks the single highest-priority evidence item and truncates it on a word
 * boundary. It never merges two fields into one sentence, because the result
 * would be a claim no single returned field makes.
 */
export function supportedContextSentence(
  candidate: PublicReferenceCandidate,
  maxChars = 220,
): string | null {
  const preferred = candidate.evidence.find((item) =>
    CONTEXT_SENTENCE_KINDS.includes(item.kind),
  );
  const item = preferred ?? candidate.evidence[0];
  if (item === undefined) return null;
  if (item.text.length <= maxChars) return item.text;
  const cut = item.text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
