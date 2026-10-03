/**
 * Pure deterministic runtime (specification section 4, "Condition/effect
 * semantics", and section 5). No React, no server, no randomness, no clock,
 * no network. The browser player, the Vitest suites, the validator, and the
 * fixture script all execute exactly these functions.
 *
 * Execution order for one action, every part of which is evaluated against
 * the PRE-ACTION state:
 *
 *   1. action availability (`action.when`)
 *   2. gates (every gate on the action must PASS — see `gatesPass`)
 *   3. branch selection (exactly one branch's `when` must hold)
 *   4. on-action hook conditions
 *   5. apply the union of permitted `set_true` effects atomically
 *   6. emit branch dialogue
 *   7. emit matching owned hook dialogue in fixed slot order
 *   8. resolve the ending named by the selected branch, if any
 */

import type {
  Action,
  Condition,
  Effect,
  Ending,
  Id,
  Scene,
  Slot,
  Target,
  Verb,
} from "../domain/scene";
import type { ComposedView, Owner } from "./compose";
import { viewOf } from "./compose";

/** A stable ordered bitset over at most twelve flags. All flags start false. */
export type State = { readonly bits: number };

export type TranscriptLine = {
  readonly dialogue_id: Id;
  readonly speaker_id: Id;
  readonly text: string;
  readonly owner: Owner;
};

export type BlockedReason = {
  readonly gate_id: Id;
  readonly slot: Slot;
  readonly text: string;
};

export type AvailableAction = {
  readonly action_id: Id;
  readonly owner: Owner;
  readonly verb: Verb;
  readonly label: string;
  readonly target: Target;
  /** True when `action.when` holds and every gate on the action passes. */
  readonly enabled: boolean;
  /** The first failing gate, in fixed slot order, or null when enabled. */
  readonly blocked: BlockedReason | null;
};

export type StepFailureCode =
  | "UNKNOWN_ACTION"
  | "ACTION_UNAVAILABLE"
  | "ACTION_GATED"
  | "NO_APPLICABLE_BRANCH"
  | "AMBIGUOUS_BRANCH";

export type StepResult =
  | {
      readonly ok: true;
      readonly action_id: Id;
      readonly state: State;
      readonly set_true: readonly Id[];
      readonly dialogue: readonly TranscriptLine[];
      readonly ending: Ending | null;
    }
  | {
      readonly ok: false;
      readonly action_id: Id;
      readonly code: StepFailureCode;
      readonly message: string;
      readonly blocked: BlockedReason | null;
    };

export const EMPTY_STATE: State = { bits: 0 };

export function initialState(_scene: Scene): State {
  // Every declared variable has `initial: false`, enforced by the contract.
  return EMPTY_STATE;
}

export function isTrue(view: ComposedView, state: State, varId: Id): boolean {
  const bit = view.variableBit.get(varId);
  if (bit === undefined) return false;
  return (state.bits & (1 << bit)) !== 0;
}

export function trueFlags(view: ComposedView, state: State): Id[] {
  return view.variables
    .filter((entry) => isTrue(view, state, entry.variable.id))
    .map((entry) => entry.variable.id);
}

/**
 * Structured-data condition evaluation. An atom over an undeclared variable
 * fails its clause rather than defaulting to false-equals-true; the validator
 * rejects such references outright, and failing closed keeps an invalid scene
 * from quietly becoming more permissive at runtime.
 */
export function evaluateCondition(
  view: ComposedView,
  state: State,
  condition: Condition,
): boolean {
  if (condition.kind === "always") return true;
  if (condition.kind === "never") return false;
  return condition.clauses.some((clause) =>
    clause.every((atom) => {
      if (!view.variableBit.has(atom.var_id)) return false;
      return isTrue(view, state, atom.var_id) === atom.equals;
    }),
  );
}

/**
 * Gate semantics. `Gate.when` is an ALLOW condition: the gated action is
 * permitted only while every gate on it evaluates TRUE against the pre-action
 * state. It is not a "block when true" condition.
 *
 * In the canonical design this is the whole difference between the variants:
 *   Discovery v1 allows `core.give` after  `discovery.disclosed == true`
 *   Discovery v2 allows `core.give` while  `discovery.disclosed == false`
 */
export function gatesPass(
  view: ComposedView,
  state: State,
  actionId: Id,
): BlockedReason | null {
  const gates = view.gatesByAction.get(actionId) ?? [];
  for (const entry of gates) {
    if (!evaluateCondition(view, state, entry.gate.when)) {
      return {
        gate_id: entry.gate.id,
        slot: entry.owner,
        text: entry.gate.blocked_text,
      };
    }
  }
  return null;
}

/**
 * Actions whose own `when` holds against the pre-action state. A gated action
 * stays in the list with `enabled: false` and a readable explanation, which is
 * what the player UI shows as a locked choice.
 */
export function availableActions(scene: Scene, state: State): AvailableAction[] {
  const view = viewOf(scene);
  const available: AvailableAction[] = [];
  for (const entry of view.actions) {
    if (!evaluateCondition(view, state, entry.action.when)) continue;
    const blocked = gatesPass(view, state, entry.action.id);
    available.push({
      action_id: entry.action.id,
      owner: entry.owner,
      verb: entry.action.verb,
      label: entry.action.label,
      target: entry.action.target,
      enabled: blocked === null,
      blocked,
    });
  }
  return available;
}

export function enabledActions(scene: Scene, state: State): AvailableAction[] {
  return availableActions(scene, state).filter((action) => action.enabled);
}

export type BranchSelection =
  | { readonly ok: true; readonly index: number }
  | { readonly ok: false; readonly matches: readonly number[] };

/** Exactly one branch must apply to an enabled action. */
export function selectBranch(
  view: ComposedView,
  state: State,
  action: Action,
): BranchSelection {
  const matches: number[] = [];
  action.branches.forEach((branch, index) => {
    if (evaluateCondition(view, state, branch.when)) matches.push(index);
  });
  if (matches.length === 1) return { ok: true, index: matches[0] as number };
  return { ok: false, matches };
}

/**
 * Only the owner of a variable may write it. Composition keeps that ownership,
 * so an effect declared by a module can never commit a write to the core or to
 * another slot even if the surrounding scene claims otherwise. The validator
 * rejects such a scene; this filter means it cannot take effect in the
 * meantime.
 */
function permittedWrites(
  view: ComposedView,
  owner: Owner,
  effects: readonly Effect[],
): Id[] {
  return effects
    .filter((effect) => view.variableOwner.get(effect.var_id) === owner)
    .map((effect) => effect.var_id);
}

function applyWrites(view: ComposedView, state: State, varIds: readonly Id[]): State {
  let bits = state.bits;
  for (const varId of varIds) {
    const bit = view.variableBit.get(varId);
    if (bit !== undefined) bits |= 1 << bit;
  }
  return { bits };
}

export function step(scene: Scene, state: State, actionId: Id): StepResult {
  const view = viewOf(scene);
  const entry = view.actionById.get(actionId);
  if (entry === undefined) {
    return {
      ok: false,
      action_id: actionId,
      code: "UNKNOWN_ACTION",
      message: `no action with id "${actionId}"`,
      blocked: null,
    };
  }

  const { action, owner } = entry;

  if (!evaluateCondition(view, state, action.when)) {
    return {
      ok: false,
      action_id: actionId,
      code: "ACTION_UNAVAILABLE",
      message: `"${actionId}" is not available in this state`,
      blocked: null,
    };
  }

  const blocked = gatesPass(view, state, actionId);
  if (blocked !== null) {
    return {
      ok: false,
      action_id: actionId,
      code: "ACTION_GATED",
      message: blocked.text,
      blocked,
    };
  }

  const selection = selectBranch(view, state, action);
  if (!selection.ok) {
    return {
      ok: false,
      action_id: actionId,
      code: selection.matches.length === 0 ? "NO_APPLICABLE_BRANCH" : "AMBIGUOUS_BRANCH",
      message:
        selection.matches.length === 0
          ? `no branch of "${actionId}" applies in this state`
          : `${selection.matches.length} branches of "${actionId}" apply in this state`,
      blocked: null,
    };
  }

  const branch = action.branches[selection.index] as Action["branches"][number];

  // Hooks are matched against the pre-action state, before any write commits.
  const firingHooks = (view.hooksByAction.get(actionId) ?? []).filter((hook) =>
    evaluateCondition(view, state, hook.hook.when),
  );

  const writes = [
    ...permittedWrites(view, owner, branch.effects),
    ...firingHooks.flatMap((hook) =>
      permittedWrites(view, hook.owner, hook.hook.effects),
    ),
  ];
  const uniqueWrites = [...new Set(writes)];
  const nextState = applyWrites(view, state, uniqueWrites);

  const dialogue: TranscriptLine[] = [];
  pushDialogue(view, dialogue, branch.dialogue_id);
  for (const hook of firingHooks) pushDialogue(view, dialogue, hook.hook.dialogue_id);

  const ending =
    branch.ending_id === null ? null : view.endingById.get(branch.ending_id) ?? null;

  return {
    ok: true,
    action_id: actionId,
    state: nextState,
    set_true: uniqueWrites.filter((varId) => !isTrue(view, state, varId)),
    dialogue,
    ending,
  };
}

function pushDialogue(
  view: ComposedView,
  into: TranscriptLine[],
  dialogueId: Id | null,
): void {
  if (dialogueId === null) return;
  const entry = view.dialogueById.get(dialogueId);
  if (entry === undefined) return;
  into.push({
    dialogue_id: entry.node.id,
    speaker_id: entry.node.speaker_id,
    text: entry.node.text,
    owner: entry.owner,
  });
}

/** Replay stored action ids from a fresh initial state. */
export type ReplayStep = {
  readonly action_id: Id;
  readonly result: StepResult;
};

export type Replay = {
  readonly state: State;
  readonly steps: readonly ReplayStep[];
  readonly stopped_at: Id | null;
  readonly ending: Ending | null;
};

export function replay(scene: Scene, actionIds: readonly Id[]): Replay {
  let state = initialState(scene);
  const steps: ReplayStep[] = [];
  let ending: Ending | null = null;
  for (const actionId of actionIds) {
    const result = step(scene, state, actionId);
    steps.push({ action_id: actionId, result });
    if (!result.ok) {
      return { state, steps, stopped_at: actionId, ending };
    }
    state = result.state;
    ending = result.ending;
    if (ending !== null) break;
  }
  return { state, steps, stopped_at: null, ending };
}

export function speakerLabel(scene: Scene, speakerId: Id): string {
  if (speakerId === "player") return "You";
  if (speakerId === "narrator") return "Narration";
  const npc = scene.world.characters[0];
  return npc.id === speakerId ? npc.name : speakerId;
}
