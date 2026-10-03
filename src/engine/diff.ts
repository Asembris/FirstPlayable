/**
 * Mechanical witnesses and version comparison (specification sections 5 and 9).
 *
 * A change is called MECHANICAL only when a bounded paired replay demonstrates
 * a changed legal action availability or a changed reachable-ending set. A
 * renamed flag, a changed identifier, different prose, or a different
 * provenance string is reported as a WORDING change, never as a mechanical
 * one. Nothing here calls a model: the labels come from deterministic
 * structural comparison and replay.
 */

import { SLOTS } from "../domain/limits";
import type {
  Action,
  Condition,
  Effect,
  Id,
  Scene,
  Slot,
} from "../domain/scene";
import { viewOf } from "./compose";
import type { ComposedView } from "./compose";
import { exploreScene, sameSet } from "./graph";
import type { ExploreLimits, SceneGraph } from "./graph";
import { hashCanonical } from "./hash";
import { availableActions, step } from "./interpreter";
import { ANALYSIS } from "../domain/limits";

/* --------------------------------------------------- mechanical signature */

/**
 * The structural shape of a scene with every narrative string and every
 * provenance label stripped. Equal signatures mean the change cannot be
 * mechanical. Different signatures prove nothing on their own — an identifier
 * rename changes the signature without changing play — so the replay witness
 * remains the authority.
 */
export function mechanicalSignature(scene: Scene): unknown {
  return {
    schema_version: scene.schema_version,
    world: {
      room_id: scene.world.room.id,
      character_id: scene.world.characters[0].id,
      object_id: scene.world.object.id,
    },
    ports: scene.ports,
    variables: scene.core.variables.map((variable) => variable.id),
    actions: scene.core.actions.map(signAction),
    endings: scene.core.endings.map((ending) => ending.id),
    modules: SLOTS.flatMap((slot) => {
      const module = scene.modules.find((candidate) => candidate.slot === slot);
      if (module === undefined) return [];
      return [
        {
          slot: module.slot,
          variables: module.variables.map((variable) => variable.id),
          actions: module.actions.map(signAction),
          gates: module.gates.map((gate) => ({
            action_id: gate.action_id,
            when: gate.when,
          })),
          on_actions: module.on_actions.map((hook) => ({
            action_id: hook.action_id,
            when: hook.when,
            effects: signEffects(hook.effects),
            has_dialogue: hook.dialogue_id !== null,
          })),
        },
      ];
    }),
  };
}

function signAction(action: Action): unknown {
  return {
    id: action.id,
    verb: action.verb,
    target: action.target,
    when: action.when,
    branches: action.branches.map((branch) => ({
      when: branch.when,
      effects: signEffects(branch.effects),
      has_dialogue: branch.dialogue_id !== null,
      ending_id: branch.ending_id,
    })),
  };
}

function signEffects(effects: readonly Effect[]): readonly Id[] {
  return effects.map((effect) => effect.var_id);
}

export function sceneHashes(scene: Scene): {
  scene: string;
  world: string;
  core: string;
  ports: string;
  modules: Partial<Record<Slot, string>>;
} {
  const modules: Partial<Record<Slot, string>> = {};
  for (const module of scene.modules) modules[module.slot] = hashCanonical(module);
  return {
    scene: hashCanonical(scene),
    world: hashCanonical(scene.world),
    core: hashCanonical(scene.core),
    ports: hashCanonical(scene.ports),
    modules,
  };
}

/* ------------------------------------------------------ mechanical witness */

export type WitnessKind =
  | "action_availability"
  | "ending_reachability"
  | "action_set";

export type WitnessObservation = {
  readonly kind: WitnessKind;
  /** The shared or introduced action the observation is about. */
  readonly action_id: Id | null;
  /** The legal replay prefix that reaches the observation. */
  readonly prefix: readonly Id[];
  readonly before: string;
  readonly after: string;
};

export type MechanicalWitness = {
  /** True only when a replay shows changed availability or changed endings. */
  readonly mechanical: boolean;
  readonly observations: readonly WitnessObservation[];
  readonly pairs_explored: number;
  /** True when the pair bound stopped the search before it completed. */
  readonly overflow: boolean;
};

export type WitnessLimits = {
  readonly maxPairs: number;
  readonly explore: Partial<ExploreLimits>;
};

type Side = {
  readonly scene: Scene;
  readonly view: ComposedView;
  readonly graph: SceneGraph;
};

function sideOf(scene: Scene, explore: Partial<ExploreLimits>): Side | null {
  const result = exploreScene(scene, explore);
  if (!result.ok) return null;
  return { scene, view: viewOf(scene), graph: result.graph };
}

/**
 * Bounded paired-state traversal. Common legal actions advance both sides;
 * an action that exists on one side only advances that side, which is how an
 * introduced module action is followed to its downstream consequence. Pair
 * exhaustion is reported, never silently treated as "no difference".
 */
export function findMechanicalWitness(
  before: Scene,
  after: Scene,
  limits: Partial<WitnessLimits> = {},
): MechanicalWitness {
  const maxPairs = limits.maxPairs ?? ANALYSIS.max_witness_pairs;
  const explore = limits.explore ?? {};
  const left = sideOf(before, explore);
  const right = sideOf(after, explore);
  if (left === null || right === null) {
    return {
      mechanical: false,
      observations: [],
      pairs_explored: 0,
      overflow: true,
    };
  }

  const observations: WitnessObservation[] = [];
  const seenKinds = new Set<string>();
  const seen = new Set<string>(["0|0"]);
  const queue: { a: number; b: number; prefix: Id[] }[] = [
    { a: 0, b: 0, prefix: [] },
  ];
  let explored = 0;
  let overflow = false;

  while (queue.length > 0) {
    if (explored >= maxPairs) {
      overflow = true;
      break;
    }
    const pair = queue.shift() as { a: number; b: number; prefix: Id[] };
    explored += 1;

    const availA = availabilityMap(before, pair.a);
    const availB = availabilityMap(after, pair.b);

    for (const actionId of unionIds(availA, availB)) {
      const inLeft = left.view.actionById.has(actionId);
      const inRight = right.view.actionById.has(actionId);
      const stateA = availA.get(actionId) ?? "hidden";
      const stateB = availB.get(actionId) ?? "hidden";
      if (inLeft && inRight) {
        if (stateA !== stateB) {
          record(observations, seenKinds, {
            kind: "action_availability",
            action_id: actionId,
            prefix: pair.prefix,
            before: stateA,
            after: stateB,
          });
        }
      } else {
        record(observations, seenKinds, {
          kind: "action_set",
          action_id: actionId,
          prefix: pair.prefix,
          before: inLeft ? stateA : "absent",
          after: inRight ? stateB : "absent",
        });
      }
    }

    const endingsA = left.graph.endingsFrom.get(pair.a) ?? new Set<Id>();
    const endingsB = right.graph.endingsFrom.get(pair.b) ?? new Set<Id>();
    if (!sameSet(endingsA, endingsB)) {
      record(observations, seenKinds, {
        kind: "ending_reachability",
        action_id: null,
        prefix: pair.prefix,
        before: formatSet(endingsA),
        after: formatSet(endingsB),
      });
    }

    for (const actionId of unionIds(availA, availB)) {
      const inLeft = left.view.actionById.has(actionId);
      const inRight = right.view.actionById.has(actionId);
      const enabledA = availA.get(actionId) === "enabled";
      const enabledB = availB.get(actionId) === "enabled";

      let nextA = pair.a;
      let nextB = pair.b;
      if (inLeft && inRight) {
        // Only advance both sides together; a shared action enabled on one
        // side only is already recorded as a divergence.
        if (!enabledA || !enabledB) continue;
        const resultA = step(before, { bits: pair.a }, actionId);
        const resultB = step(after, { bits: pair.b }, actionId);
        if (!resultA.ok || !resultB.ok) continue;
        if (resultA.ending !== null || resultB.ending !== null) continue;
        nextA = resultA.state.bits;
        nextB = resultB.state.bits;
      } else if (inRight && enabledB) {
        const resultB = step(after, { bits: pair.b }, actionId);
        if (!resultB.ok || resultB.ending !== null) continue;
        nextB = resultB.state.bits;
      } else if (inLeft && enabledA) {
        const resultA = step(before, { bits: pair.a }, actionId);
        if (!resultA.ok || resultA.ending !== null) continue;
        nextA = resultA.state.bits;
      } else {
        continue;
      }

      const key = `${nextA}|${nextB}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ a: nextA, b: nextB, prefix: [...pair.prefix, actionId] });
    }
  }

  const mechanical = observations.some(
    (observation) =>
      observation.kind === "action_availability" ||
      observation.kind === "ending_reachability",
  );

  return { mechanical, observations, pairs_explored: explored, overflow };
}

function availabilityMap(scene: Scene, bits: number): Map<Id, string> {
  const map = new Map<Id, string>();
  for (const action of availableActions(scene, { bits })) {
    map.set(action.action_id, action.enabled ? "enabled" : "locked");
  }
  return map;
}

function unionIds(a: Map<Id, string>, b: Map<Id, string>): Id[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}

function record(
  into: WitnessObservation[],
  seenKinds: Set<string>,
  observation: WitnessObservation,
): void {
  const key = `${observation.kind}:${observation.action_id ?? "-"}:${observation.before}>${observation.after}`;
  if (seenKinds.has(key)) return;
  seenKinds.add(key);
  into.push(observation);
}

function formatSet(values: ReadonlySet<Id>): string {
  return values.size === 0 ? "none" : [...values].sort().join(", ");
}

/* ----------------------------------------------------------- replay probe */

export type ReplayObservation = {
  readonly prefix: readonly Id[];
  readonly prefix_legal_in_before: boolean;
  readonly prefix_legal_in_after: boolean;
  readonly before: Readonly<Record<Id, string>>;
  readonly after: Readonly<Record<Id, string>>;
  readonly changed_action_ids: readonly Id[];
};

/**
 * Replay one explicit action prefix in two scenes and report the availability
 * of every action afterwards. This is the "same choices" comparison the
 * product shows, and the canonical Phase 1 evidence.
 */
export function observeReplayPrefix(
  before: Scene,
  after: Scene,
  prefix: readonly Id[],
): ReplayObservation {
  const runBefore = runPrefix(before, prefix);
  const runAfter = runPrefix(after, prefix);
  const ids = [...new Set([...Object.keys(runBefore.map), ...Object.keys(runAfter.map)])].sort();
  const changed = ids.filter(
    (id) => (runBefore.map[id] ?? "hidden") !== (runAfter.map[id] ?? "hidden"),
  );
  return {
    prefix,
    prefix_legal_in_before: runBefore.legal,
    prefix_legal_in_after: runAfter.legal,
    before: runBefore.map,
    after: runAfter.map,
    changed_action_ids: changed,
  };
}

function runPrefix(
  scene: Scene,
  prefix: readonly Id[],
): { legal: boolean; map: Record<Id, string> } {
  let bits = 0;
  for (const actionId of prefix) {
    const result = step(scene, { bits }, actionId);
    if (!result.ok) return { legal: false, map: {} };
    bits = result.state.bits;
  }
  const map: Record<Id, string> = {};
  for (const action of availableActions(scene, { bits })) {
    map[action.action_id] = action.enabled ? "enabled" : "locked";
  }
  return { legal: true, map };
}

/* ----------------------------------------------------------- revision diff */

export type GateBindingChange = {
  readonly slot: Slot;
  readonly gate_id: Id;
  readonly action_id: Id;
  readonly before: Condition | null;
  readonly after: Condition | null;
};

export type EffectBindingChange = {
  readonly owner: string;
  readonly definition_id: Id;
  readonly before: readonly Id[];
  readonly after: readonly Id[];
};

export type CopyOnlyChange = {
  readonly ending_id: Id;
  readonly before: string;
  readonly after: string;
};

export type RevisionDiff = {
  readonly before_version_id: Id;
  readonly after_version_id: Id;
  readonly changed_slots: readonly Slot[];
  readonly added_action_ids: readonly Id[];
  readonly removed_action_ids: readonly Id[];
  readonly changed_gate_bindings: readonly GateBindingChange[];
  readonly changed_effect_bindings: readonly EffectBindingChange[];
  readonly affected_endings: readonly Id[];
  readonly unchanged: {
    readonly world: boolean;
    readonly core: boolean;
    readonly ports: boolean;
    readonly modules: Readonly<Partial<Record<Slot, boolean>>>;
  };
  /** True only when the replay witness demonstrates it. */
  readonly mechanical_change: boolean;
  /** True when something changed but nothing mechanical did. */
  readonly wording_change_only: boolean;
  /** True when the two scenes have the same text-stripped structure. */
  readonly structure_identical: boolean;
  readonly witness: MechanicalWitness;
  /** The explicit same-choices replay, when a prefix was supplied. */
  readonly replay: ReplayObservation | null;
  readonly copy_only_changes: readonly CopyOnlyChange[];
  readonly summary: readonly string[];
};

export function compareVersions(
  before: Scene,
  after: Scene,
  options: Partial<WitnessLimits> & { replayPrefix?: readonly Id[] } = {},
): RevisionDiff {
  const limits: Partial<WitnessLimits> = {
    ...(options.maxPairs === undefined ? {} : { maxPairs: options.maxPairs }),
    ...(options.explore === undefined ? {} : { explore: options.explore }),
  };
  const beforeHashes = sceneHashes(before);
  const afterHashes = sceneHashes(after);

  const beforeActions = new Map(
    allActions(before).map((entry) => [entry.action.id, entry]),
  );
  const afterActions = new Map(
    allActions(after).map((entry) => [entry.action.id, entry]),
  );
  const added = [...afterActions.keys()].filter((id) => !beforeActions.has(id)).sort();
  const removed = [...beforeActions.keys()].filter((id) => !afterActions.has(id)).sort();

  const changedSlots = SLOTS.filter(
    (slot) => beforeHashes.modules[slot] !== afterHashes.modules[slot],
  );

  const changedGates = diffGateBindings(before, after);
  const changedEffects = diffEffectBindings(before, after);
  const copyChanges = diffEndingCopy(before, after);

  const witness = findMechanicalWitness(before, after, limits);
  const signatureEqual =
    hashCanonical(mechanicalSignature(before)) ===
    hashCanonical(mechanicalSignature(after));
  const mechanical = witness.mechanical;
  const anythingChanged = beforeHashes.scene !== afterHashes.scene;

  const affectedEndings = [
    ...new Set([
      ...copyChanges.map((change) => change.ending_id),
      ...witness.observations
        .filter((observation) => observation.kind === "ending_reachability")
        .flatMap((observation) =>
          [...splitSet(observation.before), ...splitSet(observation.after)],
        ),
    ]),
  ].sort();

  const diff: Omit<RevisionDiff, "summary"> = {
    before_version_id: before.scene_id,
    after_version_id: after.scene_id,
    changed_slots: changedSlots,
    added_action_ids: added,
    removed_action_ids: removed,
    changed_gate_bindings: changedGates,
    changed_effect_bindings: changedEffects,
    affected_endings: affectedEndings,
    unchanged: {
      world: beforeHashes.world === afterHashes.world,
      core: beforeHashes.core === afterHashes.core,
      ports: beforeHashes.ports === afterHashes.ports,
      modules: Object.fromEntries(
        SLOTS.map((slot) => [slot, beforeHashes.modules[slot] === afterHashes.modules[slot]]),
      ) as Partial<Record<Slot, boolean>>,
    },
    mechanical_change: mechanical,
    wording_change_only: anythingChanged && !mechanical,
    structure_identical: signatureEqual,
    witness,
    replay:
      options.replayPrefix === undefined
        ? null
        : observeReplayPrefix(before, after, options.replayPrefix),
    copy_only_changes: copyChanges,
  };

  return { ...diff, summary: summarize(diff) };
}

function summarize(diff: Omit<RevisionDiff, "summary">): string[] {
  const lines: string[] = [];
  if (diff.mechanical_change) {
    // An explicit replay prefix is the product's own comparison, so it
    // outranks whichever divergence the paired traversal happened to reach
    // first.
    const replayed = diff.replay?.changed_action_ids ?? [];
    if (diff.replay !== null && replayed.length > 0) {
      for (const actionId of replayed) {
        lines.push(
          `Interaction changed: after the same choices, "${actionId}" is ${diff.replay.before[actionId] ?? "hidden"} before and ${diff.replay.after[actionId] ?? "hidden"} after.`,
        );
      }
    } else {
      const first = diff.witness.observations.find(
        (observation) =>
          observation.kind === "action_availability" ||
          observation.kind === "ending_reachability",
      );
      if (first !== undefined && first.kind === "action_availability") {
        lines.push(
          `Interaction changed: after ${describePrefix(first.prefix)}, "${first.action_id}" is ${first.before} before and ${first.after} after.`,
        );
      } else if (first !== undefined) {
        lines.push(
          `Outcome availability changed: after ${describePrefix(first.prefix)}, reachable endings go from ${first.before} to ${first.after}.`,
        );
      }
    }
  } else if (diff.wording_change_only) {
    lines.push(
      diff.structure_identical
        ? "Wording changed; interaction unchanged."
        : "Structure was edited but replay shows no changed interaction; recorded as a wording change.",
    );
  } else {
    lines.push("No change.");
  }
  if (diff.copy_only_changes.length > 0) {
    lines.push(
      `Ending wording edited: ${diff.copy_only_changes.map((change) => change.ending_id).join(", ")}.`,
    );
  }
  lines.push(
    `Fixed details preserved: world ${diff.unchanged.world ? "unchanged" : "CHANGED"}, core ${diff.unchanged.core ? "unchanged" : "CHANGED"}, ports ${diff.unchanged.ports ? "unchanged" : "CHANGED"}.`,
  );
  return lines;
}

function allActions(scene: Scene): { owner: string; action: Action }[] {
  return [
    ...scene.core.actions.map((action) => ({ owner: "core", action })),
    ...scene.modules.flatMap((module) =>
      module.actions.map((action) => ({ owner: module.slot as string, action })),
    ),
  ];
}

function diffGateBindings(before: Scene, after: Scene): GateBindingChange[] {
  const changes: GateBindingChange[] = [];
  for (const slot of SLOTS) {
    const beforeModule = before.modules.find((module) => module.slot === slot);
    const afterModule = after.modules.find((module) => module.slot === slot);
    const beforeGates = new Map(
      (beforeModule?.gates ?? []).map((gate) => [gate.id, gate]),
    );
    const afterGates = new Map(
      (afterModule?.gates ?? []).map((gate) => [gate.id, gate]),
    );
    for (const id of [...new Set([...beforeGates.keys(), ...afterGates.keys()])].sort()) {
      const left = beforeGates.get(id);
      const right = afterGates.get(id);
      const leftWhen = left === undefined ? null : left.when;
      const rightWhen = right === undefined ? null : right.when;
      if (hashCanonical(leftWhen) === hashCanonical(rightWhen)) continue;
      changes.push({
        slot,
        gate_id: id,
        action_id: (right ?? left)?.action_id ?? id,
        before: leftWhen,
        after: rightWhen,
      });
    }
  }
  return changes;
}

function diffEffectBindings(before: Scene, after: Scene): EffectBindingChange[] {
  const changes: EffectBindingChange[] = [];
  const beforeMap = effectBindings(before);
  const afterMap = effectBindings(after);
  for (const key of [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()) {
    const left = beforeMap.get(key) ?? { owner: "", effects: [] };
    const right = afterMap.get(key) ?? { owner: "", effects: [] };
    if (hashCanonical(left.effects) === hashCanonical(right.effects)) continue;
    changes.push({
      owner: right.owner || left.owner,
      definition_id: key,
      before: left.effects,
      after: right.effects,
    });
  }
  return changes;
}

function effectBindings(
  scene: Scene,
): Map<Id, { owner: string; effects: Id[] }> {
  const map = new Map<Id, { owner: string; effects: Id[] }>();
  for (const { owner, action } of allActions(scene)) {
    map.set(action.id, {
      owner,
      effects: action.branches.flatMap((branch) => signEffects(branch.effects) as Id[]),
    });
  }
  for (const module of scene.modules) {
    for (const hook of module.on_actions) {
      map.set(hook.id, {
        owner: module.slot,
        effects: signEffects(hook.effects) as Id[],
      });
    }
  }
  return map;
}

function diffEndingCopy(before: Scene, after: Scene): CopyOnlyChange[] {
  const changes: CopyOnlyChange[] = [];
  const beforeView = viewOf(before);
  const afterView = viewOf(after);
  for (const ending of afterView.endings) {
    const previous = beforeView.endingById.get(ending.id);
    if (previous === undefined || previous.text === ending.text) continue;
    changes.push({ ending_id: ending.id, before: previous.text, after: ending.text });
  }
  return changes;
}

function describePrefix(prefix: readonly Id[]): string {
  return prefix.length === 0 ? "no choices" : `the choices ${prefix.join(" -> ")}`;
}

function splitSet(value: string): Id[] {
  return value === "none" ? [] : value.split(", ").filter((part) => part.length > 0);
}
