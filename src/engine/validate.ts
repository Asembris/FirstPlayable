/**
 * Deterministic validator (specification section 5).
 *
 * Layer A checks schema, namespace ownership, reference resolution, the fixed
 * ports, the action grammar, the brief, and the approval relationships that
 * Phase 1 can decide locally. Layer B exhaustively explores the reachable
 * finite state space and checks progress, termination, reachability, closure,
 * and dead definitions. Layer C (creative quality) is deliberately absent: the
 * validator proves structure, never good writing.
 *
 * Resource exhaustion is an explicit failure code. Exploration is never
 * truncated and reported as success.
 */

import type { Brief } from "../domain/brief";
import {
  ANALYSIS,
  FIXED_PORTS,
  REQUIRED_CORE_ACTIONS,
  REQUIRED_ENDING_IDS,
  RESERVED_SPEAKER_IDS,
  SLOTS,
  TERMINAL_ENDING_BY_ACTION,
  VERB_TARGET_KIND,
} from "../domain/limits";
import type {
  Action,
  Condition,
  Effect,
  Id,
  InfluenceModule,
  Scene,
  Slot,
} from "../domain/scene";
import { SceneSchema, formatIssues } from "../domain/scene";
import { containsLiteralPhrase } from "../domain/text";
import type { ComposedView, Owner } from "./compose";
import {
  moduleSubsets,
  orderedSlots,
  removeModule,
  sceneWithModuleSubset,
  viewOf,
} from "./compose";
import type { ExploreLimits, SceneGraph } from "./graph";
import { exploreScene, isStrictSubset, sameSet } from "./graph";
import { findMechanicalWitness, sceneHashes } from "./diff";
import type { MechanicalWitness, WitnessLimits } from "./diff";
import { trueFlags } from "./interpreter";

export type FindingLayer = "schema" | "authority" | "graph" | "witness";

export type Finding = {
  readonly code: string;
  readonly layer: FindingLayer;
  readonly message: string;
  readonly where: string | null;
};

export type GraphSummary = {
  readonly reachable_nonterminal_states: number;
  readonly reachable_endings: readonly Id[];
  readonly min_actions_to_ending: Readonly<Record<string, number>>;
  readonly max_actions_in_a_run: number;
  readonly ending_closing_edges: number;
  readonly consequential_edges: number;
  readonly edges: number;
};

export type ValidationReport = {
  readonly ok: boolean;
  readonly scene_id: Id;
  readonly active_slots: readonly Slot[];
  readonly findings: readonly Finding[];
  readonly hashes: ReturnType<typeof sceneHashes>;
  readonly graph: GraphSummary | null;
  readonly module_witnesses: Readonly<Partial<Record<Slot, MechanicalWitness>>>;
  readonly notes: readonly string[];
};

export type ValidateOptions = {
  /**
   * The frozen approval allowlist. When supplied, every module approval must
   * appear in it; a scene cannot authorize itself by naming a plausible id.
   * Phase 1 has no database snapshot, so fixture validation passes it
   * explicitly or records that authority was not checked.
   */
  readonly approvedApprovalIds: readonly Id[] | null;
  readonly explore: Partial<ExploreLimits>;
  readonly witness: Partial<WitnessLimits>;
  /** Skip the present-versus-absent module witness search. */
  readonly checkModuleWitnesses: boolean;
};

const DEFAULT_OPTIONS: ValidateOptions = {
  approvedApprovalIds: null,
  explore: {},
  witness: {},
  checkModuleWitnesses: true,
};

export function validateScene(
  scene: Scene,
  brief: Brief,
  options: Partial<ValidateOptions> = {},
): ValidationReport {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const findings: Finding[] = [];
  const notes: string[] = [];

  const parsed = SceneSchema.safeParse(scene);
  if (!parsed.success) {
    findings.push({
      code: "SCHEMA_INVALID",
      layer: "schema",
      message: `scene failed the strict contract:\n${formatIssues(parsed.error.issues)}`,
      where: null,
    });
    return {
      ok: false,
      scene_id: scene.scene_id,
      active_slots: [],
      findings,
      hashes: sceneHashes(scene),
      graph: null,
      module_witnesses: {},
      notes,
    };
  }

  const view = viewOf(scene);
  checkAuthority(scene, brief, view, settings, findings, notes);

  const blockingBeforeGraph = findings.length > 0;
  let graph: GraphSummary | null = null;
  const witnesses: Partial<Record<Slot, MechanicalWitness>> = {};

  if (blockingBeforeGraph) {
    notes.push("graph analysis skipped: the scene failed layer A");
  } else {
    const explored = exploreScene(scene, settings.explore);
    if (!explored.ok) {
      findings.push({
        code: explored.code,
        layer: "graph",
        message: explored.message,
        where: null,
      });
    } else {
      graph = checkGraph(view, explored.graph, findings);
      if (settings.checkModuleWitnesses) {
        checkModuleWitnesses(scene, settings, findings, witnesses);
      }
    }
  }

  return {
    ok: findings.length === 0,
    scene_id: scene.scene_id,
    active_slots: orderedSlots(scene.modules),
    findings,
    hashes: sceneHashes(scene),
    graph,
    module_witnesses: witnesses,
    notes,
  };
}

/* ------------------------------------------------- layer A: authority */

function checkAuthority(
  scene: Scene,
  brief: Brief,
  view: ComposedView,
  settings: ValidateOptions,
  findings: Finding[],
  notes: string[],
): void {
  const add = (code: string, message: string, where: string | null = null): void => {
    findings.push({ code, layer: "authority", message, where });
  };

  /* --- world entities and reserved speakers --- */

  const worldIds = [scene.world.room.id, scene.world.characters[0].id, scene.world.object.id];
  for (const id of worldIds) {
    if ((RESERVED_SPEAKER_IDS as readonly string[]).includes(id)) {
      add("RESERVED_SPEAKER_COLLISION", `world entity id "${id}" collides with a reserved speaker id`, id);
    }
  }
  if (new Set(worldIds).size !== worldIds.length) {
    add("WORLD_ID_DUPLICATE", "room, character, and object ids must differ");
  }

  /* --- fixed ports --- */

  for (const slot of SLOTS) {
    const expected = FIXED_PORTS[slot];
    const actual = scene.ports[slot];
    const same =
      sameIdList(expected.gate_action_ids, actual.gate_action_ids) &&
      sameIdList(expected.effect_action_ids, actual.effect_action_ids);
    if (!same) {
      add(
        "PORTS_ALTERED",
        `the ${slot} attachment port does not match the fixed port table`,
        `ports.${slot}`,
      );
    }
  }

  /* --- endings --- */

  const endingIds = scene.core.endings.map((ending) => ending.id);
  if (!sameIdList([...REQUIRED_ENDING_IDS], [...endingIds].sort())) {
    add(
      "ENDING_IDS_INVALID",
      `endings must be exactly ${REQUIRED_ENDING_IDS.join(", ")}; found ${endingIds.join(", ")}`,
      "core.endings",
    );
  }

  /* --- namespaces and registry uniqueness --- */

  checkNamespace(scene, add);
  checkUniqueness(scene, add);

  /* --- required core action grammar --- */

  const coreActionById = new Map(scene.core.actions.map((action) => [action.id, action]));
  for (const [id, verb] of Object.entries(REQUIRED_CORE_ACTIONS)) {
    const action = coreActionById.get(id);
    if (action === undefined) {
      add("CORE_ACTION_MISSING", `the base must declare "${id}"`, id);
      continue;
    }
    if (action.verb !== verb) {
      add("CORE_VERB_MISMATCH", `"${id}" must use the verb "${verb}"`, id);
    }
  }

  /* --- action grammar, references, terminal mapping --- */

  for (const entry of view.actions) {
    const { action, owner } = entry;
    const where = action.id;
    if (VERB_TARGET_KIND[action.verb] !== action.target.kind) {
      add("TARGET_KIND_INVALID", `"${action.id}" targets the wrong entity kind`, where);
    }
    const expectedTargetId =
      action.target.kind === "room"
        ? scene.world.room.id
        : action.target.kind === "character"
          ? scene.world.characters[0].id
          : scene.world.object.id;
    if (action.target.id !== expectedTargetId) {
      add(
        "TARGET_UNRESOLVED",
        `"${action.id}" targets "${action.target.id}", which is not the declared ${action.target.kind}`,
        where,
      );
    }
    checkCondition(view, owner, action.when, `${where}.when`, add);

    const terminalEnding =
      TERMINAL_ENDING_BY_ACTION[action.id as keyof typeof TERMINAL_ENDING_BY_ACTION];
    let namesEnding = false;
    action.branches.forEach((branch, index) => {
      const branchWhere = `${where}.branches[${index}]`;
      checkCondition(view, owner, branch.when, `${branchWhere}.when`, add);
      checkEffects(view, owner, branch.effects, branchWhere, add);
      if (branch.dialogue_id !== null && !view.dialogueById.has(branch.dialogue_id)) {
        add("DIALOGUE_UNRESOLVED", `"${branch.dialogue_id}" is not a declared dialogue node`, branchWhere);
      }
      if (branch.ending_id === null) return;
      namesEnding = true;
      if (!view.endingById.has(branch.ending_id)) {
        add("ENDING_UNRESOLVED", `"${branch.ending_id}" is not a declared ending`, branchWhere);
      }
      if (owner !== "core") {
        add(
          "MODULE_ACTION_TERMINATES",
          `module action "${action.id}" may not end the scene directly`,
          branchWhere,
        );
      }
      if (terminalEnding !== undefined && branch.ending_id !== terminalEnding) {
        add(
          "TERMINAL_MAPPING_INVALID",
          `"${action.id}" must resolve to "${terminalEnding}"`,
          branchWhere,
        );
      }
      if (terminalEnding === undefined && action.verb !== "give" && action.verb !== "withhold" && action.verb !== "leave") {
        add(
          "NONTERMINAL_ACTION_ENDS",
          `"${action.id}" uses the verb "${action.verb}" and may not name an ending`,
          branchWhere,
        );
      }
    });
    if (terminalEnding !== undefined && !namesEnding) {
      add(
        "TERMINAL_ACTION_HAS_NO_ENDING",
        `"${action.id}" must name "${terminalEnding}" on at least one branch`,
        where,
      );
    }
    if (owner !== "core" && action.verb !== "inspect" && action.verb !== "ask") {
      add(
        "MODULE_VERB_INVALID",
        `module action "${action.id}" may only use inspect or ask`,
        where,
      );
    }
  }

  /* --- dialogue speakers --- */

  for (const entry of view.dialogueById.values()) {
    const speaker = entry.node.speaker_id;
    const allowed =
      (RESERVED_SPEAKER_IDS as readonly string[]).includes(speaker) ||
      speaker === scene.world.characters[0].id;
    if (!allowed) {
      add(
        "SPEAKER_UNRESOLVED",
        `"${speaker}" is neither a reserved speaker nor the declared NPC`,
        entry.node.id,
      );
    }
  }

  /* --- module gates, hooks, ownership --- */

  for (const module of scene.modules) {
    const port = scene.ports[module.slot];
    for (const gate of module.gates) {
      if (!view.actionById.has(gate.action_id)) {
        add("GATE_ACTION_UNRESOLVED", `gate "${gate.id}" targets unknown action "${gate.action_id}"`, gate.id);
      } else if (!port.gate_action_ids.includes(gate.action_id)) {
        add(
          "GATE_PORT_INVALID",
          `the ${module.slot} slot may not gate "${gate.action_id}"`,
          gate.id,
        );
      }
      checkCondition(view, module.slot, gate.when, `${gate.id}.when`, add);
    }
    for (const hook of module.on_actions) {
      if (!view.actionById.has(hook.action_id)) {
        add("HOOK_ACTION_UNRESOLVED", `hook "${hook.id}" targets unknown action "${hook.action_id}"`, hook.id);
      } else if (!port.effect_action_ids.includes(hook.action_id)) {
        add(
          "HOOK_PORT_INVALID",
          `the ${module.slot} slot may not attach effects to "${hook.action_id}"`,
          hook.id,
        );
      }
      checkCondition(view, module.slot, hook.when, `${hook.id}.when`, add);
      checkEffects(view, module.slot, hook.effects, hook.id, add);
      if (hook.dialogue_id !== null && !view.dialogueById.has(hook.dialogue_id)) {
        add("DIALOGUE_UNRESOLVED", `"${hook.dialogue_id}" is not a declared dialogue node`, hook.id);
      }
    }
  }

  /* --- unattached variables --- */

  const written = new Set<Id>();
  const read = new Set<Id>();
  collectEffectTargets(scene, written);
  collectConditionReads(scene, read);
  for (const entry of view.variables) {
    const id = entry.variable.id;
    if (!written.has(id)) {
      add("VARIABLE_NEVER_WRITTEN", `variable "${id}" is never set by any effect`, id);
    }
    if (!read.has(id)) {
      add("VARIABLE_NEVER_READ", `variable "${id}" is never read by any condition`, id);
    }
  }

  /* --- ending copy overrides --- */

  const editIds = new Set<Id>();
  for (const override of scene.ending_copy_overrides) {
    if (!view.endingById.has(override.ending_id)) {
      add("OVERRIDE_UNRESOLVED", `"${override.ending_id}" is not a declared ending`, override.creator_edit_id);
    }
    if (editIds.has(override.creator_edit_id)) {
      add("OVERRIDE_DUPLICATE", `creator edit id "${override.creator_edit_id}" is repeated`, override.creator_edit_id);
    }
    editIds.add(override.creator_edit_id);
  }

  /* --- approvals and provenance --- */

  checkApprovals(scene, settings, add, notes);

  /* --- brief conformance --- */

  checkBrief(scene, brief, add);
}

function checkNamespace(
  scene: Scene,
  add: (code: string, message: string, where?: string | null) => void,
): void {
  const requirePrefix = (id: Id, prefix: string, kind: string): void => {
    if (!id.startsWith(prefix)) {
      add("NAMESPACE_INVALID", `${kind} id "${id}" must use the "${prefix}" namespace`, id);
    }
  };
  for (const variable of scene.core.variables) requirePrefix(variable.id, "core.", "core variable");
  for (const action of scene.core.actions) requirePrefix(action.id, "core.", "core action");
  for (const node of scene.core.dialogue) requirePrefix(node.id, "core.", "core dialogue");
  for (const ending of scene.core.endings) requirePrefix(ending.id, "end.", "ending");
  for (const module of scene.modules) {
    const prefix = `${module.slot}.`;
    for (const variable of module.variables) requirePrefix(variable.id, prefix, "module variable");
    for (const action of module.actions) requirePrefix(action.id, prefix, "module action");
    for (const node of module.dialogue) requirePrefix(node.id, prefix, "module dialogue");
    for (const gate of module.gates) requirePrefix(gate.id, prefix, "module gate");
    for (const hook of module.on_actions) requirePrefix(hook.id, prefix, "module hook");
  }
}

function checkUniqueness(
  scene: Scene,
  add: (code: string, message: string, where?: string | null) => void,
): void {
  const registries: Record<string, Id[]> = {
    variable: [
      ...scene.core.variables.map((variable) => variable.id),
      ...scene.modules.flatMap((module) => module.variables.map((variable) => variable.id)),
    ],
    action: [
      ...scene.core.actions.map((action) => action.id),
      ...scene.modules.flatMap((module) => module.actions.map((action) => action.id)),
    ],
    dialogue: [
      ...scene.core.dialogue.map((node) => node.id),
      ...scene.modules.flatMap((module) => module.dialogue.map((node) => node.id)),
    ],
    ending: scene.core.endings.map((ending) => ending.id),
    gate: scene.modules.flatMap((module) => module.gates.map((gate) => gate.id)),
    hook: scene.modules.flatMap((module) => module.on_actions.map((hook) => hook.id)),
  };
  for (const [kind, ids] of Object.entries(registries)) {
    const seen = new Set<Id>();
    for (const id of ids) {
      if (seen.has(id)) {
        add("DUPLICATE_ID", `${kind} id "${id}" is declared more than once`, id);
      }
      seen.add(id);
    }
  }
}

/**
 * A condition may read core flags and the reading owner's own flags. It may
 * never read another slot's flags, and it may never read an undeclared flag.
 */
function checkCondition(
  view: ComposedView,
  owner: Owner,
  condition: Condition,
  where: string,
  add: (code: string, message: string, where?: string | null) => void,
): void {
  if (condition.kind !== "any") return;
  for (const clause of condition.clauses) {
    for (const atom of clause) {
      const varOwner = view.variableOwner.get(atom.var_id);
      if (varOwner === undefined) {
        add("VAR_UNRESOLVED", `"${atom.var_id}" is not a declared state variable`, where);
        continue;
      }
      if (varOwner === "core" || varOwner === owner) continue;
      add(
        "CROSS_SLOT_READ",
        `${owner} may not read "${atom.var_id}", which belongs to ${varOwner}`,
        where,
      );
    }
  }
}

/** Only the owner of a variable may write it, and only with `set_true`. */
function checkEffects(
  view: ComposedView,
  owner: Owner,
  effects: readonly Effect[],
  where: string,
  add: (code: string, message: string, where?: string | null) => void,
): void {
  for (const effect of effects) {
    const varOwner = view.variableOwner.get(effect.var_id);
    if (varOwner === undefined) {
      add("VAR_UNRESOLVED", `"${effect.var_id}" is not a declared state variable`, where);
      continue;
    }
    if (varOwner === owner) continue;
    add(
      "FOREIGN_WRITE",
      `${owner} may not write "${effect.var_id}", which belongs to ${varOwner}`,
      where,
    );
  }
}

function collectEffectTargets(scene: Scene, into: Set<Id>): void {
  const fromAction = (action: Action): void => {
    for (const branch of action.branches) {
      for (const effect of branch.effects) into.add(effect.var_id);
    }
  };
  for (const action of scene.core.actions) fromAction(action);
  for (const module of scene.modules) {
    for (const action of module.actions) fromAction(action);
    for (const hook of module.on_actions) {
      for (const effect of hook.effects) into.add(effect.var_id);
    }
  }
}

function collectConditionReads(scene: Scene, into: Set<Id>): void {
  const fromCondition = (condition: Condition): void => {
    if (condition.kind !== "any") return;
    for (const clause of condition.clauses) {
      for (const atom of clause) into.add(atom.var_id);
    }
  };
  const fromAction = (action: Action): void => {
    fromCondition(action.when);
    for (const branch of action.branches) fromCondition(branch.when);
  };
  for (const action of scene.core.actions) fromAction(action);
  for (const module of scene.modules) {
    for (const action of module.actions) fromAction(action);
    for (const gate of module.gates) fromCondition(gate.when);
    for (const hook of module.on_actions) fromCondition(hook.when);
  }
}

function checkApprovals(
  scene: Scene,
  settings: ValidateOptions,
  add: (code: string, message: string, where?: string | null) => void,
  notes: string[],
): void {
  const moduleApprovals = new Map<Id, InfluenceModule>();
  for (const module of scene.modules) {
    if (moduleApprovals.has(module.approval_id)) {
      add("APPROVAL_DUPLICATE", `approval "${module.approval_id}" is claimed by two modules`, module.approval_id);
    }
    moduleApprovals.set(module.approval_id, module);
  }

  for (const module of scene.modules) {
    const references = scene.influences.filter(
      (reference) => reference.approval_id === module.approval_id,
    );
    if (references.length !== 1) {
      add(
        "APPROVAL_REFERENCE_INVALID",
        `the ${module.slot} module needs exactly one influence reference for "${module.approval_id}"; found ${references.length}`,
        module.approval_id,
      );
    }
    const bindings = scene.provenance.filter(
      (binding) => binding.approval_id === module.approval_id,
    );
    if (bindings.length !== 1) {
      add(
        "PROVENANCE_BINDING_INVALID",
        `the ${module.slot} module needs exactly one provenance binding; found ${bindings.length}`,
        module.approval_id,
      );
      continue;
    }
    const owned = new Set<Id>([
      ...module.actions.map((action) => action.id),
      ...module.gates.map((gate) => gate.id),
      ...module.on_actions.map((hook) => hook.id),
    ]);
    const claimed = new Set((bindings[0] as { mechanic_ids: Id[] }).mechanic_ids);
    for (const id of claimed) {
      if (!owned.has(id)) {
        add(
          "PROVENANCE_UNRESOLVED",
          `provenance for "${module.approval_id}" claims "${id}", which the ${module.slot} module does not own`,
          id,
        );
      }
    }
    for (const id of owned) {
      if (!claimed.has(id)) {
        add(
          "PROVENANCE_INCOMPLETE",
          `the ${module.slot} module owns "${id}" but no provenance binding claims it`,
          id,
        );
      }
    }
  }

  for (const reference of scene.influences) {
    if (!moduleApprovals.has(reference.approval_id)) {
      add(
        "ORPHAN_INFLUENCE",
        `influence reference "${reference.approval_id}" has no composed module`,
        reference.approval_id,
      );
    }
  }
  for (const binding of scene.provenance) {
    if (!moduleApprovals.has(binding.approval_id)) {
      add(
        "ORPHAN_PROVENANCE",
        `provenance binding "${binding.approval_id}" has no composed module`,
        binding.approval_id,
      );
    }
  }

  if (settings.approvedApprovalIds === null) {
    if (scene.modules.length > 0) {
      notes.push(
        "approval authority was not checked: no frozen approval allowlist was supplied, so this report only states that the scene is internally consistent",
      );
    }
    return;
  }
  const allowed = new Set(settings.approvedApprovalIds);
  for (const module of scene.modules) {
    if (!allowed.has(module.approval_id)) {
      add(
        "APPROVAL_NOT_AUTHORIZED",
        `approval "${module.approval_id}" is not in the frozen allowlist; a scene cannot authorize itself`,
        module.approval_id,
      );
    }
  }
}

function checkBrief(
  scene: Scene,
  brief: Brief,
  add: (code: string, message: string, where?: string | null) => void,
): void {
  const expectations: [string, string, string][] = [
    ["player_role", scene.world.player_role, brief.player_role],
    ["room.id", scene.world.room.id, brief.room.id],
    ["room.name", scene.world.room.name, brief.room.name],
    ["room.description", scene.world.room.description, brief.room.description],
    ["character.id", scene.world.characters[0].id, brief.character.id],
    ["character.name", scene.world.characters[0].name, brief.character.name],
    ["character.role", scene.world.characters[0].role, brief.character.role],
    ["object.id", scene.world.object.id, brief.object.id],
    ["object.name", scene.world.object.name, brief.object.name],
    ["object.description", scene.world.object.description, brief.object.description],
  ];
  for (const [field, actual, expected] of expectations) {
    if (actual !== expected) {
      add(
        "BRIEF_MISMATCH",
        `world ${field} is "${actual}" but the frozen brief says "${expected}"`,
        field,
      );
    }
  }
  if (brief.title !== null && scene.title !== brief.title) {
    add("BRIEF_MISMATCH", `scene title "${scene.title}" does not match the brief title`, "title");
  }

  if (brief.forbidden_wording.length === 0) return;
  const view = viewOf(scene);
  const strings: [string, string][] = [
    ["title", scene.title],
    ["world.room.description", scene.world.room.description],
    ["world.object.description", scene.world.object.description],
    ["world.character.role", scene.world.characters[0].role],
  ];
  for (const entry of view.actions) strings.push([entry.action.id, entry.action.label]);
  for (const entry of view.dialogueById.values()) strings.push([entry.node.id, entry.node.text]);
  for (const ending of view.endings) strings.push([ending.id, `${ending.title} ${ending.text}`]);
  for (const module of scene.modules) {
    for (const gate of module.gates) strings.push([gate.id, gate.blocked_text]);
  }
  for (const [where, text] of strings) {
    for (const phrase of brief.forbidden_wording) {
      if (containsLiteralPhrase(text, phrase)) {
        add(
          "FORBIDDEN_WORDING",
          `"${where}" contains the forbidden phrase "${phrase}" (literal wording only; this says nothing about the concept)`,
          where,
        );
      }
    }
  }
}

function sameIdList(a: readonly Id[], b: readonly Id[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/* ------------------------------------------------------- layer B: graph */

function checkGraph(
  view: ComposedView,
  graph: SceneGraph,
  findings: Finding[],
): GraphSummary {
  const add = (code: string, message: string, where: string | null = null): void => {
    findings.push({ code, layer: "graph", message, where });
  };

  for (const problem of graph.problems) {
    add(
      problem.code,
      `${problem.message} (true flags: ${problem.true_flags.length === 0 ? "none" : problem.true_flags.join(", ")})`,
      problem.action_id,
    );
  }

  const start = 0;
  const reachableEndings = graph.endingsFrom.get(start) ?? new Set<Id>();
  for (const ending of view.endings) {
    if (!reachableEndings.has(ending.id)) {
      add("ENDING_UNREACHABLE", `ending "${ending.id}" is not reachable from the initial state`, ending.id);
    }
  }

  for (const bits of graph.states) {
    const endings = graph.endingsFrom.get(bits) ?? new Set<Id>();
    if (endings.size === 0) {
      add(
        "SOFTLOCK",
        `a reachable nonterminal state cannot reach any ending (true flags: ${describeState(view, bits)})`,
      );
    }
  }

  let closingEdges = 0;
  let consequentialEdges = 0;
  for (const edge of graph.edges) {
    if (edge.to === null) continue;
    const before = graph.endingsFrom.get(edge.from) ?? new Set<Id>();
    const after = graph.endingsFrom.get(edge.to) ?? new Set<Id>();
    if (isStrictSubset(after, before)) closingEdges += 1;
    if (!sameSet(before, after) || availabilityChanged(graph, edge.from, edge.to, edge.action_id)) {
      consequentialEdges += 1;
    }
  }
  if (closingEdges === 0) {
    add(
      "NO_ENDING_CLOSING_CHOICE",
      "no nonterminal choice strictly reduces the set of reachable endings; every ending stays available until the final menu",
    );
  }
  if (consequentialEdges === 0) {
    add(
      "NO_CONSEQUENTIAL_CHOICE",
      "no nonterminal action changes a later legal action or ending reachability",
    );
  }

  for (const entry of view.actions) {
    if (!graph.enabledSomewhere.has(entry.action.id)) {
      add("DEAD_ACTION", `action "${entry.action.id}" is never enabled in any reachable state`, entry.action.id);
      continue;
    }
    const selected = graph.selectedBranches.get(entry.action.id) ?? new Set<number>();
    entry.action.branches.forEach((_branch, index) => {
      if (!selected.has(index)) {
        add(
          "DEAD_BRANCH",
          `branch ${index} of "${entry.action.id}" is never selected in any reachable state`,
          entry.action.id,
        );
      }
    });
  }

  for (const [, gates] of view.gatesByAction) {
    for (const entry of gates) {
      const observation = graph.gateObservations.get(entry.gate.id);
      if (observation === undefined || !observation.passed) {
        add(
          "GATE_NEVER_PASSES",
          `gate "${entry.gate.id}" never allows its action in any reachable state`,
          entry.gate.id,
        );
      }
      if (observation === undefined || !observation.blocked) {
        add(
          "GATE_NEVER_BLOCKS",
          `gate "${entry.gate.id}" never blocks its action, so it has no mechanical effect`,
          entry.gate.id,
        );
      }
    }
  }

  for (const [, hooks] of view.hooksByAction) {
    for (const entry of hooks) {
      if (!graph.firedHooks.has(entry.hook.id)) {
        add("DEAD_HOOK", `hook "${entry.hook.id}" never fires in any reachable state`, entry.hook.id);
      }
    }
  }

  const minActions: Record<string, number> = {};
  for (const ending of view.endings) {
    const depth = graph.minActionsToEnding.get(ending.id);
    if (depth === undefined) continue;
    minActions[ending.id] = depth;
    if (depth < ANALYSIS.min_actions_to_ending) {
      add(
        "ENDING_TOO_SHALLOW",
        `ending "${ending.id}" is reachable in ${depth} action(s); at least ${ANALYSIS.min_actions_to_ending} are required`,
        ending.id,
      );
    }
  }
  if (graph.maxDepth > ANALYSIS.max_depth) {
    add(
      "RUNTIME_DEPTH_EXCEEDED",
      `the longest run is ${graph.maxDepth} actions; the bound is ${ANALYSIS.max_depth}`,
    );
  }

  return {
    reachable_nonterminal_states: graph.states.length,
    reachable_endings: [...reachableEndings].sort(),
    min_actions_to_ending: minActions,
    max_actions_in_a_run: graph.maxDepth,
    ending_closing_edges: closingEdges,
    consequential_edges: consequentialEdges,
    edges: graph.edges.length,
  };
}

function availabilityChanged(
  graph: SceneGraph,
  from: number,
  to: number,
  takenActionId: Id,
): boolean {
  const before = graph.availability.get(from) ?? new Map<Id, string>();
  const after = graph.availability.get(to) ?? new Map<Id, string>();
  const ids = new Set([...before.keys(), ...after.keys()]);
  ids.delete(takenActionId);
  for (const id of ids) {
    if ((before.get(id) ?? "hidden") !== (after.get(id) ?? "hidden")) return true;
  }
  return false;
}

function describeState(view: ComposedView, bits: number): string {
  const flags = trueFlags(view, { bits });
  return flags.length === 0 ? "none" : flags.join(", ");
}

/* ------------------------------------------------- mechanical witnesses */

function checkModuleWitnesses(
  scene: Scene,
  settings: ValidateOptions,
  findings: Finding[],
  into: Partial<Record<Slot, MechanicalWitness>>,
): void {
  for (const module of scene.modules) {
    const without = removeModule(scene, module.slot);
    const witness = findMechanicalWitness(without, scene, settings.witness);
    into[module.slot] = witness;
    if (witness.mechanical) continue;
    findings.push({
      code: witness.overflow ? "WITNESS_SEARCH_OVERFLOW" : "MODULE_WITNESS_MISSING",
      layer: "witness",
      message: witness.overflow
        ? `the ${module.slot} module's mechanical witness search stopped at its pair bound after ${witness.pairs_explored} pairs; an unproven witness is a failure, not a pass`
        : `the ${module.slot} module changes no legal action availability and no reachable ending when present versus absent`,
      where: module.approval_id,
    });
  }
}

/* --------------------------------------------------------- subset report */

export type SubsetReport = {
  readonly slots: readonly Slot[];
  readonly report: ValidationReport;
};

export type SubsetValidation = {
  readonly ok: boolean;
  readonly subsets: readonly SubsetReport[];
};

/**
 * Validate the base alone, each module alone, and every supported combination.
 * This is what makes later removal safe: a subset that cannot validate must
 * never be reachable by removing an influence.
 */
export function validateSceneSubsets(
  scene: Scene,
  brief: Brief,
  options: Partial<ValidateOptions> = {},
): SubsetValidation {
  const subsets = moduleSubsets(scene).map((slots) => ({
    slots,
    report: validateScene(sceneWithModuleSubset(scene, slots), brief, options),
  }));
  return { ok: subsets.every((entry) => entry.report.ok), subsets };
}

export function describeFindings(report: ValidationReport): string {
  if (report.findings.length === 0) return "no findings";
  return report.findings
    .map(
      (finding) =>
        `  [${finding.layer}] ${finding.code}${finding.where === null ? "" : ` @ ${finding.where}`}: ${finding.message}`,
    )
    .join("\n");
}
