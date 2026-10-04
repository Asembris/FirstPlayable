/**
 * The raw upstream Qloo response shapes, pinned from real captures taken on
 * 4 October 2026 against `https://hackathon.api.qloo.com`.
 *
 * These schemas were written *after* inspecting live payloads, not from
 * memory, which is what specification section 6 requires: "the reports name
 * logical fields but not every exact JSON nesting path: phase 3 must pin those
 * mappings from a real capture."
 *
 * Observed envelopes:
 *
 * ```text
 * GET /search?...                 -> { "results": [ entity, ... ] }
 * GET /search?... (no match)      -> { "results": [] }
 * GET /v2/insights?...            -> { "success": true, "results": { "entities": [ entity, ... ] } }
 * ```
 *
 * The search envelope carries **no** `success` field; the insights envelope
 * does. Neither carries any echo of the request parameters, so
 * {@link INSIGHTS_ECHO_AVAILABLE} is `false` and this application records that
 * absence rather than treating it as proof the parameters were applied.
 *
 * Unknown harmless upstream fields are stripped rather than rejected: these
 * are plain `z.object`s, so a new upstream property cannot break retrieval. A
 * malformed *required* identity does fail, which is the distinction section 6
 * draws.
 */

import { z } from "zod";

/**
 * Neither observed envelope echoes `filter.type`, `signal.interests.entities`,
 * or the search query back. Each insights entity does carry a `query` object,
 * but it holds that entity's affinity, not a parameter echo.
 */
export const INSIGHTS_ECHO_AVAILABLE = false;

/** `properties.short_descriptions` and `properties.akas` share this shape. */
const LocalizedTextSchema = z.object({
  value: z.string().nullish(),
  languages: z.array(z.string()).nullish(),
});

const ImageSchema = z.object({ url: z.string().nullish() }).nullish();

/**
 * One tag. The observed `type` values are namespaced URNs such as
 * `urn:tag:theme:qloo` and `urn:tag:emotional_tone:qloo`.
 *
 * Search `tag_id` and insights tag `id` are normalized separately
 * (specification section 6); only the insights form is read here, because the
 * artist-search path uses no tag at all.
 */
export const RawTagSchema = z.object({
  id: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
});

export type RawTag = z.infer<typeof RawTagSchema>;

/**
 * The movie property fields this application reads.
 *
 * Deliberately absent, and never read: `audience_identity`,
 * `situational_contexts`, `player_demographics`, `websites`, `collaborators`,
 * `production_companies`, `filming_location`, `external`, `image`. Those are
 * long audience claims, demographic data, marketing links, or images — all of
 * which specification section 6 forbids sending onward.
 */
const MoviePropertiesSchema = z.object({
  description: z.string().nullish(),
  plot_summary: z.string().nullish(),
  plot_themes_description: z.string().nullish(),
  emotional_tone_description: z.string().nullish(),
  style_description: z.string().nullish(),
  genre_description: z.string().nullish(),
  short_descriptions: z.array(LocalizedTextSchema).nullish(),
  keywords: z.array(z.string()).nullish(),
  genres: z.array(z.string()).nullish(),
  release_year: z.number().nullish(),
  release_date: z.string().nullish(),
  image: ImageSchema,
});

/** The videogame property fields this application reads. Thinner, by design. */
const VideogamePropertiesSchema = z.object({
  description: z.string().nullish(),
  short_descriptions: z.array(LocalizedTextSchema).nullish(),
  emotional_tone: z.array(z.string()).nullish(),
  audience_tags: z.array(z.string()).nullish(),
  steam_tags: z.array(z.string()).nullish(),
  gameplay_type: z.array(z.string()).nullish(),
  genre: z.array(z.string()).nullish(),
  art_style: z.array(z.string()).nullish(),
  release_date: z.string().nullish(),
  universe: z.string().nullish(),
  image: ImageSchema,
});

/** The union of both, so one entity schema serves both insight domains. */
const InsightPropertiesSchema = MoviePropertiesSchema.extend(
  VideogamePropertiesSchema.shape,
);

export type InsightProperties = z.infer<typeof InsightPropertiesSchema>;

/**
 * One insights entity.
 *
 * `entity_id`, `name`, and `subtype` are the identity fields; a row missing or
 * malforming one of them is rejected as a candidate rather than repaired.
 * `query.affinity` is read and persisted privately.
 */
export const RawInsightEntitySchema = z.object({
  name: z.string().nullish(),
  entity_id: z.string().nullish(),
  type: z.string().nullish(),
  subtype: z.string().nullish(),
  disambiguation: z.string().nullish(),
  popularity: z.number().nullish(),
  properties: InsightPropertiesSchema.nullish(),
  tags: z.array(RawTagSchema).nullish(),
  query: z
    .object({
      affinity: z.number().nullish(),
    })
    .nullish(),
});

export type RawInsightEntity = z.infer<typeof RawInsightEntitySchema>;

/**
 * The insights envelope. `success: false` is the error-shaped HTTP 200 case
 * section 6 names, and it fails rather than producing an empty capture.
 */
export const RawInsightsResponseSchema = z.object({
  success: z.boolean().nullish(),
  results: z
    .object({
      entities: z.array(RawInsightEntitySchema).nullish(),
    })
    .nullish(),
  error: z.unknown().nullish(),
  message: z.unknown().nullish(),
});

export type RawInsightsResponse = z.infer<typeof RawInsightsResponseSchema>;

/** `properties.external` for an artist: catalogue links, used for disambiguation. */
const ArtistExternalSchema = z.record(z.string(), z.unknown()).nullish();

const ArtistPropertiesSchema = z.object({
  short_description: z.string().nullish(),
  external: ArtistExternalSchema,
});

/**
 * One search entity. `types` is an array here — the search surface uses
 * `types[]` where insights uses a single `subtype`, which is exactly the
 * separate normalization specification section 6 asks for.
 */
export const RawSearchEntitySchema = z.object({
  name: z.string().nullish(),
  entity_id: z.string().nullish(),
  types: z.array(z.string()).nullish(),
  disambiguation: z.string().nullish(),
  popularity: z.number().nullish(),
  properties: ArtistPropertiesSchema.nullish(),
});

export type RawSearchEntity = z.infer<typeof RawSearchEntitySchema>;

/** The search envelope: a flat `results` array, with no `success` field. */
export const RawSearchResponseSchema = z.object({
  success: z.boolean().nullish(),
  results: z.array(RawSearchEntitySchema).nullish(),
  error: z.unknown().nullish(),
  message: z.unknown().nullish(),
});

export type RawSearchResponse = z.infer<typeof RawSearchResponseSchema>;

/**
 * The exact header names the live API returned. Recorded when present; a
 * missing header stays null rather than becoming an invented figure.
 */
export const QUOTA_HEADERS = {
  monthLimit: "x-month-ratelimit-limit",
  monthRemaining: "x-month-ratelimit-remaining",
  monthReset: "x-month-ratelimit-reset",
  secondLimit: "x-second-ratelimit-limit",
} as const;
