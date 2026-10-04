/**
 * The influence pipeline's records (specification section 7).
 *
 * The chain is `QlooReference → ProposedInterpretation → CreatorDecision →
 * ApprovedInfluence`, and each link is a separate type on purpose: the
 * narrowing happens in the type system, not in a comment.
 *
 * Phase 3 stops at `ApprovedInfluence`. `SceneMechanic` belongs to phase 4 and
 * is deliberately absent, so nothing here can present a "Scene changed" step
 * that no compiler has produced.
 *
 * What a proposal may and may not say is encoded here too. A proposal carries
 * an abstraction, an interaction, and a relevance sentence that is *labelled*
 * a FirstPlayable interpretation. It has no field in which to assert that Qloo
 * recommended a mechanic, that the reference is objectively best, or that it
 * knows the creator's taste.
 */

import { z } from "zod";
import { SLOTS } from "./limits";
import { TEXT } from "./limits";
import { QlooDomainSchema, QlooUuidSchema } from "./qloo";

export const SlotSchema = z.enum(SLOTS);
export type Slot = z.infer<typeof SlotSchema>;

/** Specification section 4: proposed ≤500 characters, approved ≤700. */
export const PROPOSED_INTERPRETATION_MAX = TEXT.proposed_interpretation;
export const APPROVED_INTERPRETATION_MAX = TEXT.approved_interpretation;

/** Caps on the two shorter structured fields a proposal also carries. */
export const INTENDED_INTERACTION_MAX = 300;
export const RELEVANCE_MAX = 300;

/** One bounded model call may return at most this many proposals. */
export const MAX_PROPOSALS_PER_CALL = 6;

/** A proposal must cite at least one and at most this many evidence items. */
export const MAX_SELECTED_EVIDENCE = 4;

/**
 * The fixed label every relevance sentence is rendered under. It is applied by
 * this application, not written by the model, so the model cannot drop it.
 */
export const PROPOSAL_ATTRIBUTION = "FirstPlayable interpretation, not a Qloo assertion";

// ---------------------------------------------------------------------------
// ProposedInterpretation
// ---------------------------------------------------------------------------

/**
 * What one bounded model call is allowed to return, per proposal.
 *
 * There is no `proposal_id` here: the server assigns it. There is no
 * `approved` flag, no `entity_id`, no `confidence`, and no `source_kind`,
 * because none of those may come from model output (specification section 4).
 */
export const ProposalDraftItemSchema = z.strictObject({
  /** Must name one of the eligible references passed into this exact call. */
  reference_id: z.string().min(1).max(64),
  /** Must be a subset of that reference's own evidence ids. */
  selected_evidence_ids: z.array(z.string().min(1).max(64)),
  slot: SlotSchema,
  /** The cultural abstraction. Borrow an idea, never copy a plot or wording. */
  idea: z.string(),
  /** One concrete interaction the creator could put in the encounter. */
  intended_interaction: z.string(),
  /** Why this follows from the cited evidence. Rendered as an interpretation. */
  relevance: z.string(),
});

export type ProposalDraftItem = z.infer<typeof ProposalDraftItemSchema>;

/** The whole structured payload of the proposal stage. */
export const ProposalModelOutputSchema = z.strictObject({
  proposals: z.array(ProposalDraftItemSchema),
});

export type ProposalModelOutput = z.infer<typeof ProposalModelOutputSchema>;

/**
 * A proposal after the server has validated it and assigned its id.
 *
 * `reference_id`, `entity_id`, `name`, and `domain` are copied from the frozen
 * capture, not from model output, which is what makes the provenance line
 * underneath a card checkable.
 */
export const ProposedInterpretationSchema = z.strictObject({
  proposal_id: z.string().min(1).max(64),
  reference_id: z.string().min(1).max(64),
  entity_id: QlooUuidSchema,
  reference_name: z.string().min(1).max(300),
  domain: QlooDomainSchema,
  capture_id: z.uuid().nullable(),
  selected_evidence_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_SELECTED_EVIDENCE),
  slot: SlotSchema,
  idea: z.string().min(1).max(PROPOSED_INTERPRETATION_MAX),
  intended_interaction: z.string().min(1).max(INTENDED_INTERACTION_MAX),
  relevance: z.string().min(1).max(RELEVANCE_MAX),
});

export type ProposedInterpretation = z.infer<typeof ProposedInterpretationSchema>;

/**
 * The current proposal draft stored on the project.
 *
 * It is a draft, not an approval: `approved_slots` stays empty until the
 * creator clicks approve. The model identifier and token usage are recorded
 * here so the evidence record is not a separate hand-kept ledger.
 */
export const ProposalDraftSchema = z.strictObject({
  draft_id: z.string().min(1).max(64),
  created_at: z.string(),
  model: z.string().min(1).max(80),
  /** Which captures the eligible references came out of. */
  capture_ids: z.array(z.uuid()).max(2),
  /** The brief hash this draft was produced against. */
  brief_hash: z.string().min(1).max(64),
  anchor_entity_id: QlooUuidSchema,
  proposals: z.array(ProposedInterpretationSchema).max(MAX_PROPOSALS_PER_CALL),
  usage: z
    .strictObject({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .nullable(),
  /** 1 normally; 2 when the one permitted structural repair was needed. */
  model_calls: z.number().int().positive().max(2),
  repaired: z.boolean(),
});

export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

// ---------------------------------------------------------------------------
// CreatorDecision
// ---------------------------------------------------------------------------

/**
 * The decision vocabulary, matching the phase 2 schema's check constraint.
 *
 *   * `accept`  — approve a proposal as written into an empty slot.
 *   * `edit`    — approve creator-edited wording into an empty slot.
 *   * `replace` — explicitly displace the approval a slot already holds.
 *   * `reject`  — dismiss a proposal that was never approved.
 *   * `remove`  — withdraw the approval a slot currently holds.
 *
 * `reject` deliberately does not clear a slot pointer: dismissing a card must
 * not silently withdraw an approval the creator already made.
 */
export const DECISION_KINDS = ["accept", "edit", "replace", "reject", "remove"] as const;
export const DecisionKindSchema = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

/** Which kinds set a slot's current approval pointer. */
export const APPROVING_KINDS = ["accept", "edit", "replace"] as const;

export function isApprovingKind(kind: DecisionKind): boolean {
  return (APPROVING_KINDS as readonly string[]).includes(kind);
}

/**
 * The frozen snapshot stored on an immutable decision row.
 *
 * It holds the proposal exactly as it was shown, plus the creator's final
 * wording. Editing changes `approved_text` and `intended_effect` and nothing
 * else: the proposal snapshot and therefore the cited Qloo evidence are never
 * rewritten (specification section 7).
 */
export const DecisionSnapshotSchema = z.strictObject({
  kind: DecisionKindSchema,
  /** Null only for `remove`, which withdraws without naming a new proposal. */
  proposal: ProposedInterpretationSchema.nullable(),
  /** The slot the proposal was shown for, recorded even on a dismissal. */
  proposed_slot: SlotSchema,
  /** The creator's final wording. Equal to the proposal's idea on a plain accept. */
  approved_text: z.string().max(APPROVED_INTERPRETATION_MAX).nullable(),
  intended_effect: z.string().max(INTENDED_INTERACTION_MAX).nullable(),
  edited_by_creator: z.boolean(),
  /** Always `qloo` in phase 3. A fixture or model-selected source is labelled. */
  source_kind: z.enum(["qloo", "model_selected", "design_fixture"]),
  decided_at: z.string(),
  /** The project revision the decision was taken against. */
  project_revision: z.number().int().positive(),
});

export type DecisionSnapshot = z.infer<typeof DecisionSnapshotSchema>;

// ---------------------------------------------------------------------------
// ApprovedInfluence
// ---------------------------------------------------------------------------

/**
 * A frozen approval: the authoritative unit a phase 4 module compiler will be
 * given, and the only cultural material it will be given.
 *
 * Its `approval_id` is the immutable decision row's id. Its evidence is the
 * exact subset the creator's approved proposal cited. Nothing about another
 * slot, another reference, or a dismissed proposal is reachable from here.
 */
export const ApprovedInfluenceSchema = z.strictObject({
  approval_id: z.uuid(),
  slot: SlotSchema,
  reference_id: z.string().min(1).max(64),
  entity_id: QlooUuidSchema,
  reference_name: z.string().min(1).max(300),
  domain: QlooDomainSchema,
  capture_id: z.uuid().nullable(),
  selected_evidence_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_SELECTED_EVIDENCE),
  /** The creator's final wording. Equal to `proposed_idea` on a plain accept. */
  approved_text: z.string().min(1).max(APPROVED_INTERPRETATION_MAX),
  intended_effect: z.string().min(1).max(INTENDED_INTERACTION_MAX),
  /**
   * What the model actually proposed, kept alongside the approved wording so
   * the provenance drawer can show the two layers separately and label an
   * edit honestly. Creator editing never rewrites these.
   */
  proposed_idea: z.string().min(1).max(PROPOSED_INTERPRETATION_MAX),
  proposed_interaction: z.string().min(1).max(INTENDED_INTERACTION_MAX),
  proposed_relevance: z.string().min(1).max(RELEVANCE_MAX),
  edited_by_creator: z.boolean(),
  source_kind: z.literal("qloo"),
  project_revision: z.number().int().positive(),
  predecessor_id: z.uuid().nullable(),
  approved_at: z.string(),
});

export type ApprovedInfluence = z.infer<typeof ApprovedInfluenceSchema>;

/**
 * The smallest compiler-facing representation of one approval
 * (specification section 7, "Context firewall").
 *
 * Phase 4 will hand exactly this, plus the brief-only base, to one module
 * call. Phase 3 builds and tests it now so the isolation boundary is
 * established before any compiler depends on it. It carries no artist query,
 * no other slot, no unselected reference, and no dismissed proposal.
 */
export const ApprovedInfluencePayloadSchema = z.strictObject({
  slot: SlotSchema,
  approval_id: z.uuid(),
  approved_text: z.string().min(1).max(APPROVED_INTERPRETATION_MAX),
  intended_effect: z.string().min(1).max(INTENDED_INTERACTION_MAX),
  reference: z.strictObject({
    reference_id: z.string().min(1).max(64),
    name: z.string().min(1).max(300),
    domain: QlooDomainSchema,
    year: z.number().int().nullable(),
  }),
  evidence: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        field_path: z.string().min(1).max(120),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(MAX_SELECTED_EVIDENCE),
});

export type ApprovedInfluencePayload = z.infer<typeof ApprovedInfluencePayloadSchema>;
