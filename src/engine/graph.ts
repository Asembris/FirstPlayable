/**
 * Exhaustive finite-state exploration (specification section 5, "Layer B").
 *
 * State is a stable ordered bitset of at most twelve flags, so the nonterminal
 * state space is bounded by 2^12. Every nonterminal transition must add a
 * previously false flag, which makes the reachable graph acyclic and lets the
 * reachable-ending set be computed by reverse traversal.
 *
 * Exhaustion of a resource bound is an explicit failure. This module never
 * truncates exploration and returns a partial graph as if it were complete.
 */

import { ANALYSIS } from "../domain/limits";
import type { Id, Scene } from "../domain/scene";
import { viewOf } from "./compose";
import type { ComposedView } from "./compose";
import {
  availableActions,
  evaluateCondition,
  initialState,
  step,
  trueFlags,
} from "./interpreter";

export type Availability = "enabled" | "locked";

export type GraphEdge = {
  readonly from: number;
  readonly action_id: Id;
  readonly to: number | null;
  readonly ending_id: Id | null;
  readonly set_true: readonly Id[];
};

export type GraphProblem = {
  readonly code:
    | "NO_APPLICABLE_BRANCH"
    | "AMBIGUOUS_BRANCH"
    | "NO_PROGRESS"
    | "STEP_REFUSED";
  readonly message: string;
  readonly action_id: Id;
  readonly true_flags: readonly Id[];
};

export type GateObservation = { passed: boolean; blocked: boolean };

export type SceneGraph = {
  readonly states: readonly number[];
  readonly edges: readonly GraphEdge[];
  readonly edgesFrom: ReadonlyMap<number, readonly GraphEdge[]>;
  /** Minimum number of actions from the initial state. */
  readonly depth: ReadonlyMap<number, number>;
  /** Longest remaining action count from a state to any ending. */
  readonly remainingDepth: ReadonlyMap<number, number>;
  readonly endingsFrom: ReadonlyMap<number, ReadonlySet<Id>>;
  readonly availability: ReadonlyMap<number, ReadonlyMap<Id, Availability>>;
  readonly gateObservations: ReadonlyMap<Id, GateObservation>;
  readonly firedHooks: ReadonlySet<Id>;
  readonly evaluatedHooks: ReadonlySet<Id>;
  readonly selectedBranches: ReadonlyMap<Id, ReadonlySet<number>>;
  readonly enabledSomewhere: ReadonlySet<Id>;
  readonly minActionsToEnding: ReadonlyMap<Id, number>;
  readonly problems: readonly GraphProblem[];
  readonly maxDepth: number;
};

export type ExploreLimits = {
  readonly maxStates: number;
  readonly timeBudgetMs: number;
};

export const DEFAULT_EXPLORE_LIMITS: ExploreLimits = {
  maxStates: ANALYSIS.max_states,
  timeBudgetMs: ANALYSIS.graph_time_budget_ms,
};

export type ExploreResult =
  | { readonly ok: true; readonly graph: SceneGraph }
  | {
      readonly ok: false;
      readonly code: "VALIDATION_RESOURCE_LIMIT";
      readonly message: string;
    };

export function exploreScene(
  scene: Scene,
  limits: Partial<ExploreLimits> = {},
): ExploreResult {
  const { maxStates, timeBudgetMs } = { ...DEFAULT_EXPLORE_LIMITS, ...limits };
  const view = viewOf(scene);
  const startedAt = Date.now();

  const states: number[] = [];
  const edges: GraphEdge[] = [];
  const edgesFrom = new Map<number, GraphEdge[]>();
  const depth = new Map<number, number>();
  const availability = new Map<number, Map<Id, Availability>>();
  const gateObservations = new Map<Id, GateObservation>();
  const firedHooks = new Set<Id>();
  const evaluatedHooks = new Set<Id>();
  const selectedBranches = new Map<Id, Set<number>>();
  const enabledSomewhere = new Set<Id>();
  const problems: GraphProblem[] = [];

  const start = initialState(scene).bits;
  const queue: number[] = [start];
  depth.set(start, 0);
  const seen = new Set<number>([start]);

  while (queue.length > 0) {
    if (seen.size > maxStates) {
      return resourceLimit(
        `reachable nonterminal states exceeded the ${maxStates}-state analysis bound`,
      );
    }
    if (Date.now() - startedAt > timeBudgetMs) {
      return resourceLimit(
        `graph analysis exceeded the ${timeBudgetMs}ms ceiling after ${states.length} states`,
      );
    }

    const bits = queue.shift() as number;
    states.push(bits);
    const state = { bits };
    const outgoing: GraphEdge[] = [];
    const localAvailability = new Map<Id, Availability>();

    observeGates(view, state, gateObservations);

    for (const candidate of availableActions(scene, state)) {
      localAvailability.set(
        candidate.action_id,
        candidate.enabled ? "enabled" : "locked",
      );
      if (!candidate.enabled) continue;
      enabledSomewhere.add(candidate.action_id);

      const result = step(scene, state, candidate.action_id);
      if (!result.ok) {
        problems.push({
          code:
            result.code === "NO_APPLICABLE_BRANCH" ||
            result.code === "AMBIGUOUS_BRANCH"
              ? result.code
              : "STEP_REFUSED",
          message: result.message,
          action_id: candidate.action_id,
          true_flags: trueFlags(view, state),
        });
        continue;
      }

      const entry = view.actionById.get(candidate.action_id);
      if (entry !== undefined) {
        recordSelectedBranch(view, state, entry.action.id, selectedBranches);
      }
      observeHooks(view, state, candidate.action_id, evaluatedHooks, firedHooks);

      if (result.ending !== null) {
        const edge: GraphEdge = {
          from: bits,
          action_id: candidate.action_id,
          to: null,
          ending_id: result.ending.id,
          set_true: result.set_true,
        };
        edges.push(edge);
        outgoing.push(edge);
        continue;
      }

      if (result.state.bits === bits) {
        problems.push({
          code: "NO_PROGRESS",
          message: `enabled nonterminal action "${candidate.action_id}" sets no previously false flag`,
          action_id: candidate.action_id,
          true_flags: trueFlags(view, state),
        });
        continue;
      }

      const edge: GraphEdge = {
        from: bits,
        action_id: candidate.action_id,
        to: result.state.bits,
        ending_id: null,
        set_true: result.set_true,
      };
      edges.push(edge);
      outgoing.push(edge);

      if (!seen.has(result.state.bits)) {
        seen.add(result.state.bits);
        depth.set(result.state.bits, (depth.get(bits) ?? 0) + 1);
        queue.push(result.state.bits);
      }
    }

    edgesFrom.set(bits, outgoing);
    availability.set(bits, localAvailability);
  }

  // Reverse traversal over the acyclic graph: each nonterminal edge adds a
  // flag, so processing states by descending popcount resolves every
  // dependency before it is read.
  const order = [...states].sort((a, b) => popcount(b) - popcount(a));
  const endingsFrom = new Map<number, ReadonlySet<Id>>();
  const remainingDepth = new Map<number, number>();
  for (const bits of order) {
    const reachable = new Set<Id>();
    let longest = 0;
    for (const edge of edgesFrom.get(bits) ?? []) {
      if (edge.ending_id !== null) {
        reachable.add(edge.ending_id);
        longest = Math.max(longest, 1);
        continue;
      }
      for (const ending of endingsFrom.get(edge.to as number) ?? []) {
        reachable.add(ending);
      }
      longest = Math.max(longest, 1 + (remainingDepth.get(edge.to as number) ?? 0));
    }
    endingsFrom.set(bits, reachable);
    remainingDepth.set(bits, longest);
  }

  const minActionsToEnding = new Map<Id, number>();
  for (const edge of edges) {
    if (edge.ending_id === null) continue;
    const actions = (depth.get(edge.from) ?? 0) + 1;
    const current = minActionsToEnding.get(edge.ending_id);
    if (current === undefined || actions < current) {
      minActionsToEnding.set(edge.ending_id, actions);
    }
  }

  return {
    ok: true,
    graph: {
      states,
      edges,
      edgesFrom,
      depth,
      remainingDepth,
      endingsFrom,
      availability,
      gateObservations,
      firedHooks,
      evaluatedHooks,
      selectedBranches,
      enabledSomewhere,
      minActionsToEnding,
      problems,
      maxDepth: remainingDepth.get(start) ?? 0,
    },
  };
}

function resourceLimit(message: string): ExploreResult {
  return { ok: false, code: "VALIDATION_RESOURCE_LIMIT", message };
}

function observeGates(
  view: ComposedView,
  state: { bits: number },
  into: Map<Id, GateObservation>,
): void {
  for (const [actionId, gates] of view.gatesByAction) {
    const action = view.actionById.get(actionId);
    if (action === undefined) continue;
    // A gate is only meaningfully observed where its action is itself offered.
    if (!evaluateCondition(view, state, action.action.when)) continue;
    for (const entry of gates) {
      const observation =
        into.get(entry.gate.id) ?? { passed: false, blocked: false };
      if (evaluateCondition(view, state, entry.gate.when)) observation.passed = true;
      else observation.blocked = true;
      into.set(entry.gate.id, observation);
    }
  }
}

function observeHooks(
  view: ComposedView,
  state: { bits: number },
  actionId: Id,
  evaluated: Set<Id>,
  fired: Set<Id>,
): void {
  for (const entry of view.hooksByAction.get(actionId) ?? []) {
    evaluated.add(entry.hook.id);
    if (evaluateCondition(view, state, entry.hook.when)) fired.add(entry.hook.id);
  }
}

function recordSelectedBranch(
  view: ComposedView,
  state: { bits: number },
  actionId: Id,
  into: Map<Id, Set<number>>,
): void {
  const entry = view.actionById.get(actionId);
  if (entry === undefined) return;
  entry.action.branches.forEach((branch, index) => {
    if (!evaluateCondition(view, state, branch.when)) return;
    const bucket = into.get(actionId) ?? new Set<number>();
    bucket.add(index);
    into.set(actionId, bucket);
  });
}

export function popcount(bits: number): number {
  let value = bits;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

export function isStrictSubset(
  inner: ReadonlySet<Id>,
  outer: ReadonlySet<Id>,
): boolean {
  if (inner.size >= outer.size) return false;
  for (const value of inner) if (!outer.has(value)) return false;
  return true;
}

export function sameSet(a: ReadonlySet<Id>, b: ReadonlySet<Id>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
