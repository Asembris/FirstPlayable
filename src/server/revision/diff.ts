/**
 * The stored revision diff (specification section 9, "RevisionDiff").
 *
 * This module is a projection, not an analysis. Every judgement in the value it
 * returns comes from the Phase 1 engine:
 *
 *   * `compareVersions` performs the structural comparison, the canonical hash
 *     equality check per owned object, and the bounded paired replay that
 *     decides `mechanical_change`;
 *   * `observeReplayPrefix` performs the explicit same-choices replay;
 *   * the summary sentences are generated from those fields.
 *
 * Nothing here calls a model, and nothing here can declare a change mechanical
 * that the replay did not demonstrate: `label` is read off the engine's own
 * booleans. A renamed flag, different prose, or a reworded ending therefore
 * comes back as `wording`, which is the distinction section 9 requires.
 *
 * The replay prefix is chosen deterministically: the legal prefix that the
 * witness search used to reach its first consequential observation. That is the
 * shortest sequence of real choices at which the two versions provably differ,
 * which is exactly what "replay the same choices" should show.
 */

import type { RevisionDiffView, RevisionKind, RevisionLabel } from "@/domain/revision";
import { RevisionDiffViewSchema } from "@/domain/revision";
import type { Id, Scene, Slot } from "@/domain/scene";
import { SLOTS } from "@/domain/limits";
import { codePointLength } from "@/domain/text";
import { compareVersions, observeReplayPrefix, sceneHashes } from "@/engine/diff";
import type { ReplayObservation, RevisionDiff } from "@/engine/diff";

/** Section 3: at most three default lines. */
const MAX_SUMMARY_LINES = 3;
const MAX_SUMMARY_LENGTH = 300;

export type DiffSide = { readonly versionId: string | null; readonly scene: Scene };

export type RevisionDiffInput = {
  /** The version being revised. `null` for a first version, which has no diff. */
  readonly before: DiffSide | null;
  readonly after: DiffSide;
  /** Which command produced the new version, when one did. */
  readonly changedBy: RevisionKind | null;
  /**
   * The creator's own recorded choices, when the browser supplied them. The
   * witness prefix is used when it is absent, so a stored diff always carries
   * one replay rather than depending on the UI having recorded a playthrough.
   */
  readonly replayPrefix?: readonly Id[];
};

/**
 * Builds the stored diff, or `null` when there is nothing to compare against.
 *
 * `null` is the honest answer for a project's first version: there is no
 * earlier version, so there is no preservation claim to make and no replay to
 * show. It is never used to mean "the comparison failed".
 */
export function revisionDiffView(input: RevisionDiffInput): RevisionDiffView | null {
  if (input.before === null) return null;

  const before = input.before.scene;
  const after = input.after.scene;

  // One paired traversal, then one explicit replay over the prefix it reached.
  const structural = compareVersions(before, after);
  const prefix = input.replayPrefix ?? witnessPrefix(structural);
  const replay = observeReplayPrefix(before, after, prefix);
  const labelled = compareVersions(before, after, { replayPrefix: prefix });

  const hashes = { before: sceneHashes(before), after: sceneHashes(after) };

  const candidate = {
    before_version_id: input.before.versionId,
    after_version_id: input.after.versionId,
    changed_by: input.changedBy,
    changed_slots: [...labelled.changed_slots],
    added_action_ids: [...labelled.added_action_ids].slice(0, 24),
    removed_action_ids: [...labelled.removed_action_ids].slice(0, 24),
    changed_gate_bindings: labelled.changed_gate_bindings.slice(0, 8).map((change) => ({
      slot: change.slot,
      gate_id: change.gate_id,
      action_id: change.action_id,
      // Conditions themselves are not republished here: the question a
      // preservation diff answers is which bindings moved, and the scene on
      // each side already carries the conditions in full.
      present_before: change.before !== null,
      present_after: change.after !== null,
    })),
    changed_effect_bindings: labelled.changed_effect_bindings.slice(0, 24).map((change) => ({
      owner: change.owner.length === 0 ? "core" : change.owner,
      definition_id: change.definition_id,
      before: [...change.before].slice(0, 12),
      after: [...change.after].slice(0, 12),
    })),
    affected_endings: [...labelled.affected_endings].slice(0, 3),
    copy_only_changes: labelled.copy_only_changes.slice(0, 3).map((change) => ({
      ending_id: change.ending_id,
      before_length: codePointLength(change.before),
      after_length: codePointLength(change.after),
    })),
    unchanged: {
      world: labelled.unchanged.world,
      core: labelled.unchanged.core,
      ports: labelled.unchanged.ports,
      modules: Object.fromEntries(
        SLOTS.map((slot) => [slot, labelled.unchanged.modules[slot] === true]),
      ) as Partial<Record<Slot, boolean>>,
    },
    hashes: { before_scene: hashes.before.scene, after_scene: hashes.after.scene },
    label: labelOf(labelled),
    mechanical_change: labelled.mechanical_change,
    wording_change_only: labelled.wording_change_only,
    structure_identical: labelled.structure_identical,
    witness_overflow: labelled.witness.overflow,
    replay: replayView(replay),
    summary: labelled.summary
      .slice(0, MAX_SUMMARY_LINES)
      .map((line) => clamp(line, MAX_SUMMARY_LENGTH)),
  };

  const parsed = RevisionDiffViewSchema.safeParse(candidate);
  // A diff that does not satisfy its own contract is dropped rather than
  // stored partially: the version is still valid, and a missing diff reads as
  // "no comparison is available", never as a false preservation claim.
  return parsed.success ? parsed.data : null;
}

/** The engine's own booleans, named. These three are mutually exclusive. */
export function labelOf(diff: RevisionDiff): RevisionLabel {
  if (diff.mechanical_change) return "mechanical";
  if (diff.wording_change_only) return "wording";
  return "none";
}

/**
 * The legal prefix the witness search reached its first consequential
 * observation at, or the empty prefix when there is none.
 */
function witnessPrefix(diff: RevisionDiff): readonly Id[] {
  const consequential = diff.witness.observations.find(
    (observation) =>
      observation.kind === "action_availability" ||
      observation.kind === "ending_reachability",
  );
  const observation = consequential ?? diff.witness.observations[0];
  return observation === undefined ? [] : observation.prefix.slice(0, 16);
}

function replayView(replay: ReplayObservation): RevisionDiffView["replay"] {
  return {
    prefix: [...replay.prefix].slice(0, 16),
    prefix_legal_in_before: replay.prefix_legal_in_before,
    prefix_legal_in_after: replay.prefix_legal_in_after,
    changed_action_ids: [...replay.changed_action_ids].slice(0, 24),
    before: availability(replay.before),
    after: availability(replay.after),
  };
}

function availability(
  map: Readonly<Record<Id, string>>,
): Record<string, "enabled" | "locked" | "hidden"> {
  const out: Record<string, "enabled" | "locked" | "hidden"> = {};
  for (const [actionId, state] of Object.entries(map)) {
    out[actionId] = state === "enabled" ? "enabled" : state === "locked" ? "locked" : "hidden";
  }
  return out;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
