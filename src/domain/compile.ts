/**
 * Compilation contracts (specification sections 4, 5, 8, and 11).
 *
 * Two kinds of contract live here, and the split is the whole point.
 *
 * **What a model may propose.** `BaseCompilationOutputSchema` and
 * `ModuleCompilationOutputSchema` describe the constrained game data a model
 * is allowed to control, and nothing else. There is no field for a scene id,
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
import { ConditionSchema, SceneSchema, VerbSchema } from "./scene";
import { SLOTS, TEXT } from "./limits";
import { ProjectViewSchema, ReferencesViewSchema, WorkflowStateSchema } from "./project";

/* ------------------------------------------------------- model-facing ids */

/**
 * An identifier as a model writes it: bounded, but not pattern-checked here.
 *
 * The authoritative `IdSchema` pattern and the namespace rules of
 * specification section 4 are applied by the server when it assembles the
 * candidate scene, so a malformed identifier becomes a readable validation
 * finding rather than a provider-side schema rejection this application
 * cannot see into.
 */
const ModelIdSchema = z.string().min(1).max(64);

/** A variable reference in an effect. The server supplies `op: "set_true"`. */
const ModelEffectSchema = z.strictObject({ var_id: ModelIdSchema });

const ModelVariableSchema = z.strictObject({
  id: ModelIdSchema,
  label: z.string().min(1).max(TEXT.variable_label),
  visible: z.boolean(),
});

const ModelDialogueSchema = z.strictObject({
  id: ModelIdSchema,
  speaker_id: ModelIdSchema,
  text: z.string().min(1).max(TEXT.dialogue),
});

const ModelBranchSchema = z.strictObject({
  when: ConditionSchema,
  effects: z.array(ModelEffectSchema),
  dialogue_id: ModelIdSchema.nullable(),
  ending_id: ModelIdSchema.nullable(),
});

/**
 * One action as a model writes it.
 *
 * `target` is absent on purpose. The action grammar of specification section 4
 * fixes it — `inspect`, `give`, and `withhold` address the object, `ask`
 * addresses the NPC, `leave` addresses the room — and the ids come from the
 * frozen brief, so the server derives the whole target.
 */
const ModelActionSchema = z.strictObject({
  id: ModelIdSchema,
  verb: VerbSchema,
  label: z.string().min(1).max(TEXT.action_label),
  when: ConditionSchema,
  branches: z.array(ModelBranchSchema),
});

const ModelEndingSchema = z.strictObject({
  id: ModelIdSchema,
  title: z.string().min(1).max(TEXT.ending_title),
  text: z.string().min(1).max(TEXT.ending_text),
});

/**
 * The brief-only base call's whole output.
 *
 * `title` is honoured only when the creator left the brief title empty; a
 * brief that names its title wins, because the world and the title are frozen
 * creator input rather than generated content.
 */
export const BaseCompilationOutputSchema = z.strictObject({
  title: z.string().min(1).max(TEXT.scene_title),
  variables: z.array(ModelVariableSchema),
  actions: z.array(ModelActionSchema),
  dialogue: z.array(ModelDialogueSchema),
  endings: z.array(ModelEndingSchema),
});

export type BaseCompilationOutput = z.infer<typeof BaseCompilationOutputSchema>;

const ModelGateSchema = z.strictObject({
  id: ModelIdSchema,
  action_id: ModelIdSchema,
  when: ConditionSchema,
  blocked_text: z.string().min(1).max(TEXT.gate_blocked_text),
});

/**
 * One hook, without the action it attaches to.
 *
 * A slot has exactly one effect port — `core.inspect` for discovery,
 * `core.ask_context` for commitment — so there is nothing for a module to
 * choose and no reason to let it name one. The server writes `action_id` from
 * {@link FIXED_PORTS} when it builds the module, for the same reason it writes
 * `slot` and `approval_id`: it already knows the only legal answer, and a field
 * a module cannot fill is a port it cannot mis-attach to.
 *
 * Gates keep their `action_id`, because the commitment slot really does have
 * two gate ports to choose between, and `GATE_PORT_INVALID` still checks it.
 */
const ModelOnActionSchema = z.strictObject({
  id: ModelIdSchema,
  when: ConditionSchema,
  effects: z.array(ModelEffectSchema),
  dialogue_id: ModelIdSchema.nullable(),
});

/**
 * One influence module call's whole output.
 *
 * There is no `slot` and no `approval_id` field: the server knows which slot
 * it asked for and which approval authorised the request, and a module cannot
 * claim either. There is no `influences` or `provenance` field either, so a
 * module cannot assert its own source or its own provenance binding.
 */
export const ModuleCompilationOutputSchema = z.strictObject({
  variables: z.array(ModelVariableSchema),
  actions: z.array(ModelActionSchema),
  dialogue: z.array(ModelDialogueSchema),
  gates: z.array(ModelGateSchema),
  on_actions: z.array(ModelOnActionSchema),
});

export type ModuleCompilationOutput = z.infer<typeof ModuleCompilationOutputSchema>;

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
  versions: z.array(SceneVersionSummarySchema).max(8),
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
