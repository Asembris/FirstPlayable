/**
 * Revision copy for the creator: the engine's stored verdict, in the
 * creator's words.
 *
 * The stored diff is the authority. Its label decides "mechanical" against
 * "wording", and its summary lines are the engine's own observation; nothing
 * here recomputes either. What changes is only how a line reads: an action id
 * becomes the action's stored label, an availability becomes "open",
 * "locked", or "not offered", and the fixed-details line names the room, the
 * people, and the object instead of "world", "core", and "ports". A line this
 * module does not recognise is shown exactly as stored.
 */

import type { RevisionLabel } from "../domain/revision";
import type { Scene } from "../domain/scene";
import { viewOf } from "../engine/compose";

export const REVISION_LABEL_TEXT: Readonly<Record<RevisionLabel, string>> = {
  mechanical: "Mechanical change: what you can do in the scene is different.",
  wording: "Wording changed; interaction unchanged.",
  none: "No change.",
};

/** A stored action id's label in whichever of these scenes declares it. */
export function actionLabelIn(scenes: readonly Scene[], actionId: string): string | null {
  for (const scene of scenes) {
    const found = viewOf(scene).actionById.get(actionId);
    if (found !== undefined) return found.action.label;
  }
  return null;
}

function endingTitleIn(scenes: readonly Scene[], endingId: string): string | null {
  for (const scene of scenes) {
    const found = scene.core.endings.find((ending) => ending.id === endingId);
    if (found !== undefined) return found.title;
  }
  return null;
}

const AVAILABILITY: Readonly<Record<string, string>> = {
  enabled: "open",
  locked: "locked",
  hidden: "not offered",
};

function availability(word: string): string {
  return AVAILABILITY[word] ?? word;
}

function quoted(scenes: readonly Scene[], actionId: string): string {
  const label = actionLabelIn(scenes, actionId);
  return label === null ? `"${actionId}"` : `“${label}”`;
}

function choices(scenes: readonly Scene[], prefix: string): string {
  if (prefix === "no choices") return "before any choice";
  const ids = prefix.replace(/^the choices /, "").split(" -> ");
  return `after ${ids.map((id) => quoted(scenes, id)).join(" → ")}`;
}

const INTERACTION =
  /^Interaction changed: after (the same choices|no choices|the choices .+?), "([^"]+)" is (\w+) before and (\w+) after\.$/;
const ENDINGS = /^Ending wording edited: (.+)\.$/;
const FIXED = /^Fixed details preserved: world (\w+), core (\w+), ports (\w+)\.$/;

/**
 * One stored summary line, read for the creator.
 *
 * `before` and `after` keep the stored diff's direction: the version the
 * command revised, then the version it produced.
 */
export function humanizeSummaryLine(line: string, scenes: readonly Scene[]): string {
  const interaction = INTERACTION.exec(line);
  if (interaction !== null) {
    const [, point, actionId, before, after] = interaction as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    const when = point === "the same choices" ? "after the same choices" : choices(scenes, point);
    return `Interaction changed: ${when}, ${quoted(scenes, actionId)} was ${availability(before)} and is now ${availability(after)}.`;
  }

  const endings = ENDINGS.exec(line);
  if (endings !== null) {
    const titles = (endings[1] ?? "")
      .split(", ")
      .map((id) => {
        const title = endingTitleIn(scenes, id);
        return title === null ? id : `“${title}”`;
      });
    return `Ending wording edited: ${titles.join(", ")}.`;
  }

  const fixed = FIXED.exec(line);
  if (fixed !== null) {
    const [, world, core, ports] = fixed as unknown as [string, string, string, string];
    const state = (word: string) => (word === "unchanged" ? "unchanged" : "CHANGED");
    return `Fixed details preserved: the room, the people, and the object ${state(world)}; the scene's own choices and endings ${state(core)}; where influences attach ${state(ports)}.`;
  }

  return line;
}

export function humanizeSummary(lines: readonly string[], scenes: readonly Scene[]): string[] {
  return lines.map((line) => humanizeSummaryLine(line, scenes));
}
