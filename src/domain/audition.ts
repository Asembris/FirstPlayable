/**
 * The audience comp audition: contracts shared by the server and the browser.
 *
 * > Choose the comps. Switch the audience. See what changes.
 *
 * Four roles, kept apart on purpose:
 *
 *   * **The creator** decides which titles represent the project. A comp is
 *     only ever scored after the creator confirmed one specific Qloo search
 *     result for it.
 *   * **Qloo** supplies identity (search) and audience-affinity evidence
 *     (`/v2/insights`). Every name this surface displays as a comp or an
 *     audience was copied out of a stored Qloo capture by the server.
 *   * **Deterministic code** (`audition-compare.ts`) orders comps, groups
 *     close values, and finds reversals.
 *   * **The agent** turns a creator's sentence into slot edits and Qloo
 *     search operations. Its output schema has no numeric field, so it cannot
 *     carry a score, a rank, or a winner.
 *
 * This module is separate from `qloo.ts` because the earlier product treats
 * affinity as private diagnostic data and strips it from every public view.
 * Here affinity *is* the evidence under comparison, shown as secondary
 * evidence beside the ordering it produced. The two products do not share a
 * public projection, so neither policy weakens the other.
 */

import { z } from "zod";
import { CacheStatusSchema, QlooDomainSchema, QlooUuidSchema } from "./qloo";

/**
 * The product's display rule for "close": two affinities whose gap is
 * smaller than this are shown as close, and neither is called ahead.
 *
 * This is a **UI display threshold** chosen by this application. It is NOT a
 * statistical significance test, and it is NOT a confidence threshold that
 * Qloo publishes or returns. It exists so a tiny gap is never presented as a
 * winner.
 */
export const AUDITION_CLOSE_THRESHOLD = 0.03;

/** Exactly two audiences: the A/B switch is the whole point of this slice. */
export const AUDITION_AUDIENCE_COUNT = 2;

/** Comps per domain. Small on purpose: every one costs a confirmation. */
export const MAX_COMPS_PER_DOMAIN = 4;

/** Search results offered for confirmation per slot. */
export const COMP_SEARCH_TAKE = 5;

/** The normalizer version for audition captures. Part of every cache key. */
export const AUDITION_NORMALIZER_VERSION = "qloo-audition-1";

export const SLOT_KINDS = ["movie", "videogame", "audience"] as const;
export const SlotKindSchema = z.enum(SLOT_KINDS);
export type SlotKind = z.infer<typeof SlotKindSchema>;

/** At most four comps in each domain and two audiences. */
export const MAX_SLOTS = MAX_COMPS_PER_DOMAIN * 2 + AUDITION_AUDIENCE_COUNT;

export const SLOT_ID_PATTERN = /^s[1-9][0-9]?$/u;
export const SlotIdSchema = z.string().regex(SLOT_ID_PATTERN);

export const SLOT_QUERY_MAX = 80;
export const REQUEST_MESSAGE_MAX = 400;

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

/**
 * One thing the creator asked about: a comp in one domain, or an audience.
 *
 * `query` is the creator's (or the agent's) search wording and is never shown
 * as a confirmed name. `confirmed_entity_id` is set only by the creator
 * choosing one result from the search capture `search_capture_id` names; the
 * server re-checks that pairing before anything is scored.
 */
export const AuditionSlotSchema = z.strictObject({
  slot_id: SlotIdSchema,
  kind: SlotKindSchema,
  query: z.string().trim().min(1).max(SLOT_QUERY_MAX),
  search_capture_id: z.uuid().nullable(),
  confirmed_entity_id: QlooUuidSchema.nullable(),
});

export type AuditionSlot = z.infer<typeof AuditionSlotSchema>;

/** The only deferred action supported: choosing a comp's media type. */
export const DeferredMediaActionSchema = z.strictObject({
  op: z.enum(["add", "replace"]),
  slot_id: SlotIdSchema.nullable(),
  query: z.string().trim().min(1).max(SLOT_QUERY_MAX),
}).superRefine((action, context) => {
  if ((action.op === "add") !== (action.slot_id === null)) {
    context.addIssue({ code: "custom", message: "add has no target; replace requires a target", path: ["slot_id"] });
  }
});

/** One deferred action, never conversation history or retrieved evidence. */
export const PendingClarificationSchema = z.strictObject({
  action: DeferredMediaActionSchema,
  ambiguity: z.literal("media_type"),
  choices: z.tuple([z.literal("movie"), z.literal("videogame")]),
  question: z.string().trim().min(1).max(240),
  slot_context: z.string().min(1).max(10000),
});

export function clarificationSlotContext(slots: readonly AuditionSlot[]): string {
  return JSON.stringify(slots.map(({ slot_id, kind, query }) => ({ slot_id, kind, query })));
}

export const AuditionStateSchema = z
  .strictObject({
    slots: z.array(AuditionSlotSchema).max(MAX_SLOTS),
    pending_clarification: PendingClarificationSchema.optional(),
  })
  .superRefine((state, context) => {
    if (state.pending_clarification !== undefined &&
        state.pending_clarification.slot_context !== clarificationSlotContext(state.slots)) {
      context.addIssue({ code: "custom", message: "stale pending clarification", path: ["pending_clarification"] });
    }
    const target = state.pending_clarification?.action;
    if (target?.op === "replace" && !state.slots.some(slot => slot.slot_id === target.slot_id && slot.kind !== "audience")) {
      context.addIssue({ code: "custom", message: "invalid clarification target", path: ["pending_clarification"] });
    }
    const ids = new Set<string>();
    const counts: Record<SlotKind, number> = { movie: 0, videogame: 0, audience: 0 };
    for (const slot of state.slots) {
      if (ids.has(slot.slot_id)) {
        context.addIssue({ code: "custom", message: "duplicate slot id", path: ["slots"] });
      }
      ids.add(slot.slot_id);
      counts[slot.kind] += 1;
      if (slot.confirmed_entity_id !== null && slot.search_capture_id === null) {
        context.addIssue({
          code: "custom",
          message: "a confirmation must name the search it came from",
          path: ["slots"],
        });
      }
    }
    if (counts.movie > MAX_COMPS_PER_DOMAIN || counts.videogame > MAX_COMPS_PER_DOMAIN) {
      context.addIssue({ code: "custom", message: "too many comps", path: ["slots"] });
    }
    if (counts.audience > AUDITION_AUDIENCE_COUNT) {
      context.addIssue({ code: "custom", message: "too many audiences", path: ["slots"] });
    }
  });

export type AuditionState = z.infer<typeof AuditionStateSchema>;

export const EMPTY_AUDITION_STATE: AuditionState = { slots: [] };

// ---------------------------------------------------------------------------
// Qloo comp search
// ---------------------------------------------------------------------------

/** One returned movie or videogame, with enough context to tell titles apart. */
export const CompCandidateSchema = z.strictObject({
  entity_id: QlooUuidSchema,
  name: z.string().min(1).max(300),
  domain: QlooDomainSchema,
  year: z.number().int().nullable(),
  disambiguation: z.string().max(200).nullable(),
  /** 1-based position in the returned list. Never re-sorted. */
  original_rank: z.number().int().positive(),
});

export type CompCandidate = z.infer<typeof CompCandidateSchema>;

/**
 * One `/search` capture for a comp. The literal `kind` keeps it from ever
 * parsing as the earlier product's artist snapshot, which is a strict schema
 * without that field, so the two cannot be confused through a capture id.
 */
export const CompSearchSnapshotSchema = z.strictObject({
  kind: z.literal("comp_search"),
  capture_id: z.uuid().nullable(),
  domain: QlooDomainSchema,
  query: z.string().min(1).max(SLOT_QUERY_MAX),
  normalized_query: z.string().min(1).max(SLOT_QUERY_MAX),
  request_fingerprint: z.string().min(1).max(200),
  normalizer_version: z.string().min(1).max(40),
  retrieved_at: z.string(),
  cache: CacheStatusSchema,
  candidates: z.array(CompCandidateSchema).max(COMP_SEARCH_TAKE),
});

export type CompSearchSnapshot = z.infer<typeof CompSearchSnapshotSchema>;

// ---------------------------------------------------------------------------
// Qloo scoring
// ---------------------------------------------------------------------------

export const CompScoreSchema = z.strictObject({
  entity_id: QlooUuidSchema,
  /** The name Qloo returned in this response. */
  name: z.string().min(1).max(300),
  /** `results.entities[].query.affinity`, exactly as returned. Null if absent. */
  affinity: z.number().nullable(),
});

export type CompScore = z.infer<typeof CompScoreSchema>;

/**
 * One `/v2/insights` capture: one audience, one domain, exactly the confirmed
 * candidate ids. A requested id Qloo did not return is listed in
 * `missing_entity_ids`; it is never given a score.
 */
export const CompScoreCaptureSchema = z.strictObject({
  kind: z.literal("comp_scores"),
  capture_id: z.uuid().nullable(),
  domain: QlooDomainSchema,
  audience_entity_id: QlooUuidSchema,
  requested_entity_ids: z.array(QlooUuidSchema).min(1).max(MAX_COMPS_PER_DOMAIN),
  request_fingerprint: z.string().min(1).max(200),
  normalizer_version: z.string().min(1).max(40),
  retrieved_at: z.string(),
  cache: CacheStatusSchema,
  scores: z.array(CompScoreSchema).max(MAX_COMPS_PER_DOMAIN),
  missing_entity_ids: z.array(QlooUuidSchema).max(MAX_COMPS_PER_DOMAIN),
});

export type CompScoreCapture = z.infer<typeof CompScoreCaptureSchema>;

// ---------------------------------------------------------------------------
// Route contracts
// ---------------------------------------------------------------------------

export const InterpretRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(REQUEST_MESSAGE_MAX),
  state: AuditionStateSchema,
});

export type InterpretRequest = z.infer<typeof InterpretRequestSchema>;

/** One search result, as the confirmation step shows it. Qloo text only. */
export type SearchCandidateView = {
  entity_id: string;
  name: string;
  /** A disambiguation, a year, or a short description Qloo returned. */
  hint: string | null;
  original_rank: number;
};

export type SlotSearchView = {
  slot_id: string;
  kind: SlotKind;
  search_capture_id: string | null;
  retrieved_at: string;
  cache: "live" | "cached" | "stale";
  candidates: SearchCandidateView[];
};

/** What the agent's plan did to the task state, for the transcript. */
export type AppliedAction = {
  op: "add" | "remove" | "replace";
  slot_id: string;
  kind: SlotKind;
  query: string | null;
};

export type InterpretResponse = {
  state: AuditionState;
  applied: AppliedAction[];
  skipped: string[];
  clarification: string | null;
  searches: SlotSearchView[];
  model_calls: number;
  upstream_calls: number;
};

export const ScoreRequestSchema = z.strictObject({ state: AuditionStateSchema });

export type ScoreRequest = z.infer<typeof ScoreRequestSchema>;
