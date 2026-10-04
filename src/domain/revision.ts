/**
 * Targeted revision contracts (specification section 9).
 *
 * The revision unit is **one whole small influence module, or one ending's
 * wording**. It is never a whole scene and never an arbitrary JSON Patch, and
 * the shape of this union is what makes that structural rather than a rule
 * somebody has to remember: there is no field here for a scene, a core action,
 * a world entity, a condition, an effect, a gate, a port, a hash, a version id
 * to overwrite, or a validation verdict. A creator can name a slot, a proposal
 * the server already froze, their own wording, or one declared ending — and
 * nothing else.
 *
 * Five commands, mapping one-to-one onto the table in section 9:
 *
 * | Command | Model calls | What must stay identical |
 * |---|---|---|
 * | `remove` | 0 | base, world, other module, other approvals |
 * | `edit` | 1, in a later compilation of that slot only | base/world/other module hashes |
 * | `replace` | 1, in a later compilation of that slot only | unrelated definitions and accepted slots |
 * | `ending_copy_preview` | 1, text only | everything; a preview applies nothing |
 * | `ending_copy_apply` | 0 | every variable, condition, effect, action, and other ending |
 *
 * `remove` and `ending_copy_apply` are answered inside the revision route
 * itself, because both are deterministic recompositions of material the server
 * already holds. `edit` and `replace` append one immutable approval and then
 * tell the browser that a compilation is required: the existing Phase 4
 * controller recompiles the slot that moved and reuses the base and the other
 * slot's module by input hash, which is what makes "module-only
 * recompilation" a property of the idempotency key rather than a promise.
 */

import { z } from "zod";
import {
  APPROVED_INTERPRETATION_MAX,
  INTENDED_INTERACTION_MAX,
  MAX_SELECTED_EVIDENCE,
  SlotSchema,
} from "./influence";
import { SLOTS, TEXT } from "./limits";
import { ProjectViewSchema } from "./project";
import { codePointLength } from "./text";

/** How long a creator's ending-wording request may be. One sentence or two. */
export const COPY_REQUEST_MAX = 240;

/** Every revision command this application accepts, and no sixth. */
export const REVISION_KINDS = [
  "remove",
  "edit",
  "replace",
  "ending_copy_preview",
  "ending_copy_apply",
] as const;

export const RevisionKindSchema = z.enum(REVISION_KINDS);
export type RevisionKind = z.infer<typeof RevisionKindSchema>;

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

const CopyRequestSchema = z
  .string()
  .refine(
    (value) =>
      codePointLength(value.trim()) >= 3 && codePointLength(value.trim()) <= COPY_REQUEST_MAX,
    { message: `must be 3-${COPY_REQUEST_MAX} code points` },
  );

const EndingTextSchema = z
  .string()
  .refine(
    (value) =>
      codePointLength(value.trim()) >= 1 && codePointLength(value.trim()) <= TEXT.ending_text,
    { message: `must be 1-${TEXT.ending_text} code points` },
  );

const EvidenceNarrowingSchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(MAX_SELECTED_EVIDENCE);

const Base = { expected_revision: z.number().int().positive() } as const;

/**
 * `POST /api/projects/:id/revisions`.
 *
 * Note what `edit` does **not** take: a proposal id. An interpretation edit
 * re-approves the slot's **own** frozen proposal with new creator wording, so
 * it works whether or not today's proposal draft still exists and it cannot
 * silently attach a different reference's evidence. Attaching a different
 * reference is `replace`, which is a separate, explicit command.
 */
export const RevisionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...Base, kind: z.literal("remove"), slot: SlotSchema }),
  z.strictObject({
    ...Base,
    kind: z.literal("edit"),
    slot: SlotSchema,
    approved_text: ApprovedTextSchema,
    intended_effect: IntendedEffectSchema,
    /** A narrowing of the current approval's own evidence. Never a widening. */
    selected_evidence_ids: EvidenceNarrowingSchema.optional(),
  }),
  z.strictObject({
    ...Base,
    kind: z.literal("replace"),
    slot: SlotSchema,
    /** A proposal from this project's current draft, built on a stored capture. */
    proposal_id: z.string().min(1).max(64),
    approved_text: ApprovedTextSchema.optional(),
    intended_effect: IntendedEffectSchema.optional(),
    selected_evidence_ids: EvidenceNarrowingSchema.optional(),
  }),
  z.strictObject({
    ...Base,
    kind: z.literal("ending_copy_preview"),
    ending_id: z.string().min(1).max(64),
    /** The creator's explicit wording request, for example "make it kinder". */
    request: CopyRequestSchema,
  }),
  z.strictObject({
    ...Base,
    kind: z.literal("ending_copy_apply"),
    ending_id: z.string().min(1).max(64),
    /** Exactly the previewed wording. */
    text: EndingTextSchema,
    /** The hash the preview returned, so apply can only apply what was shown. */
    preview_hash: z.string().min(16).max(64),
  }),
]);

export type RevisionRequest = z.infer<typeof RevisionRequestSchema>;

/* -------------------------------------------------------- the stored diff */

/**
 * The `RevisionDiff` of specification section 9, as it is stored on the
 * immutable version row and returned to the browser.
 *
 * Every field is computed by the Phase 1 engine: `compareVersions` in
 * `src/engine/diff.ts` produces the structural comparison, the paired replay
 * witness, and the explicit same-choices replay. No model writes any of it, and
 * `mechanical_change` is true only when a replay demonstrated a changed legal
 * action availability or a changed reachable-ending set.
 */
export const GateBindingChangeViewSchema = z.strictObject({
  slot: SlotSchema,
  gate_id: z.string().min(1).max(64),
  action_id: z.string().min(1).max(64),
  /** True when the gate exists on that side at all. */
  present_before: z.boolean(),
  present_after: z.boolean(),
});

export const EffectBindingChangeViewSchema = z.strictObject({
  owner: z.string().min(1).max(32),
  definition_id: z.string().min(1).max(64),
  before: z.array(z.string().min(1).max(64)).max(12),
  after: z.array(z.string().min(1).max(64)).max(12),
});

export const CopyOnlyChangeViewSchema = z.strictObject({
  ending_id: z.string().min(1).max(64),
  /** Lengths only. The wording itself is already in the scene both sides of it. */
  before_length: z.number().int().nonnegative(),
  after_length: z.number().int().nonnegative(),
});

export const ReplayObservationViewSchema = z.strictObject({
  prefix: z.array(z.string().min(1).max(64)).max(16),
  prefix_legal_in_before: z.boolean(),
  prefix_legal_in_after: z.boolean(),
  changed_action_ids: z.array(z.string().min(1).max(64)).max(24),
  /** Availability after the prefix, per action, on each side. */
  before: z.record(z.string(), z.enum(["enabled", "locked", "hidden"])),
  after: z.record(z.string(), z.enum(["enabled", "locked", "hidden"])),
});

export type ReplayObservationView = z.infer<typeof ReplayObservationViewSchema>;

/** The label a revision receives. These two are never conflated. */
export const REVISION_LABELS = ["mechanical", "wording", "none"] as const;
export const RevisionLabelSchema = z.enum(REVISION_LABELS);
export type RevisionLabel = z.infer<typeof RevisionLabelSchema>;

export const RevisionDiffViewSchema = z.strictObject({
  before_version_id: z.uuid().nullable(),
  after_version_id: z.uuid().nullable(),
  /** The command that produced it, so a stored diff says what it came from. */
  changed_by: RevisionKindSchema.nullable(),
  changed_slots: z.array(SlotSchema).max(2),
  added_action_ids: z.array(z.string().min(1).max(64)).max(24),
  removed_action_ids: z.array(z.string().min(1).max(64)).max(24),
  changed_gate_bindings: z.array(GateBindingChangeViewSchema).max(8),
  changed_effect_bindings: z.array(EffectBindingChangeViewSchema).max(24),
  affected_endings: z.array(z.string().min(1).max(64)).max(3),
  copy_only_changes: z.array(CopyOnlyChangeViewSchema).max(3),
  /** Hash equality per untouched owned object. This is the preservation claim. */
  unchanged: z.strictObject({
    world: z.boolean(),
    core: z.boolean(),
    ports: z.boolean(),
    modules: z.partialRecord(SlotSchema, z.boolean()),
  }),
  hashes: z.strictObject({
    before_scene: z.string().max(64).nullable(),
    after_scene: z.string().max(64),
  }),
  label: RevisionLabelSchema,
  mechanical_change: z.boolean(),
  wording_change_only: z.boolean(),
  structure_identical: z.boolean(),
  /** True when the paired traversal hit its declared bound. */
  witness_overflow: z.boolean(),
  replay: ReplayObservationViewSchema.nullable(),
  /** At most three plain sentences, generated from the fields above. */
  summary: z.array(z.string().min(1).max(300)).max(3),
});

export type RevisionDiffView = z.infer<typeof RevisionDiffViewSchema>;

/* ---------------------------------------------------- response contracts */

/** The bounded ending-copy preview. A preview is not an application. */
export const EndingCopyPreviewSchema = z.strictObject({
  ending_id: z.string().min(1).max(64),
  /** The wording the scene currently shows for that ending. */
  current_text: z.string().min(1).max(TEXT.ending_text),
  proposed_text: z.string().min(1).max(TEXT.ending_text),
  /** Pass this back to apply, so apply can only apply what was shown. */
  preview_hash: z.string().min(16).max(64),
  /**
   * Always true, and always this sentence. A copy override cannot change a
   * gate, an effect, or an ending's reachability, so it is never labelled a
   * mechanical change (specification section 9).
   */
  wording_only: z.literal(true),
  model: z.string().min(1).max(80),
});

export type EndingCopyPreview = z.infer<typeof EndingCopyPreviewSchema>;

export const REVISION_OUTCOMES = [
  /** A new pending version was composed and validated with no provider call. */
  "version_pending",
  /** One immutable approval was appended; the slot must be recompiled. */
  "requires_compilation",
  /** A bounded text-only preview was produced and applied nothing. */
  "preview",
] as const;

export const RevisionOutcomeSchema = z.enum(REVISION_OUTCOMES);
export type RevisionOutcome = z.infer<typeof RevisionOutcomeSchema>;

/** Stable failure codes for a refused revision. Each names a real next step. */
export const REVISION_FAILURE_CODES = [
  "SLOT_EMPTY",
  "SLOT_OCCUPIED",
  "NO_ACTIVE_VERSION",
  "ENDING_UNKNOWN",
  "PREVIEW_MISMATCH",
  "PRESERVATION_VIOLATED",
  "VALIDATION_FAILED",
  "SUBSET_CONFLICT",
  "VALIDATION_RESOURCE_LIMIT",
  "STALE_INPUT",
  "MODEL_STAGE_FAILED",
  "ATTEMPTS_EXHAUSTED",
] as const;

export const RevisionFailureCodeSchema = z.enum(REVISION_FAILURE_CODES);
export type RevisionFailureCode = z.infer<typeof RevisionFailureCodeSchema>;

export const REVISION_FAILURE_MESSAGES: Readonly<Record<RevisionFailureCode, string>> = {
  SLOT_EMPTY: "That influence slot holds no approval, so there is nothing to change.",
  SLOT_OCCUPIED:
    "That influence slot already holds an approval. Replacing it is an explicit choice.",
  NO_ACTIVE_VERSION:
    "This project has no activated version yet, so there is nothing to revise. Build and confirm a scene first.",
  ENDING_UNKNOWN: "That ending is not one this scene declares.",
  PREVIEW_MISMATCH:
    "This wording is not the one that was previewed. Preview it again, then apply it.",
  PRESERVATION_VIOLATED:
    "This change would have altered definitions it does not own, so nothing was applied.",
  VALIDATION_FAILED:
    "The revised scene did not pass the interaction checks, so your active version is unchanged.",
  SUBSET_CONFLICT:
    "The remaining influences validate separately but not together, so this revision was not kept.",
  VALIDATION_RESOURCE_LIMIT:
    "Checking the revised scene reached its analysis limit, so it was not accepted.",
  STALE_INPUT:
    "Your choices changed while this request was in flight, so this older result was not applied.",
  MODEL_STAGE_FAILED:
    "This wording step did not return a usable result. Your scene is unchanged.",
  ATTEMPTS_EXHAUSTED:
    "This wording step used its attempts. Change the request and try again.",
};

export const RevisionResponseSchema = z.strictObject({
  outcome: RevisionOutcomeSchema,
  kind: RevisionKindSchema,
  project: ProjectViewSchema,
  /** The immutable decision this command appended, when it appended one. */
  decision_id: z.uuid().nullable(),
  /** The validated version awaiting review, when the command produced one. */
  pending_version_id: z.uuid().nullable(),
  /** Preserved across every refusal. */
  last_good_version_id: z.uuid().nullable(),
  /** The deterministic comparison against the version this one revised. */
  diff: RevisionDiffViewSchema.nullable(),
  preview: EndingCopyPreviewSchema.nullable(),
  /** Provider calls this request actually made. Zero for every command but one. */
  model_calls: z.number().int().nonnegative().max(1),
});

export type RevisionResponse = z.infer<typeof RevisionResponseSchema>;

/** The slot order the UI iterates, so no component invents one. */
export const REVISABLE_SLOTS = SLOTS;
