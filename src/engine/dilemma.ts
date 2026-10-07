/**
 * The consequential dilemma: structure, proof, and explanation.
 *
 * A dilemma is the one influence shape that is not a prerequisite. A module
 * declares two of its actions as mutually exclusive responses to one tension,
 * and each response secures one of the three existing endings. Taking one
 * response therefore forfeits the ending the other would have secured.
 *
 * Nothing here is a second interpreter. The declaration is plain data on the
 * module (`InfluenceModule.dilemma`); the behaviour is ordinary flags, gates,
 * and a hook that the Phase 1 interpreter already runs. This file only:
 *
 *   * checks that a declaration resolves to the module's own definitions
 *     (layer A), which is also the whole of the authority a declared stake gets
 *     to sit outside the fixed port table;
 *   * proves over the exhaustively explored graph that the responses are
 *     exclusive, that each secured ending is reachable only through its own
 *     response, and that the choice changes which endings stay reachable
 *     (layer B);
 *   * replays the shortest legal route to the choice and each response, so the
 *     creator is shown what each side gains and forfeits as engine output, not
 *     as a model's description of its own work.
 */

import {
  DILEMMA_SLOT,
  DILEMMA_STAKE_ACTIONS,
  TERMINAL_ENDING_BY_ACTION,
} from "../domain/limits";
import type { Id, InfluenceModule, Scene, Slot } from "../domain/scene";
import type { ComposedView } from "./compose";
import { viewOf } from "./compose";
import type { Availability, SceneGraph } from "./graph";
import { exploreScene, sameSet } from "./graph";
import { availableActions, gatesPass, isTrue } from "./interpreter";

type Add = (code: string, message: string, where?: string | null) => void;

/* ------------------------------------------------------------- resolution */

export type ResolvedResponse = {
  readonly action_id: Id;
  /** The one module flag this response sets, and nothing else sets. */
  readonly flag_id: Id;
  readonly secures_action_id: Id;
  /** The other response's stake, which taking this response gives up. */
  readonly forfeits_action_id: Id;
  /** The module gate on the secured stake. */
  readonly gate_id: Id;
};

export type ResolvedDilemma = {
  readonly slot: Slot;
  readonly tension_hook_id: Id;
  readonly tension_dialogue_id: Id;
  readonly responses: readonly [ResolvedResponse, ResolvedResponse];
};

function isStakeAction(id: Id): boolean {
  return (DILEMMA_STAKE_ACTIONS as readonly string[]).includes(id);
}

/**
 * Whether a module gate on `actionId` is one of this module's declared stakes.
 *
 * This is the only thing that lets a gate sit outside its slot's fixed port,
 * and it is deliberately narrow: the module must declare a dilemma, be in the
 * dilemma slot, and name this exact terminal action as a stake.
 */
export function isDeclaredStake(module: InfluenceModule, actionId: Id): boolean {
  if (module.dilemma === undefined || module.slot !== DILEMMA_SLOT) return false;
  if (!isStakeAction(actionId)) return false;
  return module.dilemma.responses.some((response) => response.secures_action_id === actionId);
}

/** The flags each module action or hook writes, for the response-shape check. */
function writersOf(module: InfluenceModule): Map<Id, Id[]> {
  const writers = new Map<Id, Id[]>();
  const note = (varId: Id, by: Id): void => {
    writers.set(varId, [...(writers.get(varId) ?? []), by]);
  };
  for (const action of module.actions) {
    for (const branch of action.branches) {
      for (const effect of branch.effects) note(effect.var_id, action.id);
    }
  }
  for (const hook of module.on_actions) {
    for (const effect of hook.effects) note(effect.var_id, hook.id);
  }
  return writers;
}

/**
 * Layer A for one module. Returns the resolved dilemma when every part of the
 * declaration names this module's own definitions in the required shape, and
 * null otherwise (after reporting why).
 */
export function checkDilemmaStructure(module: InfluenceModule, add: Add): ResolvedDilemma | null {
  const dilemma = module.dilemma;
  if (dilemma === undefined) return null;
  const where = module.approval_id;
  let ok = true;
  const fail = (code: string, message: string): void => {
    ok = false;
    add(code, message, where);
  };

  if (module.slot !== DILEMMA_SLOT) {
    fail("DILEMMA_SLOT_INVALID", `only the ${DILEMMA_SLOT} slot may declare a dilemma`);
  }

  const hook = module.on_actions.find((candidate) => candidate.id === dilemma.tension_hook_id);
  if (hook === undefined || hook.dialogue_id === null) {
    fail(
      "DILEMMA_TENSION_UNRESOLVED",
      `the tension "${dilemma.tension_hook_id}" is not a hook of this module with a line`,
    );
  }

  const [first, second] = dilemma.responses;
  if (first.action_id === second.action_id) {
    fail("DILEMMA_RESPONSE_UNRESOLVED", "the two responses must be different actions");
  }
  if (first.secures_action_id === second.secures_action_id) {
    fail("DILEMMA_STAKE_INVALID", "the two responses must secure different endings");
  }

  const writers = writersOf(module);
  const flags: Id[] = [];
  for (const response of dilemma.responses) {
    if (!isStakeAction(response.secures_action_id)) {
      fail(
        "DILEMMA_STAKE_INVALID",
        `"${response.secures_action_id}" is not a terminal action a dilemma may stake`,
      );
    }
    const action = module.actions.find((candidate) => candidate.id === response.action_id);
    if (action === undefined) {
      fail("DILEMMA_RESPONSE_UNRESOLVED", `"${response.action_id}" is not an action of this module`);
      continue;
    }
    const branch = action.branches.length === 1 ? action.branches[0] : undefined;
    const effect = branch !== undefined && branch.effects.length === 1 ? branch.effects[0] : undefined;
    const ownFlag =
      effect !== undefined &&
      module.variables.some((variable) => variable.id === effect.var_id) &&
      (writers.get(effect.var_id) ?? []).length === 1;
    if (effect === undefined || !ownFlag) {
      fail(
        "DILEMMA_RESPONSE_SHAPE",
        `response "${response.action_id}" must have one branch that sets one module flag nothing else sets`,
      );
      continue;
    }
    flags.push(effect.var_id);
  }

  for (const gate of module.gates) {
    if (!dilemma.responses.some((response) => response.secures_action_id === gate.action_id)) {
      fail(
        "DILEMMA_GATE_UNDECLARED",
        `gate "${gate.id}" is not on a stake this dilemma declares`,
      );
    }
  }
  const gateIds: Id[] = [];
  for (const response of dilemma.responses) {
    const gates = module.gates.filter((gate) => gate.action_id === response.secures_action_id);
    if (gates.length !== 1) {
      fail(
        "DILEMMA_STAKE_UNGATED",
        `the stake "${response.secures_action_id}" needs exactly one gate in this module; found ${gates.length}`,
      );
      continue;
    }
    gateIds.push((gates[0] as { id: Id }).id);
  }

  if (!ok || hook === undefined || hook.dialogue_id === null) return null;
  const resolve = (index: 0 | 1): ResolvedResponse => {
    const response = dilemma.responses[index];
    const other = dilemma.responses[index === 0 ? 1 : 0];
    return {
      action_id: response.action_id,
      flag_id: flags[index] as Id,
      secures_action_id: response.secures_action_id,
      forfeits_action_id: other.secures_action_id,
      gate_id: gateIds[index] as Id,
    };
  };
  return {
    slot: module.slot,
    tension_hook_id: hook.id,
    tension_dialogue_id: hook.dialogue_id,
    responses: [resolve(0), resolve(1)],
  };
}

/** The resolved dilemma of a scene, if it declares one that resolves. */
export function dilemmaOf(scene: Scene): ResolvedDilemma | null {
  for (const module of scene.modules) {
    if (module.dilemma === undefined) continue;
    const resolved = checkDilemmaStructure(module, () => undefined);
    if (resolved !== null) return resolved;
  }
  return null;
}

/* -------------------------------------------------------- layer B: proof */

/**
 * The dilemma's behaviour, read off the complete reachable graph.
 *
 * Each property is a statement about every reachable state, so a pass is a
 * proof over the finite state space rather than a sampled playthrough:
 *
 *   * DILEMMA_NOT_EXCLUSIVE — some state has taken both responses;
 *   * DILEMMA_BENEFIT_UNGUARDED — a secured ending is enabled without its
 *     response, so the player could have that benefit without paying for it;
 *   * DILEMMA_NO_CHOICE — no state ever offers both responses at once;
 *   * DILEMMA_GAIN_UNREACHABLE — a response never actually opens its ending;
 *   * DILEMMA_INCONSEQUENTIAL — at a state offering the choice, both responses
 *     leave the same endings reachable, so the choice changes nothing later.
 */
export function checkDilemmaGraph(
  dilemma: ResolvedDilemma,
  view: ComposedView,
  graph: SceneGraph,
  add: Add,
): void {
  const [first, second] = dilemma.responses;
  const reported = new Set<string>();
  const once = (code: string, message: string, where: Id): void => {
    if (reported.has(code + where)) return;
    reported.add(code + where);
    add(code, message, where);
  };
  const gained = [false, false];
  let choicePoints = 0;

  for (const bits of graph.states) {
    const state = { bits };
    const taken = [isTrue(view, state, first.flag_id), isTrue(view, state, second.flag_id)];
    if (taken[0] && taken[1]) {
      once("DILEMMA_NOT_EXCLUSIVE", "a reachable state has taken both responses", first.action_id);
    }
    const availability = graph.availability.get(bits) ?? new Map<Id, Availability>();
    dilemma.responses.forEach((response, index) => {
      if (availability.get(response.secures_action_id) !== "enabled") return;
      if (taken[index]) gained[index] = true;
      else {
        once(
          "DILEMMA_BENEFIT_UNGUARDED",
          `"${response.secures_action_id}" is enabled without the response "${response.action_id}"`,
          response.secures_action_id,
        );
      }
    });

    if (
      availability.get(first.action_id) !== "enabled" ||
      availability.get(second.action_id) !== "enabled"
    ) {
      continue;
    }
    choicePoints += 1;
    const outgoing = graph.edgesFrom.get(bits) ?? [];
    const after = dilemma.responses.map(
      (response) => outgoing.find((edge) => edge.action_id === response.action_id)?.to ?? null,
    );
    if (after[0] === null || after[1] === null) continue;
    const endingsA = graph.endingsFrom.get(after[0] as number) ?? new Set<Id>();
    const endingsB = graph.endingsFrom.get(after[1] as number) ?? new Set<Id>();
    if (sameSet(endingsA, endingsB)) {
      once(
        "DILEMMA_INCONSEQUENTIAL",
        "both responses leave the same endings reachable, so the choice changes nothing later",
        first.action_id,
      );
    }
  }

  if (choicePoints === 0) {
    once("DILEMMA_NO_CHOICE", "no reachable state offers both responses at once", first.action_id);
  }
  dilemma.responses.forEach((response, index) => {
    if (gained[index]) return;
    once(
      "DILEMMA_GAIN_UNREACHABLE",
      `the response "${response.action_id}" never opens "${response.secures_action_id}"`,
      response.action_id,
    );
  });
}

/* --------------------------------------------- layer C: the explanation */

export type StakeReading = {
  readonly action_id: Id;
  readonly label: string;
  readonly ending_id: Id;
  readonly ending_title: string;
  /** Availability right after the response, by the same engine that plays it. */
  readonly status: Availability | "hidden";
  /** The first failing gate's own text, when the action is locked. */
  readonly blocked_text: string | null;
};

export type DilemmaSide = {
  readonly response_action_id: Id;
  readonly response_label: string;
  /** The response's own line, as the player reads it. */
  readonly response_line: string | null;
  /** The legal route from a fresh start through this response. */
  readonly prefix: readonly Id[];
  readonly secures: StakeReading;
  readonly forfeits: StakeReading;
  readonly endings_after: readonly Id[];
  /** Endings reachable at the choice that this response closes for good. */
  readonly endings_closed: readonly Id[];
};

export type DilemmaReport = {
  readonly slot: Slot;
  readonly tension_line: string;
  readonly tension_speaker_id: Id;
  /** The shortest legal route to a state that offers both responses. */
  readonly choice_prefix: readonly Id[];
  readonly endings_at_choice: readonly Id[];
  readonly sides: readonly [DilemmaSide, DilemmaSide];
};

/**
 * Replays the dilemma and reports what each side does, or null when the scene
 * declares no resolvable dilemma or the choice is not reachable.
 *
 * The route to the choice is the breadth-first shortest legal prefix that
 * offers both responses, preferring one where both stakes are already offered,
 * so the reading compares the two responses in the same situation. Ties break
 * in the composed view's own action order, so the same scene always yields the
 * same report.
 */
export function describeDilemma(scene: Scene): DilemmaReport | null {
  const dilemma = dilemmaOf(scene);
  if (dilemma === null) return null;
  const explored = exploreScene(scene);
  if (!explored.ok) return null;
  const graph = explored.graph;
  const view = viewOf(scene);
  const [first, second] = dilemma.responses;

  const offersBoth = (bits: number): boolean => {
    const availability = graph.availability.get(bits);
    return (
      availability?.get(first.action_id) === "enabled" &&
      availability?.get(second.action_id) === "enabled"
    );
  };
  const stakesOffered = (bits: number): boolean => {
    const availability = graph.availability.get(bits);
    return dilemma.responses.every((response) => availability?.has(response.secures_action_id));
  };

  const prefixes = new Map<number, Id[]>([[0, []]]);
  const queue = [0];
  let choice: number | null = null;
  let fallback: number | null = null;
  while (queue.length > 0 && choice === null) {
    const bits = queue.shift() as number;
    if (offersBoth(bits)) {
      if (stakesOffered(bits)) choice = bits;
      else if (fallback === null) fallback = bits;
    }
    for (const edge of graph.edgesFrom.get(bits) ?? []) {
      if (edge.to === null || prefixes.has(edge.to)) continue;
      prefixes.set(edge.to, [...(prefixes.get(bits) ?? []), edge.action_id]);
      queue.push(edge.to);
    }
  }
  const at = choice ?? fallback;
  if (at === null) return null;
  const choicePrefix = prefixes.get(at) ?? [];
  const endingsAtChoice = graph.endingsFrom.get(at) ?? new Set<Id>();

  const reading = (bits: number, actionId: Id): StakeReading => {
    const offered = availableActions(scene, { bits }).find((entry) => entry.action_id === actionId);
    const endingId = TERMINAL_ENDING_BY_ACTION[actionId as keyof typeof TERMINAL_ENDING_BY_ACTION];
    return {
      action_id: actionId,
      label: view.actionById.get(actionId)?.action.label ?? actionId,
      ending_id: endingId,
      ending_title: view.endingById.get(endingId)?.title ?? endingId,
      status: offered === undefined ? "hidden" : offered.enabled ? "enabled" : "locked",
      blocked_text:
        offered === undefined ? null : (gatesPass(view, { bits }, actionId)?.text ?? null),
    };
  };

  const side = (response: ResolvedResponse): DilemmaSide => {
    const edge = (graph.edgesFrom.get(at) ?? []).find(
      (candidate) => candidate.action_id === response.action_id,
    );
    const after = edge?.to ?? at;
    const endingsAfter = graph.endingsFrom.get(after) ?? new Set<Id>();
    const line = view.actionById.get(response.action_id)?.action.branches[0]?.dialogue_id ?? null;
    return {
      response_action_id: response.action_id,
      response_label: view.actionById.get(response.action_id)?.action.label ?? response.action_id,
      response_line: line === null ? null : (view.dialogueById.get(line)?.node.text ?? null),
      prefix: [...choicePrefix, response.action_id],
      secures: reading(after, response.secures_action_id),
      forfeits: reading(after, response.forfeits_action_id),
      endings_after: [...endingsAfter].sort(),
      endings_closed: [...endingsAtChoice].filter((id) => !endingsAfter.has(id)).sort(),
    };
  };

  const tension = view.dialogueById.get(dilemma.tension_dialogue_id)?.node;
  return {
    slot: dilemma.slot,
    tension_line: tension?.text ?? "",
    tension_speaker_id: tension?.speaker_id ?? "narrator",
    choice_prefix: choicePrefix,
    endings_at_choice: [...endingsAtChoice].sort(),
    sides: [side(first), side(second)],
  };
}

/* ------------------------------------------------- the player's moment */

export type DilemmaMoment =
  | { readonly kind: "open"; readonly response_action_ids: readonly [Id, Id] }
  | {
      readonly kind: "taken";
      readonly response_label: string;
      readonly forfeited_label: string;
    }
  | null;

/**
 * Where the player stands relative to the dilemma, for the one line the player
 * shows: "choose one" while both responses are offered, and what was given up
 * once one is taken. Pure, and read from the same state the player runs.
 */
export function dilemmaMoment(scene: Scene, bits: number): DilemmaMoment {
  const dilemma = dilemmaOf(scene);
  if (dilemma === null) return null;
  const view = viewOf(scene);
  const state = { bits };
  const takenIndex = dilemma.responses.findIndex((response) =>
    isTrue(view, state, response.flag_id),
  );
  if (takenIndex >= 0) {
    const response = dilemma.responses[takenIndex] as ResolvedResponse;
    return {
      kind: "taken",
      response_label: view.actionById.get(response.action_id)?.action.label ?? response.action_id,
      forfeited_label:
        view.actionById.get(response.forfeits_action_id)?.action.label ??
        response.forfeits_action_id,
    };
  }
  const offered = availableActions(scene, state);
  const both = dilemma.responses.every((response) =>
    offered.some((entry) => entry.action_id === response.action_id && entry.enabled),
  );
  return both
    ? {
        kind: "open",
        response_action_ids: [dilemma.responses[0].action_id, dilemma.responses[1].action_id],
      }
    : null;
}
