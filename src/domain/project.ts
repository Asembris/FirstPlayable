/**
 * Project contracts shared by the browser and the server (specification
 * section 11).
 *
 * These live in `src/domain/` beside the scene and brief contracts because
 * both sides need them and neither side may hold a second, handwritten copy.
 * Nothing here reads configuration or touches a service.
 *
 * `ProjectView` is the *whole* public shape of a project. Provider
 * diagnostics, request fingerprints, quota counters, the owner session id, and
 * the clean base scene are all absent by construction, so a route cannot leak
 * one by forgetting to strip it.
 */

import { z } from "zod";
import { BriefSchema, workingTitle, type Brief } from "./brief";
import {
  APPROVED_INTERPRETATION_MAX,
  ApprovedInfluenceSchema,
  DecisionKindSchema,
  INTENDED_INTERACTION_MAX,
  ProposedInterpretationSchema,
} from "./influence";
import { SLOTS, WORLD_TEXT } from "./limits";
import {
  ArtistSearchSnapshotSchema,
  CacheStatusSchema,
  ConfirmedAnchorSchema,
  DISPLAYED_USABLE_PER_DOMAIN,
  PublicReferenceCandidateSchema,
  QlooDomainSchema,
  QlooUuidSchema,
  REFERENCES_TAKE,
} from "./qloo";
import { codePointLength } from "./text";

/** The model-and-orchestration state machine of specification section 8. */
export const WORKFLOW_STATES = [
  "DRAFT",
  "ANCHOR_CONFIRMED",
  "REFERENCES_READY",
  "PROPOSALS_READY",
  "AWAITING_APPROVAL",
  "BASE_READY",
  "MODULES_READY",
  "VALIDATING",
  "REVIEW_PLAYABLE",
  "READY",
  "REVISION_PENDING",
  "FAILED",
] as const;

export const WorkflowStateSchema = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/**
 * The phase 2 project-creation payload: one frozen brief, nothing else.
 *
 * A creator cannot supply a revision counter, a workflow state, an approval
 * id, a base scene, or an owner session id. The server assigns every one of
 * those, which is why no scene can self-authorise an approval.
 */
export const CreateProjectRequestSchema = z.strictObject({
  brief: BriefSchema,
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/**
 * The public face of a confirmed anchor.
 *
 * It carries the identity the creator confirmed and the context that made the
 * confirmation possible. It deliberately omits the request fingerprint and the
 * normalizer version, which are server diagnostics.
 */
export const AnchorViewSchema = ConfirmedAnchorSchema.omit({
  search_request_fingerprint: true,
  normalizer_version: true,
});

export type AnchorView = z.infer<typeof AnchorViewSchema>;

/** Why a returned row is not one of the cards on screen. Both are honest. */
export const SKIP_REASONS = ["no_usable_context", "beyond_display_limit"] as const;
export const SkipReasonSchema = z.enum(SKIP_REASONS);

/**
 * One domain row of the studio.
 *
 * `displayed` holds at most three usable candidates with their evidence, which
 * is what the specification asks the UI to show. `skipped` keeps every other
 * returned row as a compact line, so the original ranking and its gaps stay
 * visible without shipping ten full evidence sets to the browser.
 */
export const DomainRowViewSchema = z.strictObject({
  domain: QlooDomainSchema,
  status: z.enum(["ready", "unavailable"]),
  cache: CacheStatusSchema.nullable(),
  capture_id: z.uuid().nullable(),
  retrieved_at: z.string().nullable(),
  displayed: z.array(PublicReferenceCandidateSchema).max(DISPLAYED_USABLE_PER_DOMAIN),
  skipped: z
    .array(
      z.strictObject({
        original_rank: z.number().int().positive(),
        name: z.string(),
        reason: SkipReasonSchema,
      }),
    )
    .max(REFERENCES_TAKE),
  returned_count: z.number().int().nonnegative(),
  usable_count: z.number().int().nonnegative(),
  /** Set only on a consented stale capture, so the label can state its date. */
  stale_captured_at: z.string().nullable(),
  /** This application's own stable code. Never a provider header or body. */
  failure_code: z.string().nullable(),
});

export type DomainRowView = z.infer<typeof DomainRowViewSchema>;

export const ReferencesViewSchema = z.strictObject({
  movie: DomainRowViewSchema,
  videogame: DomainRowViewSchema,
  /** False when neither domain can support a Qloo-grounded proposal. */
  any_usable: z.boolean(),
});

export type ReferencesView = z.infer<typeof ReferencesViewSchema>;

/**
 * The provenance chain of one approval (specification section 13).
 *
 * Three layers, because three layers exist in phase 3. There is deliberately
 * **no** `scene_changed` field: a chain cannot assert a mechanical consequence
 * that no compiler has produced, because the type offers nowhere to put it.
 *
 * No affinity appears anywhere in this shape. `original_rank` and the evidence
 * field paths are here for the deeper disclosures the specification places
 * behind a second expansion, not for the first fold.
 */
export const ProvenanceViewSchema = z.strictObject({
  approval_id: z.uuid(),
  slot: z.enum(SLOTS),
  /** Qloo retrieved. Null only when the original capture is unreadable. */
  retrieved: z
    .strictObject({
      reference_name: z.string(),
      domain: QlooDomainSchema,
      year: z.number().int().nullable(),
      entity_id: QlooUuidSchema,
      original_rank: z.number().int().positive(),
      /**
       * When the capture this approval cites was retrieved upstream.
       *
       * A capture row exists only because one live upstream call produced it,
       * so this is the live-at-retrieval date the drawer shows. The separate
       * cached-or-live label belongs to the references row, where it says
       * whether *that request* called upstream; here the fact that matters is
       * how old the evidence behind a frozen approval is.
       */
      captured_at: z.string(),
      /** One sentence, from one returned field. Never a merge of two. */
      context: z.string().nullable(),
      evidence: z.array(
        z.strictObject({
          id: z.string(),
          field_path: z.string(),
          text: z.string(),
        }),
      ),
    })
    .nullable(),
  /** FirstPlayable proposed. Explicitly a model interpretation. */
  proposed: z.strictObject({
    idea: z.string(),
    intended_interaction: z.string(),
    relevance: z.string(),
    attribution: z.string(),
  }),
  /** Creator approved. The exact frozen wording. */
  approved: z.strictObject({
    text: z.string(),
    intended_effect: z.string(),
    edited_by_creator: z.boolean(),
    approved_at: z.string(),
    slot: z.enum(SLOTS),
    predecessor_id: z.uuid().nullable(),
  }),
});

export type ProvenanceView = z.infer<typeof ProvenanceViewSchema>;

export const ProjectViewSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  brief: BriefSchema,
  revision: z.number().int().positive(),
  workflow_state: WorkflowStateSchema,
  /** Phase 3 confirms a cultural anchor. Phase 2 always reported false. */
  anchor_confirmed: z.boolean(),
  /** The explicitly confirmed artist, or null before confirmation. */
  anchor: AnchorViewSchema.nullable(),
  /** The active validated version, preserved across every failed compilation. */
  active_version_id: z.uuid().nullable(),
  /**
   * A validated version awaiting the creator's explicit review confirmation.
   *
   * It is deliberately separate from `active_version_id`: a successful
   * compilation becomes reviewable, never silently current
   * (specification section 7, "Approval semantics").
   */
  pending_version_id: z.uuid().nullable(),
  /** Which influence slots currently hold an approval. Empty by default. */
  approved_slots: z.array(z.enum(SLOTS)),
  /**
   * The current approvals, with the frozen text and the evidence each cites.
   * Empty unless the creator explicitly approved something.
   */
  approvals: z.array(ApprovedInfluenceSchema),
  /**
   * The inspectable chain behind each current approval: retrieved, proposed,
   * approved. Empty whenever `approvals` is empty.
   */
  provenance: z.array(ProvenanceViewSchema),
  /**
   * The current proposal draft. A draft is not an approval, and rendering one
   * does not imply any of it was accepted.
   */
  proposals: z.array(ProposedInterpretationSchema),
  /** Which captures the project's retrieved references live in. */
  reference_capture_ids: z.array(z.uuid()).max(2),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const CreateProjectResponseSchema = z.strictObject({
  project: ProjectViewSchema,
  references: ReferencesViewSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Phase 3 request and response contracts
// ---------------------------------------------------------------------------

const ArtistQuerySchema = z
  .string()
  .refine(
    (value) =>
      codePointLength(value.trim()) >= WORLD_TEXT.artist_query_min &&
      codePointLength(value.trim()) <= WORLD_TEXT.artist_query_max,
    {
      message: `must be ${WORLD_TEXT.artist_query_min}-${WORLD_TEXT.artist_query_max} code points`,
    },
  );

/**
 * `POST /api/projects/:id/artist-search`.
 *
 * One field. The creator supplies a query, never a URL, a type, a take, a
 * filter, or anything else that could become a request parameter.
 */
export const ArtistSearchRequestSchema = z.strictObject({
  query: ArtistQuerySchema,
});

export type ArtistSearchRequest = z.infer<typeof ArtistSearchRequestSchema>;

export const ArtistSearchResponseSchema = z.strictObject({
  search: ArtistSearchSnapshotSchema,
  project: ProjectViewSchema,
});

/**
 * `PUT /api/projects/:id/anchor`.
 *
 * The creator names a capture and one entity id from it. Every other anchor
 * field is copied by the server out of that capture, so a forged name,
 * description, or rank cannot enter the project.
 */
export const ConfirmAnchorRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  search_capture_id: z.uuid(),
  entity_id: QlooUuidSchema,
  /**
   * Explicit consent to invalidate cultural work belonging to a different
   * artist. Absent or false, a conflicting change is refused rather than
   * silently discarding approvals.
   */
  rebranch: z.boolean().optional(),
});

export type ConfirmAnchorRequest = z.infer<typeof ConfirmAnchorRequestSchema>;

export const ConfirmAnchorResponseSchema = z.strictObject({
  project: ProjectViewSchema,
  /** True when an anchor change cleared approvals, which the UI states. */
  invalidated: z.boolean(),
  cleared_slots: z.array(z.enum(SLOTS)),
});

/**
 * `POST /api/projects/:id/references`.
 *
 * `accept_stale` is the creator's explicit consent to a dated capture for the
 * same artist, which is the only way a stale capture is ever used.
 */
export const ReferencesRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  accept_stale: z.boolean().optional(),
});

export type ReferencesRequest = z.infer<typeof ReferencesRequestSchema>;

export const ReferencesResponseSchema = z.strictObject({
  project: ProjectViewSchema,
  references: ReferencesViewSchema,
  /** Upstream attempts this request actually spent. Zero on a cache hit. */
  upstream_calls: z.number().int().nonnegative(),
});

export type ReferencesResponse = z.infer<typeof ReferencesResponseSchema>;

/**
 * `POST /api/projects/:id/proposals`.
 *
 * One field. There is no prompt, no instructions, no model name, no
 * temperature, no reference list, and no evidence in this body: all of it
 * comes from the server's own frozen state, which is what keeps this route
 * from being an arbitrary prompt endpoint.
 */
export const ProposalsRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
});

export type ProposalsRequest = z.infer<typeof ProposalsRequestSchema>;

export const ProposalsResponseSchema = z.strictObject({
  project: ProjectViewSchema,
  /** Provider calls this request made. Zero when a committed result replayed. */
  model_calls: z.number().int().nonnegative().max(2),
  /** True when the one permitted structural repair was needed. */
  repaired: z.boolean(),
  /** True when an idempotent retry returned the already-committed draft. */
  replayed: z.boolean(),
});

export type ProposalsResponse = z.infer<typeof ProposalsResponseSchema>;

/**
 * `POST /api/projects/:id/decisions` (specification section 11).
 *
 * One explicit creator decision per request. The default accepted count is
 * zero and stays zero until one of these arrives:
 *
 *   * `accept`  — approve a proposal as written, into an **empty** slot;
 *   * `edit`    — approve creator-edited wording, into an **empty** slot;
 *   * `replace` — explicitly displace the approval a slot already holds;
 *   * `reject`  — dismiss a proposal; this never clears an existing approval;
 *   * `remove`  — withdraw the approval a slot currently holds.
 *
 * `accept` into an occupied slot is refused rather than silently merged, which
 * is what makes replacement an explicit act with a visible before and after.
 */
const DecisionBaseFields = {
  expected_revision: z.number().int().positive(),
} as const;

const ApprovedTextSchema = z
  .string()
  .refine(
    (value) =>
      codePointLength(value.trim()) >= 1 &&
      codePointLength(value.trim()) <= APPROVED_INTERPRETATION_MAX,
    { message: `must be 1-${APPROVED_INTERPRETATION_MAX} code points` },
  );

const IntendedEffectSchema = z
  .string()
  .refine(
    (value) =>
      codePointLength(value.trim()) >= 1 &&
      codePointLength(value.trim()) <= INTENDED_INTERACTION_MAX,
    { message: `must be 1-${INTENDED_INTERACTION_MAX} code points` },
  );

export const DecisionsRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...DecisionBaseFields,
    kind: z.literal("accept"),
    proposal_id: z.string().min(1).max(64),
    /** An explicit slot choice. Defaults to the slot the proposal named. */
    slot: z.enum(SLOTS).optional(),
    /** An optional narrowing of the cited evidence. Never a widening. */
    selected_evidence_ids: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
  }),
  z.strictObject({
    ...DecisionBaseFields,
    kind: z.literal("edit"),
    proposal_id: z.string().min(1).max(64),
    slot: z.enum(SLOTS).optional(),
    approved_text: ApprovedTextSchema,
    intended_effect: IntendedEffectSchema,
    selected_evidence_ids: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
  }),
  z.strictObject({
    ...DecisionBaseFields,
    kind: z.literal("replace"),
    proposal_id: z.string().min(1).max(64),
    slot: z.enum(SLOTS).optional(),
    approved_text: ApprovedTextSchema.optional(),
    intended_effect: IntendedEffectSchema.optional(),
    selected_evidence_ids: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
  }),
  z.strictObject({
    ...DecisionBaseFields,
    kind: z.literal("reject"),
    proposal_id: z.string().min(1).max(64),
  }),
  z.strictObject({
    ...DecisionBaseFields,
    kind: z.literal("remove"),
    slot: z.enum(SLOTS),
  }),
]);

export type DecisionsRequest = z.infer<typeof DecisionsRequestSchema>;

export const DecisionsResponseSchema = z.strictObject({
  project: ProjectViewSchema,
  decision_id: z.uuid(),
  /** The decision kind that was actually recorded. */
  kind: DecisionKindSchema,
  /** The approval this one displaced, when it was an explicit replacement. */
  replaced_approval_id: z.uuid().nullable(),
});

export type DecisionsResponse = z.infer<typeof DecisionsResponseSchema>;

export const SessionResponseSchema = z.strictObject({
  established: z.boolean(),
  expires_at: z.string(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** The title the server assigns when the creator left it empty. */
export function projectTitleFor(brief: Brief): string {
  const derived = workingTitle(brief).trim();
  return derived.length === 0 ? "Untitled encounter" : derived;
}
