/**
 * Composer (specification sections 4 and 5).
 *
 * Composition builds a read-only effective view over an immutable clean core
 * and zero to two independently owned influence modules. It never mutates
 * either input, and it never flattens ownership away: every variable, action,
 * dialogue node, gate, and hook in the view carries the owner that declared
 * it, so the validator and the interpreter can enforce the ownership rules
 * without inferring them from prose or from identifier spelling alone.
 *
 * Removing an influence is therefore a recomposition from the clean base, not
 * an attempt to undo mutations inside a flattened scene.
 */

import { SLOTS } from "../domain/limits";
import type {
  Action,
  CoreScene,
  DialogueNode,
  EndingCopyOverride,
  Ending,
  Gate,
  Id,
  InfluenceModule,
  OnAction,
  Scene,
  Slot,
  StateVariable,
} from "../domain/scene";

export type Owner = "core" | Slot;

export type ComposedVariable = { owner: Owner; variable: StateVariable };
export type ComposedAction = { owner: Owner; action: Action };
export type ComposedDialogue = { owner: Owner; node: DialogueNode };
export type ComposedGate = { owner: Slot; gate: Gate };
export type ComposedHook = { owner: Slot; hook: OnAction };

export type ComposedView = {
  /** Stable order: core variables, then module variables in fixed slot order. */
  readonly variables: readonly ComposedVariable[];
  readonly variableBit: ReadonlyMap<Id, number>;
  readonly variableOwner: ReadonlyMap<Id, Owner>;
  readonly actions: readonly ComposedAction[];
  readonly actionById: ReadonlyMap<Id, ComposedAction>;
  readonly dialogueById: ReadonlyMap<Id, ComposedDialogue>;
  readonly endings: readonly Ending[];
  readonly endingById: ReadonlyMap<Id, Ending>;
  readonly gatesByAction: ReadonlyMap<Id, readonly ComposedGate[]>;
  readonly hooksByAction: ReadonlyMap<Id, readonly ComposedHook[]>;
  /** Active slots, in the fixed slot order used for every deterministic tie-break. */
  readonly activeSlots: readonly Slot[];
};

/** Modules are always visited in this order, never in array order. */
export function orderedSlots(modules: readonly InfluenceModule[]): Slot[] {
  return SLOTS.filter((slot) => modules.some((module) => module.slot === slot));
}

export function composeScene(
  core: CoreScene,
  modules: readonly InfluenceModule[],
  endingCopyOverrides: readonly EndingCopyOverride[] = [],
): ComposedView {
  const activeSlots = orderedSlots(modules);
  const orderedModules = activeSlots.map(
    (slot) => modules.find((module) => module.slot === slot) as InfluenceModule,
  );

  const variables: ComposedVariable[] = core.variables.map((variable) => ({
    owner: "core" as Owner,
    variable,
  }));
  const actions: ComposedAction[] = core.actions.map((action) => ({
    owner: "core" as Owner,
    action,
  }));
  const dialogue: ComposedDialogue[] = core.dialogue.map((node) => ({
    owner: "core" as Owner,
    node,
  }));
  const gates: ComposedGate[] = [];
  const hooks: ComposedHook[] = [];

  for (const module of orderedModules) {
    for (const variable of module.variables) {
      variables.push({ owner: module.slot, variable });
    }
    for (const action of module.actions) {
      actions.push({ owner: module.slot, action });
    }
    for (const node of module.dialogue) {
      dialogue.push({ owner: module.slot, node });
    }
    for (const gate of module.gates) gates.push({ owner: module.slot, gate });
    for (const hook of module.on_actions) {
      hooks.push({ owner: module.slot, hook });
    }
  }

  const overrideByEnding = new Map(
    endingCopyOverrides.map((override) => [override.ending_id, override.text]),
  );
  const endings = core.endings.map((ending) => {
    const text = overrideByEnding.get(ending.id);
    // A copy override replaces only that ending's text.
    return text === undefined ? ending : { ...ending, text };
  });

  const variableBit = new Map<Id, number>();
  const variableOwner = new Map<Id, Owner>();
  variables.forEach((entry, index) => {
    variableBit.set(entry.variable.id, index);
    variableOwner.set(entry.variable.id, entry.owner);
  });

  const gatesByAction = groupBy(gates, (entry) => entry.gate.action_id);
  const hooksByAction = groupBy(hooks, (entry) => entry.hook.action_id);

  return Object.freeze({
    variables: Object.freeze(variables),
    variableBit,
    variableOwner,
    actions: Object.freeze(actions),
    actionById: new Map(actions.map((entry) => [entry.action.id, entry])),
    dialogueById: new Map(dialogue.map((entry) => [entry.node.id, entry])),
    endings: Object.freeze(endings),
    endingById: new Map(endings.map((ending) => [ending.id, ending])),
    gatesByAction,
    hooksByAction,
    activeSlots: Object.freeze(activeSlots),
  });
}

function groupBy<T>(items: readonly T[], key: (item: T) => Id): Map<Id, T[]> {
  const grouped = new Map<Id, T[]>();
  for (const item of items) {
    const id = key(item);
    const bucket = grouped.get(id);
    if (bucket === undefined) grouped.set(id, [item]);
    else bucket.push(item);
  }
  return grouped;
}

/* ------------------------------------------------------- per-scene views */

const viewCache = new WeakMap<Scene, ComposedView>();

/** Memoized composition for a scene object. Identical input, identical view. */
export function viewOf(scene: Scene): ComposedView {
  const cached = viewCache.get(scene);
  if (cached !== undefined) return cached;
  const view = composeScene(scene.core, scene.modules, scene.ending_copy_overrides);
  viewCache.set(scene, view);
  return view;
}

/* ------------------------------------------------- module subset recomposition */

/**
 * Recompose the scene with only the named slots active. Influence references
 * and provenance bindings of dropped modules are dropped with them, so a
 * removed module leaves no unowned claim behind.
 */
export function sceneWithModuleSubset(scene: Scene, slots: readonly Slot[]): Scene {
  const keep = new Set(slots);
  const modules = SLOTS.filter((slot) => keep.has(slot))
    .map((slot) => scene.modules.find((module) => module.slot === slot))
    .filter((module): module is InfluenceModule => module !== undefined);
  const approvals = new Set(modules.map((module) => module.approval_id));
  return {
    ...scene,
    modules,
    influences: scene.influences.filter((reference) =>
      approvals.has(reference.approval_id),
    ),
    provenance: scene.provenance.filter((binding) =>
      approvals.has(binding.approval_id),
    ),
  };
}

export function cleanBase(scene: Scene): Scene {
  return sceneWithModuleSubset(scene, []);
}

export function removeModule(scene: Scene, slot: Slot): Scene {
  return sceneWithModuleSubset(
    scene,
    scene.modules.map((module) => module.slot).filter((active) => active !== slot),
  );
}

/** Every subset of the scene's active modules, base first. At most four. */
export function moduleSubsets(scene: Scene): Slot[][] {
  const active = orderedSlots(scene.modules);
  const subsets: Slot[][] = [[]];
  for (const slot of active) {
    for (const subset of [...subsets]) subsets.push([...subset, slot]);
  }
  return subsets.sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
}
