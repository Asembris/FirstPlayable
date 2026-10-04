/**
 * Assembly: turning constrained model output into an authoritative candidate
 * scene (specification sections 4 and 9).
 *
 * The server assigns every authority. A module proposes variables, actions,
 * dialogue, gates, and hooks; this module supplies the schema version, the
 * scene id, the whole world, the fixed port table, the effect operator, each
 * action's target, each module's slot and approval binding, the influence
 * references with their source kinds, and the provenance bindings.
 *
 * The clean base is no longer in that list at all. Since the Phase 4 recovery
 * amendment its every mechanical element is constructed by
 * `src/server/compile/base.ts` from the frozen brief, and the model contributes
 * only the writing. Assembly therefore receives a `CoreScene` it can trust to
 * be structurally fixed, and still submits it to the Phase 1 validator
 * unchanged — see the note on totality below.
 *
 * Two of those are worth naming explicitly, because they remove a class of
 * forgery rather than rejecting it:
 *
 *   * **`set_true` is not a value a model chooses.** Model output names a
 *     variable; `op: "set_true"` is written here. There is no other effect
 *     operator in the contract and no field in which to request one.
 *   * **A target is derived, never supplied.** The action grammar fixes the
 *     entity kind per verb and the frozen brief fixes the ids, so an action
 *     addressing a second character or an undeclared object is not a rejected
 *     value but an unrepresentable one.
 *
 * Assembly is deliberately *total*: it never inspects whether the result is
 * valid. A malformed identifier, a missing core action, a cross-slot read, a
 * fourth ending, or an over-budget module all pass through here and are
 * decided by the Phase 1 validator, which reports them as readable findings.
 * Nothing in this file is a second validator.
 */

import type { Brief } from "@/domain/brief";
import type { ModuleCompilationOutput } from "@/domain/compile";
import type { ApprovedInfluence, Slot } from "@/domain/influence";
import { FIXED_PORTS, SLOTS, VERB_TARGET_KIND } from "@/domain/limits";
import type {
  Action,
  ActionBranch,
  CoreScene,
  DialogueNode,
  Effect,
  Gate,
  InfluenceModule,
  InfluenceReference,
  OnAction,
  Provenance,
  Scene,
  StateVariable,
  Target,
  World,
} from "@/domain/scene";
import { safeParseScene } from "@/domain/scene";
import { hashCanonical, sha256Hex } from "@/engine/hash";

/* ----------------------------------------------------------------- world */

/**
 * The world, built from the frozen brief alone.
 *
 * Every field is copied. Nothing a model returned reaches this value, which is
 * why the validator's brief comparison can only fail if the brief itself
 * changed under the compilation — and that is exactly what the compare-and-swap
 * check is for.
 */
export function worldFromBrief(brief: Brief): World {
  return {
    player_role: brief.player_role,
    room: { id: brief.room.id, name: brief.room.name, description: brief.room.description },
    characters: [
      { id: brief.character.id, name: brief.character.name, role: brief.character.role },
    ],
    object: {
      id: brief.object.id,
      name: brief.object.name,
      description: brief.object.description,
    },
  };
}

/**
 * The target an action addresses, derived from the verb and the frozen world.
 *
 * Exported because the deterministic base skeleton needs the same derivation,
 * and a second copy of the verb-to-entity table is exactly the kind of drift
 * that `CORE_VERB_MISMATCH` would then have to catch at runtime.
 */
export function targetFor(verb: string, world: World): Target {
  const kind = VERB_TARGET_KIND[verb as keyof typeof VERB_TARGET_KIND];
  switch (kind) {
    case "room":
      return { kind: "room", id: world.room.id };
    case "character":
      return { kind: "character", id: world.characters[0].id };
    default:
      return { kind: "object", id: world.object.id };
  }
}

/* ------------------------------------------------------------ conversions */

/**
 * The id a module's effect resolves to when it names a position that does not
 * exist in its own `variables` array.
 *
 * It is deliberately a legal-looking identifier that is certain not to be
 * declared, so the Phase 1 validator reports it as `VAR_UNRESOLVED` against
 * this exact name. An out-of-range index therefore becomes one readable,
 * repairable finding rather than a thrown error or a silently dropped effect:
 * dropping it would change what the module does, and a branch that sets
 * nothing is a different failure with a misleading code.
 */
export function unresolvedEffectTargetId(slot: Slot): string {
  return `${slot}.effect_target_out_of_range`;
}

/**
 * Effects, resolved against the module's own declared variables.
 *
 * `op: "set_true"` is written here, never read from model output, and the
 * target is looked up by the index the model gave rather than copied from a
 * string it chose. A module consequently cannot write the foundation's state,
 * or the other slot's, in any way the contract can express.
 */
function toEffects(
  effects: readonly { variable_index: number }[],
  declared: readonly { id: string }[],
  slot: Slot,
): Effect[] {
  return effects.map((effect) => ({
    op: "set_true",
    var_id: declared[effect.variable_index]?.id ?? unresolvedEffectTargetId(slot),
  }));
}

function toVariables(
  variables: readonly { id: string; label: string; visible: boolean }[],
): StateVariable[] {
  // `initial: false` is a contract literal: every flag begins false.
  return variables.map((variable) => ({
    id: variable.id,
    label: variable.label,
    initial: false,
    visible: variable.visible,
  }));
}

function toDialogue(
  dialogue: readonly { id: string; speaker_id: string; text: string }[],
): DialogueNode[] {
  return dialogue.map((node) => ({
    id: node.id,
    speaker_id: node.speaker_id,
    text: node.text,
  }));
}

type ModelBranch = ModuleCompilationOutput["actions"][number]["branches"][number];
type ModelAction = ModuleCompilationOutput["actions"][number];

function toBranch(
  branch: ModelBranch,
  declared: readonly { id: string }[],
  slot: Slot,
): ActionBranch {
  return {
    when: branch.when,
    effects: toEffects(branch.effects, declared, slot),
    dialogue_id: branch.dialogue_id,
    ending_id: branch.ending_id,
  };
}

function toAction(
  action: ModelAction,
  world: World,
  declared: readonly { id: string }[],
  slot: Slot,
): Action {
  return {
    id: action.id,
    verb: action.verb,
    label: action.label,
    target: targetFor(action.verb, world),
    when: action.when,
    branches: action.branches.map((branch) => toBranch(branch, declared, slot)),
  };
}

/* ------------------------------------------------------------ the module */

/**
 * One module, with its slot and its approval binding written by the server.
 *
 * `approvalId` is the authoritative decision row id the controller authorised
 * this stage with; the scene-level form is derived here rather than by the
 * caller, so a call site cannot bind a module to a raw database id or to an
 * approval of its own choosing. A module has no field in which to name an
 * approval at all, so it cannot bind itself to one the creator did not make.
 */
export function moduleFromModelOutput(
  output: ModuleCompilationOutput,
  slot: Slot,
  approvalId: string,
  world: World,
): InfluenceModule {
  const gates: Gate[] = output.gates.map((gate) => ({
    id: gate.id,
    action_id: gate.action_id,
    when: gate.when,
    blocked_text: gate.blocked_text,
  }));
  // The slot's one effect port, written here rather than taken from the
  // module. A module has no field in which to name an attachment point, so it
  // cannot attach to the other slot's port even by mistake.
  const hookPort = FIXED_PORTS[slot].effect_action_ids[0];
  const hooks: OnAction[] = output.on_actions.map((hook) => ({
    id: hook.id,
    action_id: hookPort,
    when: hook.when,
    effects: toEffects(hook.effects, output.variables, slot),
    dialogue_id: hook.dialogue_id,
  }));
  return {
    slot,
    approval_id: sceneApprovalId(approvalId),
    variables: toVariables(output.variables),
    actions: output.actions.map((action) => toAction(action, world, output.variables, slot)),
    dialogue: toDialogue(output.dialogue),
    gates,
    on_actions: hooks,
  };
}

/** The module-owned ids one approval is bound to, in a stable order. */
export function mechanicIdsOf(module: InfluenceModule): string[] {
  return [
    ...module.actions.map((action) => action.id),
    ...module.gates.map((gate) => gate.id),
    ...module.on_actions.map((hook) => hook.id),
  ];
}

/* ------------------------------------------------- scene-level identifiers */

/**
 * Scene-level identifiers are opaque application ids, not database ids
 * (specification section 4, "Identifier resolution").
 *
 * An approval's authoritative id is its immutable `influence_decisions` row's
 * UUID, which starts with a digit and so is not a legal scene identifier. The
 * scene therefore carries a derived, reversible form: the prefix plus the
 * UUID's own characters. Reversible matters, because the frozen approval
 * allowlist the validator checks against is built with the same function, so
 * "this scene cannot authorize itself" stays a comparison of equal things.
 *
 * Anything outside the identifier alphabet becomes a hyphen. That is a
 * defensive normalization for ids this application assigned, not a place where
 * model output enters: `approval_id` and `reference_id` are both copied from
 * the frozen decision.
 */
const ID_ALPHABET = /[^a-z0-9_.-]+/gu;

function opaqueSceneId(prefix: string, value: string): string {
  const normalized = value.toLowerCase().replace(ID_ALPHABET, "-");
  return `${prefix}${normalized}`.slice(0, 64);
}

/** The scene-level form of one approval id. */
export function sceneApprovalId(approvalId: string): string {
  return opaqueSceneId("approval.", approvalId);
}

/** The scene-level form of one application reference id. */
export function sceneReferenceId(referenceId: string): string {
  return opaqueSceneId("ref.", referenceId.replace(/^ref\./u, ""));
}

/** The frozen allowlist, in the form the composed scene uses. */
export function sceneApprovalAllowlist(
  approvals: readonly { approval_id: string }[],
): string[] {
  return approvals.map((approval) => sceneApprovalId(approval.approval_id));
}

/* ----------------------------------------------------------- the scene id */

/**
 * A deterministic scene id.
 *
 * Derived from the frozen compilation input, so recompiling the same inputs
 * cannot mint a different identity, and two concurrent attempts on the same
 * snapshot agree. The model never supplies it.
 */
export function sceneIdFor(inputHash: string): string {
  return `scene.${sha256Hex(inputHash).slice(0, 24)}`;
}

/* ------------------------------------------------------------- the scene */

export type AssembleInput = {
  readonly brief: Brief;
  readonly inputHash: string;
  /** The clean core, either freshly compiled or read back from the project. */
  readonly core: CoreScene;
  /** The title the base stage produced, used only when the brief has none. */
  readonly generatedTitle: string;
  readonly modules: readonly InfluenceModule[];
  /** The approvals the controller froze. One per compiled module. */
  readonly approvals: readonly ApprovedInfluence[];
};

export type AssembleResult =
  | { readonly ok: true; readonly scene: Scene }
  | { readonly ok: false; readonly findings: { code: string; detail: string }[] };

/**
 * Builds the candidate scene.
 *
 * The world, the ports, the influence references, and the provenance bindings
 * are all written here from frozen server state. An approval with no compiled
 * module contributes neither a reference nor a binding, and a module with no
 * frozen approval is dropped rather than carried with an invented one — which
 * keeps the validator's orphan checks about real inconsistency rather than
 * about assembly order.
 *
 * Returns the schema findings when the assembled value does not satisfy the
 * authoritative contract. Those findings are this application's own and are
 * exactly what the one permitted repair is shown.
 */
export function assembleScene(input: AssembleInput): AssembleResult {
  const world = worldFromBrief(input.brief);
  const approvalBySlot = new Map(
    input.approvals.map((approval) => [approval.slot, approval] as const),
  );

  // Fixed slot order, never array order, so the same inputs hash identically.
  const modules = SLOTS.flatMap((slot) => {
    const module = input.modules.find((candidate) => candidate.slot === slot);
    if (module === undefined) return [];
    return approvalBySlot.has(slot) ? [module] : [];
  });

  const influences: InfluenceReference[] = [];
  const provenance: Provenance[] = [];
  for (const module of modules) {
    const approval = approvalBySlot.get(module.slot);
    if (approval === undefined) continue;
    influences.push({
      approval_id: sceneApprovalId(approval.approval_id),
      reference_id: sceneReferenceId(approval.reference_id),
      // Assigned by the server from the frozen decision, never by the model.
      source_kind: approval.source_kind,
      approved_text: approval.approved_text,
      intended_effect: approval.intended_effect,
    });
    provenance.push({
      approval_id: sceneApprovalId(approval.approval_id),
      mechanic_ids: mechanicIdsOf(module),
    });
  }

  const candidate = {
    schema_version: "1.0" as const,
    scene_id: sceneIdFor(input.inputHash),
    title: input.brief.title ?? input.generatedTitle,
    world,
    core: input.core,
    // The fixed port table. Model output cannot add or move an attachment point.
    ports: {
      discovery: {
        gate_action_ids: [...FIXED_PORTS.discovery.gate_action_ids],
        effect_action_ids: [...FIXED_PORTS.discovery.effect_action_ids],
      },
      commitment: {
        gate_action_ids: [...FIXED_PORTS.commitment.gate_action_ids],
        effect_action_ids: [...FIXED_PORTS.commitment.effect_action_ids],
      },
    },
    modules,
    ending_copy_overrides: [],
    influences,
    provenance,
  };

  const parsed = safeParseScene(candidate);
  if (parsed.ok) return { ok: true, scene: parsed.scene };
  return {
    ok: false,
    findings: parsed.issues.slice(0, 12).map((issue) => ({
      code: "SCHEMA_INVALID",
      detail: `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
    })),
  };
}

/** Canonical hash of one owned module, as the version record stores it. */
export function moduleHash(module: InfluenceModule): string {
  return hashCanonical(module);
}

/** Canonical hash of the clean core, as the project stores it. */
export function coreHash(core: CoreScene): string {
  return hashCanonical(core);
}
