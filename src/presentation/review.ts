/**
 * The creator's side of the Rehearsal Table: where each approval stands, and
 * what a candidate build actually did.
 *
 * Four distinctions are kept apart on purpose, and nothing here merges them:
 *
 *   Qloo returned a reference
 *   → FirstPlayable proposed an interpretation
 *   → the creator approved (or edited, then approved) one
 *   → a build was observed to change the scene
 *
 * Approving changes no scene. Building produces a candidate. Only the
 * creator's explicit "Make it current" makes a candidate the version people
 * play. Every status below is read from those facts, never inferred.
 */

import type { CompilationState, PlayableView } from "../domain/compile";
import type { ApprovedInfluence } from "../domain/influence";
import type { Id, Scene, Slot } from "../domain/scene";
import { orderedSlots, removeModule } from "../engine/compose";
import type { Availability } from "./canonical-pair";
import {
  blockedTextsOf,
  compareAt,
  consequenceAt,
  firstSentence,
  runChoices,
} from "./rehearsal";
import type { Phrase, ScenePair } from "./rehearsal";

/* ------------------------------------------------------- approval status */

/**
 * The scene-level form of an approval id, as the compiler writes it into a
 * module (`src/server/compile/assemble.ts`, `sceneApprovalId`). Mirrored here
 * so the browser can tell which build carries which approval without asking
 * the server anything new.
 */
export function sceneApprovalIdOf(approvalId: string): string {
  return `approval.${approvalId.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-")}`.slice(0, 64);
}

/** True only when this exact approval was compiled into the scene. */
export function sceneCarries(scene: Scene, approval: ApprovedInfluence): boolean {
  const id = sceneApprovalIdOf(approval.approval_id);
  return scene.modules.some((module) => module.slot === approval.slot && module.approval_id === id);
}

export type BuildStatus = "not-built" | "awaiting-review" | "current";

/**
 * Where one approval stands. An approval no build carries is "not built yet",
 * however long ago it was made; one only the candidate carries is "awaiting
 * review"; only one the current version carries is "current".
 */
export function buildStatusOf(
  approval: ApprovedInfluence,
  versions: { readonly pending: Scene | null; readonly active: Scene | null },
): BuildStatus {
  if (versions.active !== null && sceneCarries(versions.active, approval)) return "current";
  if (versions.pending !== null && sceneCarries(versions.pending, approval)) return "awaiting-review";
  return "not-built";
}

export const BUILD_STATUS_LABEL: Readonly<Record<BuildStatus, string>> = {
  "not-built": "Not built yet",
  "awaiting-review": "Built · awaiting your review",
  current: "In the current version",
};

/* ------------------------------------------------- intended vs observed */

export type ObservedRow = {
  readonly id: Id;
  readonly label: string;
  /** What the build did to this choice: "locked", "open", "added", "removed". */
  readonly reading: string;
};

export type Observation = {
  readonly slot: Slot;
  /** The reference's name, or "this influence" when the build cannot be tied to one. */
  readonly influenceName: string;
  /** What the creator said should change in play, as compiled into this build. */
  readonly intendedEffect: string;
  /** The creator's approved interpretation, as compiled into this build. */
  readonly approvedText: string;
  readonly approvedHead: { readonly head: string; readonly truncated: boolean };
  /** The choices the observation is made after, as stored labels. */
  readonly prefixLabels: readonly string[];
  /** Only the choices this influence changed, in scene order. */
  readonly rows: readonly ObservedRow[];
  /** Every locked changed choice, with each requirement's own stored text. */
  readonly requirements: readonly { readonly label: string; readonly texts: readonly string[] }[];
  /** The observation in player words, or null when nothing changed. */
  readonly phrase: Phrase | null;
};

function reading(kind: string, withStatus: Availability): string {
  if (kind === "added") return "added";
  if (kind === "removed") return "removed";
  return withStatus === "enabled" ? "open" : withStatus === "locked" ? "locked" : "not offered";
}

/**
 * What a build did, per influence: the build replayed against the same build
 * recomposed without that one module, after the stored witness's own prefix.
 * That is how the validator observed the change in the first place.
 */
export function observationsOf(
  playable: PlayableView,
  approvals: readonly ApprovedInfluence[],
): Observation[] {
  const scene = playable.scene;
  return orderedSlots(scene.modules).map((slot) => {
    const module = scene.modules.find((candidate) => candidate.slot === slot)!;
    const influence = scene.influences.find((entry) => entry.approval_id === module.approval_id);
    const approvedText = influence?.approved_text ?? "";
    const named =
      approvals.find((approval) => sceneApprovalIdOf(approval.approval_id) === module.approval_id) ??
      approvals.find((approval) => approval.slot === slot && approval.approved_text === approvedText);
    const influenceName = named?.reference_name ?? "this influence";
    const witness = playable.scene_changed.find((change) => change.slot === slot)?.witness ?? null;
    const prefix = witness?.prefix ?? [];

    const pair: ScenePair = {
      withScene: scene,
      withoutScene: removeModule(scene, slot),
      influenceName,
      recordedPrefix: prefix,
    };
    const comparison = compareAt(pair, prefix);
    const changed = comparison.rows.filter((row) => row.kind !== "unchanged");
    const state = runChoices(scene, prefix).state;
    const focus =
      witness?.action_id !== null && witness?.action_id !== undefined
        ? witness.action_id
        : changed[0]?.id ?? null;

    return {
      slot,
      influenceName,
      intendedEffect: influence?.intended_effect ?? "",
      approvedText,
      approvedHead: firstSentence(approvedText),
      prefixLabels: comparison.prefixLabels,
      rows: changed.map((row) => ({
        id: row.id,
        label: row.label,
        reading: reading(row.kind, row.with.status),
      })),
      requirements: changed
        .filter((row) => row.with.status === "locked")
        .map((row) => ({ label: row.label, texts: blockedTextsOf(scene, state, row.id) })),
      phrase: focus === null ? null : consequenceAt(pair, focus, prefix),
    };
  });
}

/** "All three endings are still reachable", only when the validator says so. */
export function allEndingsReachable(playable: PlayableView): boolean {
  return playable.validation.reachable_endings.length === playable.scene.core.endings.length;
}

/** A compilation state in the creator's words; the stored code stays beside it. */
export const BUILD_STATE_TEXT: Readonly<Record<CompilationState, string>> = {
  AWAITING_APPROVAL: "Waiting for an approved interpretation",
  BASE_READY: "The encounter is written",
  MODULES_READY: "The influences are built",
  VALIDATING: "Checking every choice",
  REVIEW_PLAYABLE: "Ready for your review",
  READY: "Current",
  FAILED: "This build did not finish",
};
