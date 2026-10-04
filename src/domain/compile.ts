/**
 * Compilation contracts (specification sections 4, 5, 8, and 11).
 *
 * Two kinds of contract live here, and the split is the whole point.
 *
 * **What a model may propose.** `BaseNarrativeCopySchema` and
 * `ModuleCompilationOutputSchema` describe the constrained material a model is
 * allowed to control, and nothing else. There is no field for a scene id,
 * an approval id, a source kind, a provenance binding, a schema version, a
 * port map, a world entity, a hash, a validation verdict, or a publication
 * state: the server assigns every one of those, so a returned object has
 * nowhere to put a forged authority claim (specification section 4). Even the
 * two smallest authorities are withheld — an effect names a variable and the
 * server supplies `set_true`, and an action names a verb and the server
 * derives the target from the frozen world — so a non-`set_true` effect and a
 * foreign target are not rejected values but unrepresentable ones.
 *
 * **What this application exposes.** The compilation status, the scene version
 * summary, the subset report, the mechanical witness summary, and the fourth
 * provenance line are all server-computed projections. Each one is derived
 * from the deterministic engine, never from a model describing its own output.
 *
 * The model-facing schemas deliberately follow the shape that phase 3's
 * proposal schema proved against the real provider: bounded strings, plain
 * enumerations, strict objects, and no array-length or pattern keyword. Counts,
 * identifier namespaces, and every budget are enforced afterwards by the
 * authoritative scene contract and the Phase 1 validator, which is where they
 * were always enforced.
 */

import { z } from "zod";
import { SceneSchema } from "./scene";
import { FIXED_PORTS, SLOTS, TEXT } from "./limits";
import { ProjectViewSchema, ReferencesViewSchema, WorkflowStateSchema } from "./project";
import { PublicationSummarySchema } from "./publish";
import { RevisionDiffViewSchema, RevisionLabelSchema } from "./revision";

/**
 * The brief-only base call's whole output: **narrative copy, and nothing else.**
 *
 * This is the Phase 4 recovery amendment, and it is deliberately the narrowest
 * schema in the application. The clean base's mechanics — its variable ids and
 * definitions, its six action ids, verbs, targets and availability conditions,
 * its one branch per action with that branch's effects and ending binding, its
 * three dialogue node ids and speakers, its three ending ids, and the port
 * table — are all fixed by the product contract, which means the model was
 * being asked to reproduce values that had exactly one legal answer. It did
 * not reliably reproduce them; `docs/PHASE4_EVIDENCE.md` records seven live
 * base failures across six distinct deterministic finding codes. The server
 * now constructs every one of those itself (`src/server/compile/base.ts`), and
 * this call asks only for the writing.
 *
 * Every field is a plain bounded string, keyed semantically rather than by an
 * executable identifier. There is therefore no field in which to put an id, a
 * namespace, a condition, a clause, an atom, a branch, an effect, a variable,
 * an extra action, or a fourth ending: those are not rejected values here, they
 * are unrepresentable ones, which is why the whole class of live base failure
 * cannot recur. The one exception by design is `title`, which is honoured only
 * when the creator left the brief title empty.
 *
 * The labels *are* purely presentational. Nothing reads an action label
 * programmatically: the engine, the validator, the port table, the witness
 * search, and the provenance binding all address an action by its
 * server-assigned id.
 */
export const BaseNarrativeCopySchema = z.strictObject({
  title: z.string().min(1).max(TEXT.scene_title),

  /** The six core actions' visible labels, in the fixed skeleton's order. */
  inspect_label: z.string().min(1).max(TEXT.action_label),
  ask_context_label: z.string().min(1).max(TEXT.action_label),
  ask_terms_label: z.string().min(1).max(TEXT.action_label),
  give_label: z.string().min(1).max(TEXT.action_label),
  withhold_label: z.string().min(1).max(TEXT.action_label),
  leave_label: z.string().min(1).max(TEXT.action_label),

  /** The three dialogue nodes' text. The server owns each node's id and speaker. */
  inspect_dialogue: z.string().min(1).max(TEXT.dialogue),
  context_dialogue: z.string().min(1).max(TEXT.dialogue),
  commitment_dialogue: z.string().min(1).max(TEXT.dialogue),

  /** The three endings' copy. The server owns the ending ids and the bindings. */
  give_ending_title: z.string().min(1).max(TEXT.ending_title),
  give_ending_text: z.string().min(1).max(TEXT.ending_text),
  keep_ending_title: z.string().min(1).max(TEXT.ending_title),
  keep_ending_text: z.string().min(1).max(TEXT.ending_text),
  leave_ending_title: z.string().min(1).max(TEXT.ending_title),
  leave_ending_text: z.string().min(1).max(TEXT.ending_text),
});

export type BaseNarrativeCopy = z.infer<typeof BaseNarrativeCopySchema>;

/** Every field of the base copy contract, for the tests that enumerate them. */
export const BASE_NARRATIVE_COPY_FIELDS = Object.keys(
  BaseNarrativeCopySchema.shape,
) as readonly (keyof BaseNarrativeCopy)[];

/* --------------------------------------------- the influence module contract */

/**
 * Who speaks a line a module writes.
 *
 * Three legal answers, so this is a real choice with a strict enumeration
 * rather than a free identifier. `character` resolves to the brief's one
 * declared NPC; the server substitutes its id, so `SPEAKER_UNRESOLVED` is not
 * a rejected value but an unrepresentable one.
 */
export const MODULE_SPEAKERS = ["player", "narrator", "character"] as const;
export const ModuleSpeakerSchema = z.enum(MODULE_SPEAKERS);
export type ModuleSpeaker = z.infer<typeof ModuleSpeakerSchema>;

/** The two verbs a module action may use. The other three are terminal. */
export const MODULE_VERBS = ["inspect", "ask"] as const;

/** Every gate port, across both slots, for the slot-agnostic exported type. */
const ALL_GATE_PORTS = [
  ...FIXED_PORTS.discovery.gate_action_ids,
  ...FIXED_PORTS.commitment.gate_action_ids,
] as const;

/** An extra line a mechanic attaches to its slot's one effect port. */
const ModuleHookSchema = z.strictObject({
  dialogue_speaker: ModuleSpeakerSchema,
  dialogue_text: z.string().min(1).max(TEXT.dialogue),
});

/**
 * One mechanic: a flag, the action that sets it, and the base action it gates.
 *
 * This is the Phase 4 module amendment, and it is the base amendment's
 * principle applied to the one stage that still had the model author a state
 * machine. The classification it comes from is in
 * `docs/PHASE4_EVIDENCE.md`: every field below is one of
 *
 *   * **single-answer plumbing, now server-owned and absent here** — every
 *     identifier and namespace, the action's target, the action's availability
 *     condition, its single branch and that branch's `when`, the effect that
 *     sets the flag, the flag's `initial: false`, the gate's condition, the
 *     hook's port, the absence of an ending binding, and the dialogue node
 *     ids. Each had exactly one legal form under the product contract, and the
 *     live record shows the model failing to reproduce several of them:
 *     `FOREIGN_WRITE`, `VARIABLE_NEVER_READ`, `VARIABLE_NEVER_WRITTEN`,
 *     `HOOK_PORT_INVALID`, `NAMESPACE_INVALID`, `MODULE_ACTION_TERMINATES`.
 *   * **a genuine bounded mechanical choice, kept here** — how many mechanics
 *     to build, whether each is an `inspect` or an `ask`, which base action it
 *     gates (the commitment slot really has two), whether it also attaches a
 *     line to its slot's effect port, and whether its flag is shown to the
 *     player.
 *   * **copy** — the labels and the lines.
 *
 * What the module does mechanically is therefore still the model's decision,
 * made from its isolated approved-influence context; how that decision is
 * wired into the engine is not. The validator is unchanged, and still decides
 * whether the result is acceptable: a mechanic that gates nothing reachable,
 * a module that exceeds a budget, or forbidden wording are all still findings.
 */
function moduleMechanicSchema<P extends readonly [string, ...string[]]>(ports: P) {
  return z.strictObject({
    /** `inspect` or `ask`. The terminal verbs belong to the foundation. */
    verb: z.enum(MODULE_VERBS),
    action_label: z.string().min(1).max(TEXT.action_label),
    /** The flag's human label. Its identifier is the server's. */
    flag_label: z.string().min(1).max(TEXT.variable_label),
    /** Whether the player sees this flag in the state readout. */
    flag_visible: z.boolean(),
    dialogue_speaker: ModuleSpeakerSchema,
    dialogue_text: z.string().min(1).max(TEXT.dialogue),
    /**
     * The foundation action this mechanic gates, which is what makes it
     * mechanical rather than decorative. The enumeration is this slot's own
     * ports, so `GATE_PORT_INVALID` cannot be expressed.
     */
    gate_port: z.enum(ports),
    gate_blocked_text: z.string().min(1).max(TEXT.gate_blocked_text),
    /** An extra line on the slot's effect port, or null for none. */
    hook: ModuleHookSchema.nullable(),
  });
}

/**
 * One influence module call's whole output.
 *
 * There is no `slot` and no `approval_id` field: the server knows which slot
 * it asked for and which approval authorised the request, and a module cannot
 * claim either. There is no `influences` or `provenance` field either, so a
 * module cannot assert its own source or its own provenance binding.
 */
export const ModuleCompilationOutputSchema = z.strictObject({
  mechanics: z.array(moduleMechanicSchema(ALL_GATE_PORTS)),
});

export type ModuleCompilationOutput = z.infer<typeof ModuleCompilationOutputSchema>;
export type ModuleMechanic = ModuleCompilationOutput["mechanics"][number];

/**
 * The contract for one slot, with `gate_port` narrowed to that slot's own
 * ports. Discovery has exactly one, so Structured Outputs forces it; the
 * commitment slot has two, so the choice is the model's.
 */
export function moduleOutputSchemaFor(slot: (typeof SLOTS)[number]) {
  return z.strictObject({
    mechanics: z.array(moduleMechanicSchema(FIXED_PORTS[slot].gate_action_ids)),
  });
}

/* ------------------------------------------------- the ending-copy contract */

/**
 * One ending-copy call's whole output: **one string.**
 *
 * This is the narrowest model-facing contract in the application, and it is
 * narrow for a reason that is not economy. Specification section 9 is explicit
 * that making an ending kinder is a *writing* judgement, that it is labelled a
 * wording change and never a mechanical one, and that it "can never rewrite a
 * gate or make an ending reachable". With one text field and nothing else,
 * that is not a rule this application enforces afterwards — it is the only
 * thing the call is able to return. There is no field for an ending id (the
 * server knows which ending it asked about), no field for a condition, an
 * effect, a variable, an action, a second ending, a provenance claim, or a
 * label asserting the change was mechanical.
 */
export const EndingCopyOutputSchema = z.strictObject({
  text: z.string().min(1).max(TEXT.ending_text),
});

export type EndingCopyOutput = z.infer<typeof EndingCopyOutputSchema>;

/* ---------------------------------------------------- compilation stages */

/**
 * The compilation segment of the specification section 8 state machine.
 *
 * These are the persisted controller states, not a list of agents. The
 * controller — never the browser — decides which one comes next.
 */
export const COMPILATION_STATES = [
  "AWAITING_APPROVAL",
  "BASE_READY",
  "MODULES_READY",
  "VALIDATING",
  "REVIEW_PLAYABLE",
  "READY",
  "FAILED",
] as const;

export const CompilationStateSchema = z.enum(COMPILATION_STATES);
export type CompilationState = z.infer<typeof CompilationStateSchema>;

/**
 * The model stages a compilation can run, in their only legal order.
 *
 * `validate` performs no provider call at all: it is deterministic work the
 * controller does in one advance so the browser sees a truthful stage rather
 * than a validated version appearing out of nowhere.
 */
export const COMPILATION_STAGES = [
  "base",
  "module_discovery",
  "module_commitment",
  "validate",
] as const;

export const CompilationStageSchema = z.enum(COMPILATION_STAGES);
export type CompilationStage = z.infer<typeof CompilationStageSchema>;

/** The creator-facing stage wording, locked here so no component invents one. */
export const STAGE_LABELS: Readonly<Record<CompilationStage, string>> = {
  base: "Writing encounter",
  module_discovery: "Building Discovery",
  module_commitment: "Building Commitment",
  validate: "Checking choices",
};

/** Stable failure codes. Each one is a finished state with a real next step. */
export const COMPILATION_FAILURE_CODES = [
  /** No approval is active, so there is nothing to compile. */
  "NO_ACTIVE_APPROVAL",
  /** An approval's stored evidence could not be authoritatively rebuilt. */
  "MISSING_APPROVED_EVIDENCE",
  /** The provider declined, failed, truncated, or returned unusable output. */
  "MODEL_STAGE_FAILED",
  /** The candidate failed the deterministic validator after its one repair. */
  "VALIDATION_FAILED",
  /** Each module validates alone but the composed set does not. */
  "SUBSET_CONFLICT",
  /** Graph or witness analysis hit its declared ceiling. */
  "VALIDATION_RESOURCE_LIMIT",
  /** The creator's approvals moved while the stage was in flight. */
  "STALE_INPUT",
  /** The stage used its one normal attempt and its one permitted repair. */
  "ATTEMPTS_EXHAUSTED",
] as const;

export const CompilationFailureCodeSchema = z.enum(COMPILATION_FAILURE_CODES);
export type CompilationFailureCode = z.infer<typeof CompilationFailureCodeSchema>;

/* ------------------------------------------------- persisted checkpoint */

/**
 * One frozen compilation input snapshot.
 *
 * Everything here is an identifier or a hash. There is no approved wording, no
 * evidence text, no brief prose, and no owner session id, because this value
 * is returned to the browser inside the bounded operation summary.
 */
export const CompilationSnapshotSchema = z.strictObject({
  project_id: z.uuid(),
  project_revision: z.number().int().positive(),
  brief_hash: z.string().min(16).max(64),
  /** The clean base this compilation will reuse, when one already exists. */
  base_hash: z.string().min(16).max(64).nullable(),
  approvals: z
    .array(
      z.strictObject({
        slot: z.enum(SLOTS),
        approval_id: z.uuid(),
        /** Hash of the exact compiler-facing payload this approval produces. */
        input_hash: z.string().min(16).max(64),
      }),
    )
    .min(1)
    .max(2),
  model: z.string().min(1).max(80),
  compiler_identifier: z.string().min(1).max(80),
  prompt_identifier: z.string().min(1).max(80),
  schema_identifier: z.string().min(1).max(80),
  validator_identifier: z.string().min(1).max(80),
  frozen_at: z.string(),
});

export type CompilationSnapshot = z.infer<typeof CompilationSnapshotSchema>;

export const StageCheckpointSchema = z.strictObject({
  status: z.enum(["pending", "committed", "failed"]),
  /** Provider attempts this stage has actually spent. At most two. */
  attempts: z.number().int().nonnegative().max(2),
  /** True when the one permitted structural repair produced the result. */
  repaired: z.boolean(),
  /** Canonical hash of the committed artifact, for the version record. */
  artifact_hash: z.string().min(16).max(64).nullable(),
  /** This application's own stable code. Never a provider message. */
  failure_code: CompilationFailureCodeSchema.nullable(),
});

export type StageCheckpoint = z.infer<typeof StageCheckpointSchema>;

/**
 * The persisted controller checkpoint, stored in the compile operation's
 * bounded result column and returned by `GET /api/operations/:id`.
 *
 * It holds only identifiers, hashes, counters, and this application's own
 * codes, so the whole document is safe to return and small enough to fit the
 * operation row's 16 KiB ceiling.
 */
export const CompilationCheckpointSchema = z.strictObject({
  snapshot: CompilationSnapshotSchema,
  state: CompilationStateSchema,
  /** Partial: only the stages this compilation actually has are present. */
  stages: z.partialRecord(CompilationStageSchema, StageCheckpointSchema),
  /** The pending version this compilation produced, once it has one. */
  version_id: z.uuid().nullable(),
  failure: z
    .strictObject({
      code: CompilationFailureCodeSchema,
      stage: CompilationStageSchema.nullable(),
    })
    .nullable(),
  /** Provider calls this compilation has spent in total. */
  model_calls: z.number().int().nonnegative().max(8),
});

export type CompilationCheckpoint = z.infer<typeof CompilationCheckpointSchema>;

/* -------------------------------------------------- validation projections */

export const SubsetReportViewSchema = z.strictObject({
  /** The active slots in this subset. The empty list is the clean base. */
  slots: z.array(z.enum(SLOTS)),
  ok: z.boolean(),
  /** This application's own finding codes, never a prose dump. */
  finding_codes: z.array(z.string().min(1).max(64)).max(32),
});

export type SubsetReportView = z.infer<typeof SubsetReportViewSchema>;

/**
 * One module's mechanical witness, as the review screen and the provenance
 * drawer read it.
 *
 * `sentence` is generated from the observation's own fields by
 * `describeWitness`, which is deterministic engine output. No model writes it,
 * and nothing here asserts the mechanic is good, original, or uniquely
 * attributable to any source.
 */
export const WitnessSummaryViewSchema = z.strictObject({
  slot: z.enum(SLOTS),
  approval_id: z.string().min(1).max(64),
  mechanical: z.boolean(),
  kind: z.enum(["action_availability", "ending_reachability", "action_set"]).nullable(),
  action_id: z.string().min(1).max(64).nullable(),
  /** The legal replay prefix that reaches the observation. */
  prefix: z.array(z.string().min(1).max(64)).max(16),
  before: z.string().min(1).max(200),
  after: z.string().min(1).max(200),
  sentence: z.string().min(1).max(300),
  pairs_explored: z.number().int().nonnegative(),
});

export type WitnessSummaryView = z.infer<typeof WitnessSummaryViewSchema>;

export const ValidationSummaryViewSchema = z.strictObject({
  ok: z.boolean(),
  active_slots: z.array(z.enum(SLOTS)),
  finding_codes: z.array(z.string().min(1).max(64)).max(32),
  reachable_endings: z.array(z.string().min(1).max(64)).max(3),
  reachable_nonterminal_states: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  /** Every supported removal subset, base first. At most four. */
  subsets: z.array(SubsetReportViewSchema).max(4),
  witnesses: z.array(WitnessSummaryViewSchema).max(2),
  notes: z.array(z.string().min(1).max(400)).max(8),
});

export type ValidationSummaryView = z.infer<typeof ValidationSummaryViewSchema>;

/* ------------------------------------------------------- version records */

/**
 * The reviewable state of one immutable scene version, derived from the
 * project's own pointers rather than stored on the version row.
 *
 * A version's bytes never change, which is why "pending" and "active" are
 * computed here: `pending` is the project's `pending_version_id`, `active` is
 * its `active_version_id`, and `superseded` is every earlier version.
 */
export const VERSION_STATES = ["pending", "active", "superseded"] as const;
export const VersionStateSchema = z.enum(VERSION_STATES);
export type VersionState = z.infer<typeof VersionStateSchema>;

export const SceneVersionSummarySchema = z.strictObject({
  id: z.uuid(),
  parent_version_id: z.uuid().nullable(),
  state: VersionStateSchema,
  created_at: z.string(),
  base_hash: z.string().min(16).max(64),
  module_hashes: z.partialRecord(z.enum(SLOTS), z.string().min(16).max(64)),
  active_slots: z.array(z.enum(SLOTS)),
  model_identifier: z.string().max(80).nullable(),
  compiler_identifier: z.string().max(80).nullable(),
  validator_identifier: z.string().max(80).nullable(),
  /**
   * The label this version's stored comparison carries, or null for a first
   * version and for one whose diff is not readable. It is the engine's own
   * verdict, read off the stored diff rather than recomputed for a list.
   */
  revision_label: RevisionLabelSchema.nullable(),
});

export type SceneVersionSummary = z.infer<typeof SceneVersionSummarySchema>;

/**
 * The fourth provenance line of specification section 13.
 *
 * It exists only when a validated module and a computed mechanical witness
 * exist, and its sentence comes from the engine's own observation. It carries
 * no claim that the retrieval source generated the mechanic, proved the scene
 * better, or could not have been invented another way.
 */
export const SceneChangedViewSchema = z.strictObject({
  approval_id: z.string().min(1).max(64),
  slot: z.enum(SLOTS),
  /** The module-owned action, gate, and hook ids this approval is bound to. */
  mechanic_ids: z.array(z.string().min(1).max(64)).max(16),
  witness: WitnessSummaryViewSchema,
});

export type SceneChangedView = z.infer<typeof SceneChangedViewSchema>;

/**
 * One playable version, ready for the browser to run through the Phase 1
 * engine with no further request of any kind.
 */
export const PlayableViewSchema = z.strictObject({
  version_id: z.uuid(),
  state: VersionStateSchema,
  created_at: z.string(),
  scene: SceneSchema,
  validation: ValidationSummaryViewSchema,
  scene_changed: z.array(SceneChangedViewSchema).max(2),
  /**
   * This version's stored comparison against the one it revised, or null for a
   * first version. It travels with the playable because the comparison the
   * creator is shown must be the one the server computed and stored, not one
   * the browser derived from two scenes it happens to hold.
   */
  diff: RevisionDiffViewSchema.nullable(),
});

export type PlayableView = z.infer<typeof PlayableViewSchema>;

/* ----------------------------------------------------- request contracts */

/**
 * `POST /api/projects/:id/compile`.
 *
 * One field. No prompt, no model name, no stage, no scene, no approval, and no
 * evidence: every input comes from the server's own frozen snapshot, which is
 * what keeps this from being an arbitrary prompt endpoint.
 */
export const CompileRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
});

export type CompileRequest = z.infer<typeof CompileRequestSchema>;

/**
 * `POST /api/operations/:id/advance`.
 *
 * Deliberately empty. The browser asks for *the next* stage; it cannot name
 * one. The controller chooses the only legal transition (specification
 * section 8).
 */
export const AdvanceRequestSchema = z.strictObject({});

export type AdvanceRequest = z.infer<typeof AdvanceRequestSchema>;

/**
 * `POST /api/projects/:id/activate`.
 *
 * The creator names the version they reviewed and the revision they reviewed
 * it against. `decline` preserves the previous active version instead.
 */
export const ActivateRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  version_id: z.uuid(),
  decline: z.boolean().optional(),
});

export type ActivateRequest = z.infer<typeof ActivateRequestSchema>;

/* ---------------------------------------------------- response contracts */

export const CompilationStatusSchema = z.strictObject({
  operation_id: z.uuid(),
  state: CompilationStateSchema,
  /** The stage the next advance will run, or null when none remains. */
  next_stage: CompilationStageSchema.nullable(),
  next_stage_label: z.string().max(60).nullable(),
  stages: z.array(
    z.strictObject({
      stage: CompilationStageSchema,
      label: z.string().min(1).max(60),
      status: z.enum(["waiting", "pending", "committed", "failed"]),
      attempts: z.number().int().nonnegative().max(2),
      repaired: z.boolean(),
    }),
  ),
  model_calls: z.number().int().nonnegative().max(8),
  version_id: z.uuid().nullable(),
  failure: z
    .strictObject({
      code: CompilationFailureCodeSchema,
      stage: CompilationStageSchema.nullable(),
      message: z.string().min(1).max(300),
    })
    .nullable(),
  /** The project's own workflow state, so the UI never has to infer it. */
  workflow_state: WorkflowStateSchema,
  /** Preserved across every failure. Null until the first activation. */
  last_good_version_id: z.uuid().nullable(),
});

export type CompilationStatus = z.infer<typeof CompilationStatusSchema>;

export const CompileResponseSchema = z.strictObject({
  status: CompilationStatusSchema,
  /** True when an idempotent retry returned the already-reserved operation. */
  replayed: z.boolean(),
});

export type CompileResponse = z.infer<typeof CompileResponseSchema>;

export const AdvanceResponseSchema = z.strictObject({
  status: CompilationStatusSchema,
  /** Provider attempts this one request made. Never more than one. */
  model_calls: z.number().int().nonnegative().max(1),
  /** True when this advance replayed a stage that was already committed. */
  replayed: z.boolean(),
});

export type AdvanceResponse = z.infer<typeof AdvanceResponseSchema>;

export const ActivateResponseSchema = z.strictObject({
  outcome: z.enum(["activated", "already_active", "declined"]),
  active_version_id: z.uuid().nullable(),
  pending_version_id: z.uuid().nullable(),
  workflow_state: WorkflowStateSchema,
});

export type ActivateResponse = z.infer<typeof ActivateResponseSchema>;

/**
 * `GET /api/projects/:id`, from phase 4 onward.
 *
 * The phase 3 response is this one minus `playable` and `versions`. Those two
 * fields are what let the browser run the compiled scene through the Phase 1
 * engine with no further request: the whole validated scene arrives once, and
 * every subsequent choice and reset is local.
 */
export const ProjectStateResponseSchema = z.strictObject({
  project: ProjectViewSchema,
  references: ReferencesViewSchema.nullable(),
  /** The pending version awaiting review, else the active one, else null. */
  playable: PlayableViewSchema.nullable(),
  /**
   * The version `playable` revised, when it names one that is still readable.
   *
   * Phase 5 sends both sides of the comparison in one payload for the same
   * reason Phase 4 sends the whole scene: the previous/current switch and the
   * "replay the same choices" control then run entirely locally through the
   * Phase 1 engine, with no further request of any kind.
   */
  previous_playable: PlayableViewSchema.nullable(),
  versions: z.array(SceneVersionSummarySchema).max(8),
  /** This project's share links. Never a token, only whether one is live. */
  publications: z.array(PublicationSummarySchema).max(8),
});

export type ProjectStateResponse = z.infer<typeof ProjectStateResponseSchema>;

/** Human-readable text for a failure code. Fixed sentences, never provider text. */
export const FAILURE_MESSAGES: Readonly<Record<CompilationFailureCode, string>> = {
  NO_ACTIVE_APPROVAL:
    "Approve at least one interaction before building a playable scene.",
  MISSING_APPROVED_EVIDENCE:
    "The evidence behind one of your approvals could not be read back, so nothing was generated. Approve that interaction again.",
  MODEL_STAGE_FAILED:
    "This step did not return a usable result. Your brief and approvals are unchanged.",
  VALIDATION_FAILED:
    "This draft did not pass the interaction checks. Edit or remove the approval and build again.",
  SUBSET_CONFLICT:
    "The two influences validate separately but not together, so this draft was not kept.",
  VALIDATION_RESOURCE_LIMIT:
    "Checking this draft reached its analysis limit, so it was not accepted.",
  STALE_INPUT:
    "Your choices changed while this was being written, so this older result was not applied.",
  ATTEMPTS_EXHAUSTED:
    "This step used its attempts. Edit or remove the approval and build again.",
};
