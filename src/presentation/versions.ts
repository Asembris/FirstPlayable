/**
 * Previous version against this version, after the same choices, as rows.
 *
 * The studio's comparison of two builds, read the way the scene page reads
 * the saved pair: one row per action, in scene order, keyed by action id.
 * Unchanged rows say so once; a changed row is split into what the previous
 * version offers and what this version offers. Every status comes from
 * `observeReplayPrefix`, the engine's own replay, so the page never decides
 * that something changed.
 *
 * When the choices cannot be replayed in the previous version, the engine
 * sees nothing there; the rows then say the replay stopped rather than
 * claiming the previous version lacks every action.
 */

import type { Id, Scene } from "../domain/scene";
import { viewOf } from "../engine/compose";
import { observeReplayPrefix } from "../engine/diff";
import { availableActions, step } from "../engine/interpreter";
import type { State } from "../engine/interpreter";
import type { Availability } from "./canonical-pair";
import { listOf, requirementsOf, runChoices } from "./rehearsal";

export type VersionCell = {
  readonly status: Availability;
  readonly note: string;
};

export type VersionRowKind = "unchanged" | "changed" | "added" | "removed";

export type VersionRow = {
  readonly id: Id;
  readonly label: string;
  readonly kind: VersionRowKind;
  readonly previous: VersionCell;
  readonly current: VersionCell;
};

export type VersionComparison = {
  readonly prefixLabels: readonly string[];
  /** The first choice that does not exist in the previous version, if any. */
  readonly stoppedAt: { readonly id: Id; readonly label: string } | null;
  readonly rows: readonly VersionRow[];
  readonly changedCount: number;
  readonly unchangedCount: number;
};

function labelIn(scenes: readonly Scene[], id: Id): string {
  for (const scene of scenes) {
    const found = viewOf(scene).actionById.get(id);
    if (found !== undefined) return found.action.label;
  }
  return id;
}

function endingTitle(scene: Scene, state: State, id: Id): string | null {
  const result = step(scene, state, id);
  return result.ok && result.ending !== null ? result.ending.title : null;
}

function note(
  scene: Scene,
  state: State,
  id: Id,
  status: Availability,
  other: Availability,
  side: "previous" | "current",
  stopped: boolean,
): string {
  if (stopped) return "Replay stopped before this point";
  if (status === "hidden") return "Not in this version";
  if (status === "locked") return `Locked · needs: ${listOf(requirementsOf(scene, state, id))}`;
  if (other === "hidden" && side === "current") return "Added in this version · open now";
  const title = endingTitle(scene, state, id);
  return title === null ? "Open" : `Open · ends the scene: ${title}`;
}

/** The first choice of `prefix` that the scene refuses, replayed from the start. */
function firstRefused(scene: Scene, prefix: readonly Id[]): Id | null {
  let state = runChoices(scene, []).state;
  for (const id of prefix) {
    const result = step(scene, state, id);
    if (!result.ok) return id;
    state = result.state;
  }
  return null;
}

export function compareVersions(
  previous: Scene,
  current: Scene,
  prefix: readonly Id[],
): VersionComparison {
  const scenes = [current, previous];
  const observed = observeReplayPrefix(previous, current, prefix);
  const refused = observed.prefix_legal_in_before ? null : firstRefused(previous, prefix);
  const stopped = refused !== null || !observed.prefix_legal_in_before;
  const previousRun = runChoices(previous, prefix);
  const currentRun = runChoices(current, prefix);

  // Scene order: this version's list, then anything only the previous offers.
  const order = [
    ...availableActions(current, currentRun.state).map((action) => action.action_id),
    ...(stopped
      ? []
      : availableActions(previous, previousRun.state)
          .map((action) => action.action_id)
          .filter((id) => observed.after[id] === undefined)),
  ];

  const rows = order.map((id): VersionRow => {
    const before = (observed.before[id] ?? "hidden") as Availability;
    const after = (observed.after[id] ?? "hidden") as Availability;
    const kind: VersionRowKind = stopped
      ? "unchanged"
      : before === after
        ? "unchanged"
        : before === "hidden"
          ? "added"
          : after === "hidden"
            ? "removed"
            : "changed";
    return {
      id,
      label: labelIn(scenes, id),
      kind,
      previous: {
        status: before,
        note: note(previous, previousRun.state, id, before, after, "previous", stopped),
      },
      current: {
        status: after,
        note: note(current, currentRun.state, id, after, before, "current", false),
      },
    };
  });

  const changedCount = rows.filter((row) => row.kind !== "unchanged").length;
  return {
    prefixLabels: prefix.map((id) => labelIn(scenes, id)),
    stoppedAt: refused === null ? null : { id: refused, label: labelIn(scenes, refused) },
    rows,
    changedCount,
    unchangedCount: rows.length - changedCount,
  };
}
