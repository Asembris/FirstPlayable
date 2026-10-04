/**
 * Owner-scoped scene-version repository (specification section 11).
 *
 * A version row is immutable: nothing in this module updates one, and the
 * table's trigger refuses an `UPDATE` anyway. "Pending", "active", and
 * "superseded" are therefore *derived* from the project's own two pointers
 * rather than stored on the row, which is what lets activation change what is
 * current without rewriting a byte of history.
 *
 * Every read goes through the owner-checked `read_scene_versions` RPC, so a
 * repository here physically cannot forget the ownership predicate.
 *
 * Two deliberate projections:
 *
 *   * A **summary** carries identifiers and hashes. It is what a project read
 *     returns, so a studio page does not ship four copies of a 96 KiB scene.
 *   * A **playable** carries the whole validated scene, its validation
 *     summary, and the deterministic "Scene changed" lines. It is returned for
 *     one version only, and it is what lets the browser run the scene through
 *     the Phase 1 engine with no further request of any kind.
 */

import {
  type PlayableView,
  PlayableViewSchema,
  type SceneChangedView,
  type SceneVersionSummary,
  SceneVersionSummarySchema,
  type ValidationSummaryView,
  ValidationSummaryViewSchema,
  type VersionState,
} from "@/domain/compile";
import { SLOTS } from "@/domain/limits";
import { type RevisionDiffView, RevisionDiffViewSchema } from "@/domain/revision";
import type { Slot } from "@/domain/influence";
import { safeParseScene } from "@/domain/scene";
import { appErrors } from "../security/errors";
import type { DataGateway, ProjectRow, SceneVersionRow, SessionRow } from "./gateway";

/** How many versions a project read lists. Bounded, newest first. */
export const VERSION_LIST_LIMIT = 8;

/** How many share links a project read lists. Bounded, newest first. */
export const PUBLICATION_LIST_LIMIT = 8;

/**
 * One version's stored comparison, or null.
 *
 * Null covers three honest cases and no dishonest one: a first version has no
 * parent, a version committed before this phase has no stored diff, and a
 * stored value that no longer satisfies the contract is not partially trusted.
 */
export function revisionDiffOf(row: SceneVersionRow): RevisionDiffView | null {
  if (row.revision_diff === null || row.revision_diff === undefined) return null;
  const parsed = RevisionDiffViewSchema.safeParse(row.revision_diff);
  return parsed.success ? parsed.data : null;
}

function stateOf(row: SceneVersionRow, project: ProjectRow): VersionState {
  if (project.pending_version_id === row.id) return "pending";
  if (project.active_version_id === row.id) return "active";
  return "superseded";
}

function moduleHashesOf(row: SceneVersionRow): Partial<Record<Slot, string>> {
  const hashes: Partial<Record<Slot, string>> = {};
  for (const slot of SLOTS) {
    const value = row.module_hashes[slot];
    if (typeof value === "string" && value.length > 0) hashes[slot] = value;
  }
  return hashes;
}

/**
 * One version's summary.
 *
 * A stored row that no longer satisfies the contract is reported as `null`
 * rather than partially; the honest outcome is "this version is not readable",
 * never "here is most of a version".
 */
export function toVersionSummary(
  row: SceneVersionRow,
  project: ProjectRow,
): SceneVersionSummary | null {
  const moduleHashes = moduleHashesOf(row);
  const candidate = {
    id: row.id,
    parent_version_id: row.parent_version_id,
    state: stateOf(row, project),
    created_at: row.created_at,
    base_hash: row.base_hash,
    module_hashes: moduleHashes,
    active_slots: SLOTS.filter((slot) => moduleHashes[slot] !== undefined),
    model_identifier: row.model_identifier,
    compiler_identifier: row.compiler_identifier,
    validator_identifier: row.validator_identifier,
    revision_label: revisionDiffOf(row)?.label ?? null,
  };
  const parsed = SceneVersionSummarySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The deterministic fourth provenance line, built from the stored version.
 *
 * It exists only where a validated module and a computed mechanical witness
 * both exist: the scene's own provenance binding supplies the mechanic ids, and
 * the stored validation summary supplies the witness. Nothing here is a model
 * describing its own output.
 */
export function sceneChangedFrom(
  scene: { modules: readonly { slot: Slot; approval_id: string }[]; provenance: readonly { approval_id: string; mechanic_ids: readonly string[] }[] },
  validation: ValidationSummaryView,
): SceneChangedView[] {
  const lines: SceneChangedView[] = [];
  for (const module of scene.modules) {
    const witness = validation.witnesses.find((entry) => entry.slot === module.slot);
    if (witness === undefined || !witness.mechanical) continue;
    const binding = scene.provenance.find(
      (entry) => entry.approval_id === module.approval_id,
    );
    lines.push({
      approval_id: module.approval_id,
      slot: module.slot,
      mechanic_ids: binding === undefined ? [] : [...binding.mechanic_ids].slice(0, 16),
      witness,
    });
  }
  return lines;
}

/** One version as a playable, or `null` when the stored row is unreadable. */
export function toPlayableView(
  row: SceneVersionRow,
  project: ProjectRow,
): PlayableView | null {
  const scene = safeParseScene(row.scene);
  if (!scene.ok) return null;
  const validation = ValidationSummaryViewSchema.safeParse(row.validation_summary);
  if (!validation.success) return null;

  const candidate = {
    version_id: row.id,
    state: stateOf(row, project),
    created_at: row.created_at,
    scene: scene.scene,
    validation: validation.data,
    scene_changed: sceneChangedFrom(scene.scene, validation.data),
    diff: revisionDiffOf(row),
  };
  const parsed = PlayableViewSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/* ---------------------------------------------------------------- reads */

export async function listVersionSummaries(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
): Promise<SceneVersionSummary[]> {
  const read = await gateway.readSceneVersions(
    project.id,
    session.id,
    null,
    VERSION_LIST_LIMIT,
  );
  if (read.outcome === "not_found") throw appErrors.notFound();
  return read.versions
    .map((row) => toVersionSummary(row, project))
    .filter((summary): summary is SceneVersionSummary => summary !== null);
}

export async function readVersionRow(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
  versionId: string,
): Promise<SceneVersionRow | null> {
  const read = await gateway.readSceneVersions(project.id, session.id, versionId, 1);
  if (read.outcome === "not_found") throw appErrors.notFound();
  return read.versions[0] ?? null;
}

/**
 * The version the studio should offer to play: the pending review when there
 * is one, otherwise the active version, otherwise nothing.
 *
 * The pending one comes first because that is the whole point of review: the
 * creator is being asked about *that* scene. The active version stays readable
 * the moment the pending one is declined.
 */
export async function readPlayableForProject(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
): Promise<PlayableView | null> {
  const versionId = project.pending_version_id ?? project.active_version_id;
  if (versionId === null) return null;
  const row = await readVersionRow(gateway, session, project, versionId);
  if (row === null) return null;
  return toPlayableView(row, project);
}

/**
 * The version the shown playable revised, for the previous/current comparison.
 *
 * It follows the stored `parent_version_id` rather than "the version before
 * this one by date", because a declined build leaves a row that was never
 * anybody's parent. Null whenever there is no parent or the parent is no longer
 * readable; the comparison then simply is not offered.
 */
export async function readPreviousPlayable(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
  playable: PlayableView | null,
): Promise<PlayableView | null> {
  if (playable === null) return null;
  const current = await readVersionRow(gateway, session, project, playable.version_id);
  const parentId = current?.parent_version_id ?? null;
  if (parentId === null) return null;
  const parent = await readVersionRow(gateway, session, project, parentId);
  if (parent === null) return null;
  return toPlayableView(parent, project);
}
