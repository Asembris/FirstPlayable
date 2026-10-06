/**
 * The Rehearsal Table's presentation model.
 *
 * Pure functions over the real engine: every row, lock, requirement, count,
 * and transcript line is computed by `availableActions`, `step`, and
 * `observeReplayPrefix` from the stored scenes. Nothing here invents a state
 * the engine does not report, and nothing rewrites stored copy; the only text
 * composed here is the instrument's own framing ("Open", "Locked · needs:",
 * counts) around stored labels.
 */

import type { Ending, Id, Scene } from "../domain/scene";
import { viewOf } from "../engine/compose";
import { observeReplayPrefix } from "../engine/diff";
import {
  availableActions,
  evaluateCondition,
  initialState,
  speakerLabel,
  step,
} from "../engine/interpreter";
import type { State } from "../engine/interpreter";
import type { Availability, CanonicalPair } from "./canonical-pair";

export type Side = "with" | "without";

/* ------------------------------------------------------------- wording */

const NUMBER_WORDS = [
  "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
] as const;

export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** Lower-cases only the first character, so names inside a label survive. */
export function lowerFirst(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** "a", "a, and b", "a, b, and c" — the handoff's requirement list form. */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1] as string}`;
}

/** "1" → "01": the gutter's line number. */
export function lineNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/* ------------------------------------------------------------- engine reads */

export type Run = {
  readonly legal: boolean;
  readonly state: State;
};

/** Replays non-ending choices from a fresh state, stopping at the first refusal. */
export function runChoices(scene: Scene, choices: readonly Id[]): Run {
  let state = initialState(scene);
  for (const id of choices) {
    const result = step(scene, state, id);
    if (!result.ok || result.ending !== null) return { legal: false, state };
    state = result.state;
  }
  return { legal: true, state };
}

/** Every gate on the action that fails in this state, in fixed slot order. */
function unmetGates(scene: Scene, state: State, actionId: Id) {
  const view = viewOf(scene);
  return (view.gatesByAction.get(actionId) ?? []).filter(
    (entry) => !evaluateCondition(view, state, entry.gate.when),
  );
}

/**
 * The action whose effects make a gate pass: the first action (or hook owner
 * action) that sets a variable the gate's allow-condition needs to be true.
 */
function setterOf(scene: Scene, gateId: Id): { id: Id; label: string } | null {
  const view = viewOf(scene);
  for (const gates of view.gatesByAction.values()) {
    const entry = gates.find((candidate) => candidate.gate.id === gateId);
    if (entry === undefined) continue;
    const when = entry.gate.when;
    const needed = new Set(
      when.kind === "any"
        ? when.clauses.flatMap((clause) =>
            clause.filter((atom) => atom.equals).map((atom) => atom.var_id),
          )
        : [],
    );
    for (const { action } of view.actions) {
      const sets = action.branches.some((branch) =>
        branch.effects.some((effect) => needed.has(effect.var_id)),
      );
      if (sets) return { id: action.id, label: action.label };
    }
  }
  return null;
}

/**
 * Every unmet requirement on an action, each named by the label of the action
 * that satisfies it (or, failing that, by the gate's own stored text).
 */
export function requirementsOf(scene: Scene, state: State, actionId: Id): string[] {
  return unmetGates(scene, state, actionId).map((entry) => {
    const setter = setterOf(scene, entry.gate.id);
    return setter === null ? entry.gate.blocked_text : lowerFirst(setter.label);
  });
}

function endingIfTaken(scene: Scene, state: State, actionId: Id): Ending | null {
  const result = step(scene, state, actionId);
  return result.ok ? result.ending : null;
}

/* ------------------------------------------------------------- transcript */

export type TranscriptEntry =
  | { readonly kind: "choice"; readonly key: string; readonly text: string }
  | {
      readonly kind: "line";
      readonly key: string;
      readonly speaker: string;
      readonly narration: boolean;
      readonly text: string;
    }
  | { readonly kind: "ending"; readonly key: string; readonly title: string; readonly text: string };

export type Taken = {
  readonly choices: readonly Id[];
  /** The action that ended the scene, if one did. */
  readonly endingActionId: Id | null;
};

/** The play-script transcript: each choice, then what it produced, verbatim. */
export function transcriptOf(scene: Scene, taken: Taken): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const view = viewOf(scene);
  let state = initialState(scene);
  const ids = taken.endingActionId === null ? taken.choices : [...taken.choices, taken.endingActionId];
  ids.forEach((id, index) => {
    const result = step(scene, state, id);
    if (!result.ok) return;
    entries.push({ kind: "choice", key: `c${index}`, text: view.actionById.get(id)?.action.label ?? "" });
    result.dialogue.forEach((line, lineIndex) => {
      const narration = line.speaker_id === "narrator";
      entries.push({
        kind: "line",
        key: `l${index}-${lineIndex}`,
        speaker: narration ? "" : speakerLabel(scene, line.speaker_id),
        narration,
        text: line.text,
      });
    });
    if (result.ending !== null) {
      entries.push({ kind: "ending", key: `e${index}`, title: result.ending.title, text: result.ending.text });
    }
    state = result.state;
  });
  return entries;
}

/* ------------------------------------------------------------- play rows */

export type PlayRow = {
  readonly id: Id;
  readonly label: string;
  readonly enabled: boolean;
  /** The first unmet requirement, verbatim, plus "+N more requirement". */
  readonly reason: string | null;
  /** Bound to the approved influence (a module action, or gated by one). */
  readonly marked: boolean;
};

/** Ids the approved influence's provenance names, or none without it. */
function influenceMechanics(scene: Scene): Set<Id> {
  return new Set(scene.provenance.flatMap((entry) => entry.mechanic_ids));
}

export function playRows(scene: Scene, state: State): PlayRow[] {
  const mechanics = influenceMechanics(scene);
  const view = viewOf(scene);
  return availableActions(scene, state).map((action) => {
    const unmet = unmetGates(scene, state, action.action_id);
    const first = unmet[0];
    const more = unmet.length - 1;
    const gated = (view.gatesByAction.get(action.action_id) ?? []).some((entry) =>
      mechanics.has(entry.gate.id),
    );
    return {
      id: action.action_id,
      label: action.label,
      enabled: action.enabled,
      reason:
        first === undefined
          ? null
          : `Locked · ${first.gate.blocked_text}${more > 0 ? ` +${more} more requirement${more === 1 ? "" : "s"}` : ""}`,
      marked: mechanics.has(action.action_id) || gated,
    };
  });
}

/* ------------------------------------------------------------- comparison */

export type CompareCell = {
  readonly status: Availability;
  /** The instrument's reading of this action on this side. */
  readonly note: string;
};

export type CompareRowKind = "unchanged" | "changed" | "added" | "removed";

export type CompareRow = {
  readonly id: Id;
  readonly label: string;
  readonly kind: CompareRowKind;
  readonly without: CompareCell;
  readonly with: CompareCell;
};

export type Comparison = {
  readonly prefix: readonly Id[];
  readonly prefixLabels: readonly string[];
  /** True when the player's own choices are the comparison point. */
  readonly mine: boolean;
  /** True when the player's choices could not be replayed in both versions. */
  readonly fellBack: boolean;
  readonly rows: readonly CompareRow[];
  readonly changedCount: number;
  readonly unchangedCount: number;
  /** Room, NPC, and object are identical in both versions. */
  readonly sameWorld: boolean;
};

/**
 * Which point to compare: the player's own choices when they are legal in
 * both versions, otherwise the stored `diff.replay.prefix`. Standing exactly
 * on the recorded point (where the saved example opens) is the recorded point,
 * not a choice the visitor made.
 */
export function comparisonPoint(
  pair: CanonicalPair,
  choices: readonly Id[],
): { prefix: readonly Id[]; mine: boolean; fellBack: boolean } {
  const recorded =
    choices.length === pair.recordedPrefix.length &&
    choices.every((id, index) => pair.recordedPrefix[index] === id);
  if (choices.length > 0 && !recorded) {
    const legal =
      runChoices(pair.withScene, choices).legal && runChoices(pair.withoutScene, choices).legal;
    if (legal) return { prefix: choices, mine: true, fellBack: false };
    return { prefix: pair.recordedPrefix, mine: false, fellBack: true };
  }
  return { prefix: pair.recordedPrefix, mine: false, fellBack: false };
}

function cellNote(
  pair: CanonicalPair,
  scene: Scene,
  state: State,
  actionId: Id,
  status: Availability,
  other: Availability,
  side: Side,
): string {
  if (status === "hidden") return "Not in this version";
  if (status === "locked") {
    return `Locked · needs: ${listOf(requirementsOf(scene, state, actionId))}`;
  }
  if (other === "hidden" && side === "with") return `Added with ${pair.influenceName} · open now`;
  const ending = endingIfTaken(scene, state, actionId);
  return ending === null ? "Open" : `Open · ends the scene: ${ending.title}`;
}

export function compareAt(pair: CanonicalPair, choices: readonly Id[]): Comparison {
  const point = comparisonPoint(pair, choices);
  // `observeReplayPrefix(before, after)` reads before = with the influence.
  const observed = observeReplayPrefix(pair.withScene, pair.withoutScene, point.prefix);
  const withRun = runChoices(pair.withScene, point.prefix);
  const withoutRun = runChoices(pair.withoutScene, point.prefix);
  const changed = new Set(observed.changed_action_ids);

  // Scene order: the With list, then anything only the Without list offers.
  const order = [
    ...availableActions(pair.withScene, withRun.state).map((a) => a.action_id),
    ...availableActions(pair.withoutScene, withoutRun.state)
      .map((a) => a.action_id)
      .filter((id) => observed.before[id] === undefined),
  ];
  const labelOf = (id: Id): string =>
    viewOf(pair.withScene).actionById.get(id)?.action.label ??
    viewOf(pair.withoutScene).actionById.get(id)?.action.label ??
    "";

  const rows: CompareRow[] = order.map((id) => {
    const withStatus = (observed.before[id] ?? "hidden") as Availability;
    const withoutStatus = (observed.after[id] ?? "hidden") as Availability;
    const kind: CompareRowKind = !changed.has(id)
      ? "unchanged"
      : withoutStatus === "hidden"
        ? "added"
        : withStatus === "hidden"
          ? "removed"
          : "changed";
    return {
      id,
      label: labelOf(id),
      kind,
      with: {
        status: withStatus,
        note: cellNote(pair, pair.withScene, withRun.state, id, withStatus, withoutStatus, "with"),
      },
      without: {
        status: withoutStatus,
        note: cellNote(pair, pair.withoutScene, withoutRun.state, id, withoutStatus, withStatus, "without"),
      },
    };
  });

  const changedCount = rows.filter((row) => row.kind !== "unchanged").length;
  const worldOf = (scene: Scene) => JSON.stringify(scene.world);
  return {
    prefix: point.prefix,
    prefixLabels: point.prefix.map(labelOf),
    mine: point.mine,
    fellBack: point.fellBack,
    rows,
    changedCount,
    unchangedCount: rows.length - changedCount,
    sameWorld: worldOf(pair.withScene) === worldOf(pair.withoutScene),
  };
}

/* ------------------------------------------------------------- causal note */

/** A sentence with emphasised stored labels: strings, and `{ em }` spans. */
export type Phrase = readonly (string | { readonly em: string })[];

function availabilityWord(status: Availability): string {
  return status === "enabled" ? "open" : status === "locked" ? "locked" : "not offered";
}

/**
 * "Scene changed", in player words: the stored witness, with its action id
 * mapped to the action's label and the requirement list taken from the
 * comparison at the witness's own prefix. Returns null without a witness.
 */
export function consequenceOf(pair: CanonicalPair): Phrase | null {
  const witness = pair.causal.witness;
  if (witness === null) return null;
  const comparison = compareAt(pair, witness.prefix);
  const label =
    viewOf(pair.withScene).actionById.get(witness.actionId)?.action.label ?? "";
  const phrase: (string | { em: string })[] = [
    `After the same ${numberWord(witness.prefix.length)} choices, `,
    { em: label },
    ` is ${availabilityWord(witness.with)} with ${pair.influenceName} and ${availabilityWord(witness.without)} without it.`,
  ];

  const added = comparison.rows.filter((row) => row.kind === "added").map((row) => row.id);
  if (added.length > 0) {
    const run = runChoices(pair.withScene, witness.prefix);
    const needs = unmetGates(pair.withScene, run.state, witness.actionId)
      .map((entry) => setterOf(pair.withScene, entry.gate.id)?.id)
      .filter((id): id is Id => id !== undefined);
    const needsAllAdded =
      needs.length === added.length && added.every((id) => needs.includes(id));
    const count = numberWord(added.length);
    if (needsAllAdded) {
      phrase.push(
        ` With ${pair.influenceName}, ${count} choice${added.length === 1 ? " is" : "s are"} added, and `,
        { em: label },
        ` needs ${added.length === 1 ? "it" : added.length === 2 ? "both" : `all ${count}`}.`,
      );
    } else {
      phrase.push(
        ` With ${pair.influenceName}, ${count} choice${added.length === 1 ? " is" : "s are"} added.`,
      );
    }
  }
  return phrase;
}

/** The one-line "why" used on mobile and wherever the full note is folded. */
export function causalSummary(pair: CanonicalPair): string {
  const decided = pair.causal.decision.editedByCreator
    ? "you edited and approved an interpretation"
    : "you approved an interpretation";
  return `Qloo returned ${pair.causal.source.name} · ${decided} · the scene changed.`;
}

/** The first sentence of a stored text, and whether anything follows it. */
export function firstSentence(text: string): { head: string; truncated: boolean } {
  const match = /^.+?[.!?](?=\s|$)/.exec(text);
  if (match === null) return { head: text, truncated: false };
  const head = match[0];
  return { head, truncated: head.length < text.trim().length };
}
