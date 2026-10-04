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
import type {
  ModuleCompilationOutput,
  ModuleMechanic,
  ModuleSpeaker,
} from "@/domain/compile";
import type { ApprovedInfluence, Slot } from "@/domain/influence";
import { FIXED_PORTS, SLOTS, VERB_TARGET_KIND } from "@/domain/limits";
import type {
  Action,
  Condition,
  CoreScene,
  DialogueNode,
  EndingCopyOverride,
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

/* ---------------------------------------------- the module, materialized */

/**
 * The identifiers one mechanic owns, derived from its position.
 *
 * Every one is the server's. They are positional rather than slugged from the
 * model's own labels, so no model text reaches an identifier and the same
 * mechanics always hash the same way.
 */
export function mechanicIds(slot: Slot, index: number): {
  flag: string;
  action: string;
  gate: string;
  line: string;
  hook: string;
  hookLine: string;
} {
  const n = index + 1;
  return {
    flag: `${slot}.state_${n}`,
    action: `${slot}.action_${n}`,
    gate: `${slot}.gate_${n}`,
    line: `${slot}.line_${n}`,
    hook: `${slot}.hook_${n}`,
    hookLine: `${slot}.hook_line_${n}`,
  };
}

/** The declared NPC's id, for the one speaker choice that is not reserved. */
function speakerId(speaker: ModuleSpeaker, world: World): string {
  return speaker === "character" ? world.characters[0].id : speaker;
}

/**
 * One mechanic, wired into the engine.
 *
 * Everything here that is not a label or a line is written by this function
 * from the product contract, and the wiring is what makes a whole class of
 * live findings unrepresentable rather than merely illegal:
 *
 *   * the action's availability condition requires its own flag to be false,
 *     and its single branch sets that flag, so the action always moves state
 *     from false to true when it is offered (`NO_PROGRESS`) and can be taken
 *     once;
 *   * that same condition is a read of the flag, and the gate's condition is
 *     a second one, so a declared flag is always both written and read
 *     (`VARIABLE_NEVER_WRITTEN`, `VARIABLE_NEVER_READ`);
 *   * the only variable an effect can name is this mechanic's own
 *     (`FOREIGN_WRITE`, and a cross-slot `VAR_UNRESOLVED`);
 *   * the branch has no ending binding at all
 *     (`MODULE_ACTION_TERMINATES`, `NONTERMINAL_ACTION_ENDS`);
 *   * there is exactly one branch and its condition is `always`, so exactly
 *     one branch applies in every reachable state (`AMBIGUOUS_BRANCH`,
 *     `DEAD_BRANCH`);
 *   * the gate's port comes from the slot's own enumeration and the hook's is
 *     the slot's single effect port (`GATE_PORT_INVALID`,
 *     `HOOK_PORT_INVALID`);
 *   * every identifier is this function's (`NAMESPACE_INVALID`), and the
 *     speaker is resolved from a three-value enumeration
 *     (`SPEAKER_UNRESOLVED`).
 *
 * The gate blocks while the flag is false and passes once it is true, which is
 * what `GATE_NEVER_BLOCKS` and `GATE_NEVER_PASSES` require and what makes the
 * mechanical witness a changed action availability rather than extra prose.
 * None of this decides whether the result is *good*: the validator still runs
 * unchanged over the composed scene and still rejects a module that breaks a
 * budget, a reachability rule, or the brief's forbidden wording.
 */
function materializeMechanic(
  mechanic: ModuleMechanic,
  slot: Slot,
  index: number,
  world: World,
): {
  variable: StateVariable;
  action: Action;
  gate: Gate;
  dialogue: DialogueNode[];
  hooks: OnAction[];
} {
  const ids = mechanicIds(slot, index);
  // Reading its own flag as false: the availability condition and, with the
  // effect below, the whole of this mechanic's progress guarantee.
  const notYet: Condition = {
    kind: "any",
    clauses: [[{ var_id: ids.flag, equals: false }]],
  };
  const done: Condition = {
    kind: "any",
    clauses: [[{ var_id: ids.flag, equals: true }]],
  };
  const dialogue: DialogueNode[] = [
    {
      id: ids.line,
      speaker_id: speakerId(mechanic.dialogue_speaker, world),
      text: mechanic.dialogue_text,
    },
  ];
  const hooks: OnAction[] = [];
  if (mechanic.hook !== null) {
    dialogue.push({
      id: ids.hookLine,
      speaker_id: speakerId(mechanic.hook.dialogue_speaker, world),
      text: mechanic.hook.dialogue_text,
    });
    hooks.push({
      id: ids.hook,
      // The slot's one effect port. A mechanic has no field in which to name
      // an attachment point, so it cannot attach to the other slot's.
      action_id: FIXED_PORTS[slot].effect_action_ids[0],
      when: { kind: "always" },
      /*
       * A line, and no state change.
       *
       * A hook that set this mechanic's own flag would defeat its own gate:
       * the slot's effect port sits on the path to the action the gate
       * guards, so the flag would always already be true by the time the
       * gate could matter, and the engine would report `GATE_NEVER_BLOCKS`
       * against a module that looks correct. That was observed as soon as
       * the wiring moved here, which is the argument for the wiring being
       * here. The mechanic's flag is set by the mechanic's own action and
       * nothing else.
       */
      effects: [],
      dialogue_id: ids.hookLine,
    });
  }
  return {
    // `initial: false` is a contract literal: every flag begins false.
    variable: {
      id: ids.flag,
      label: mechanic.flag_label,
      initial: false,
      visible: mechanic.flag_visible,
    },
    action: {
      id: ids.action,
      verb: mechanic.verb,
      label: mechanic.action_label,
      target: targetFor(mechanic.verb, world),
      when: notYet,
      branches: [
        {
          when: { kind: "always" },
          effects: [{ op: "set_true", var_id: ids.flag }],
          dialogue_id: ids.line,
          ending_id: null,
        },
      ],
    },
    gate: {
      id: ids.gate,
      action_id: mechanic.gate_port,
      when: done,
      blocked_text: mechanic.gate_blocked_text,
    },
    dialogue,
    hooks,
  };
}

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
  const materialized = output.mechanics.map((mechanic, index) =>
    materializeMechanic(mechanic, slot, index, world),
  );
  return {
    slot,
    approval_id: sceneApprovalId(approvalId),
    variables: materialized.map((entry) => entry.variable),
    actions: materialized.map((entry) => entry.action),
    dialogue: materialized.flatMap((entry) => entry.dialogue),
    gates: materialized.map((entry) => entry.gate),
    on_actions: materialized.flatMap((entry) => entry.hooks),
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
  /**
   * The creator's explicit ending-wording overrides, carried through every
   * recomposition (specification section 9).
   *
   * They are an input to composition, not an edit of a version, which is what
   * makes an applied wording change survive a later module recompile. The
   * composer replaces one ending's `text` with each one and touches nothing
   * else, so a module stage — which passes none — composes identically to
   * before.
   */
  readonly endingCopyOverrides?: readonly EndingCopyOverride[];
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
    ending_copy_overrides: [...(input.endingCopyOverrides ?? [])],
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
