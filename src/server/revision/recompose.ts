/**
 * Deterministic recomposition: the half of revision that costs nothing
 * (specification section 9).
 *
 * Two of the five revision commands never reach a provider, and this module is
 * why:
 *
 *   * **`remove`** drops one module and its bindings and recomposes from the
 *     immutable clean base and the modules that remain. Nothing is generated,
 *     because nothing new is needed: every surviving artifact is already
 *     stored, byte for byte, under the input hash that authorised it.
 *   * **`ending_copy_apply`** adds one text-only override to the composition.
 *     The composer replaces one ending's `text` and touches nothing else.
 *
 * Both then go through the *same* path a fresh compilation takes: assemble with
 * the server owning every authority, validate the full candidate and every
 * supported removal subset with the unchanged Phase 1 engine, and commit under
 * the SQL compare-and-swap. A revision is not a privileged write.
 *
 * The split into **prepare** and **commit** is deliberate, and it is what keeps
 * a refused revision from leaving a half-applied project behind. Preparing
 * composes, validates, compares, and checks preservation while nothing has been
 * written; only a prepared revision advances the approval pointer or the
 * override list, and only then is the version committed. A revision that cannot
 * validate therefore changes no project column at all.
 *
 * Preservation is enforced here as a **refusal**, not a report. Section 9 names,
 * per command, exactly which owned objects must be identical afterwards;
 * `preserved` compares their canonical hashes and the prepare step fails if any
 * of them moved. A revision that would have altered the world, the clean core,
 * the port table, or a module it does not own composes nothing and commits
 * nothing, and the previous active version stays current and playable.
 */

import type { Brief } from "@/domain/brief";
import type { ApprovedInfluence, Slot } from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import type { RevisionDiffView, RevisionFailureCode, RevisionKind } from "@/domain/revision";
import type { EndingCopyOverride, InfluenceModule, Scene } from "@/domain/scene";
import { safeParseScene } from "@/domain/scene";
import { sha256Hex } from "@/engine/hash";
import {
  assembleScene,
  moduleHash,
  sceneApprovalAllowlist,
  sceneApprovalId,
} from "../compile/assemble";
import { approvalPointers } from "../compile/controller";
import {
  COMPILER_IDENTIFIER,
  PROMPT_IDENTIFIER,
  SCHEMA_IDENTIFIER,
  VALIDATOR_IDENTIFIER,
} from "../compile/identifiers";
import { readStoredBase, readStoredModules, type StoredBase } from "../compile/state";
import { verifyCandidate } from "../compile/verify";
import type { CandidateVerdict } from "../compile/verify";
import { PINNED_CHAT_MODEL } from "../config";
import type { DataGateway, ProjectRow, SessionRow } from "../db/gateway";
import { revisionDiffView } from "./diff";

export type PrepareInput = {
  readonly gateway: DataGateway;
  readonly session: SessionRow;
  /** The row read in this request. */
  readonly project: ProjectRow;
  readonly brief: Brief;
  /** The approvals that will remain active once the command is recorded. */
  readonly approvals: readonly ApprovedInfluence[];
  /** The ending-wording overrides the revised version will carry. */
  readonly endingCopyOverrides: readonly EndingCopyOverride[];
  readonly changedBy: RevisionKind;
  /**
   * The owned modules this command may not change. The world, the clean core,
   * and the port table are never changeable by any command, so they are not
   * listed: they are checked unconditionally.
   */
  readonly preserveModules: readonly Slot[];
};

export type PreparedRevision = {
  readonly scene: Scene;
  readonly verdict: CandidateVerdict;
  readonly diff: RevisionDiffView;
  readonly base: StoredBase;
  readonly modules: readonly InfluenceModule[];
  readonly approvals: readonly ApprovedInfluence[];
  readonly changedBy: RevisionKind;
  readonly preserveModules: readonly Slot[];
  readonly parentVersionId: string;
};

export type PrepareResult =
  | { readonly status: "ready"; readonly prepared: PreparedRevision }
  /** A module the composition needs is missing or belongs to another approval. */
  | { readonly status: "requires_compilation"; readonly slot: Slot }
  | { readonly status: "failed"; readonly code: RevisionFailureCode };

/**
 * Composes, validates, compares, and checks preservation. Writes nothing.
 *
 * There is no compiler, no payload builder, and no model client in scope here,
 * which is the mechanism behind "removal costs zero model and zero Qloo calls":
 * this function could not make one.
 */
export async function prepareRevision(input: PrepareInput): Promise<PrepareResult> {
  const { gateway, session, project } = input;

  const stored = await gateway.findProjectCompilationState(project.id, session.id);
  if (stored === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  const base = readStoredBase(stored.base_scene);
  if (base === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  const storedModules = readStoredModules(stored.compiled_modules);

  // One module per remaining approval, and it must be the module compiled for
  // *that* approval. A stored artifact bound to a different approval id is not
  // reused under a new one: that slot needs its own compilation.
  const activeModules: InfluenceModule[] = [];
  const activeApprovals: ApprovedInfluence[] = [];
  for (const slot of SLOTS) {
    const approval = input.approvals.find((candidate) => candidate.slot === slot);
    if (approval === undefined) continue;
    const entry = storedModules[slot];
    if (entry === undefined) return { status: "requires_compilation", slot };
    if (entry.module.approval_id !== sceneApprovalId(approval.approval_id)) {
      return { status: "requires_compilation", slot };
    }
    activeModules.push(entry.module);
    activeApprovals.push(approval);
  }

  const assembled = composeRevision({
    brief: input.brief,
    base,
    modules: activeModules,
    approvals: activeApprovals,
    endingCopyOverrides: input.endingCopyOverrides,
  });
  if (assembled === null) return { status: "failed", code: "VALIDATION_FAILED" };

  const verdict = verifyCandidate(
    assembled,
    input.brief,
    sceneApprovalAllowlist(activeApprovals),
  );
  if (!verdict.ok) {
    return {
      status: "failed",
      code: verdict.resourceLimited
        ? "VALIDATION_RESOURCE_LIMIT"
        : verdict.subsetConflict
          ? "SUBSET_CONFLICT"
          : "VALIDATION_FAILED",
    };
  }

  const previous = await readActiveScene(gateway, session, project);
  if (previous === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  const diff = revisionDiffView({
    before: previous,
    after: { versionId: null, scene: assembled },
    changedBy: input.changedBy,
  });
  if (diff === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  if (!preserved(diff, input.preserveModules)) {
    return { status: "failed", code: "PRESERVATION_VIOLATED" };
  }

  return {
    status: "ready",
    prepared: {
      scene: assembled,
      verdict,
      diff,
      base,
      modules: activeModules,
      approvals: activeApprovals,
      changedBy: input.changedBy,
      preserveModules: input.preserveModules,
      parentVersionId: previous.versionId,
    },
  };
}

export type CommitResult =
  | {
      readonly status: "committed";
      readonly versionId: string;
      readonly diff: RevisionDiffView;
      readonly activeSlots: readonly Slot[];
    }
  | { readonly status: "failed"; readonly code: RevisionFailureCode };

/**
 * Commits a prepared revision as one immutable, reviewable version.
 *
 * `project` must be the row read *after* the command's own pointer or override
 * write, so the compare-and-swap triple in SQL compares against live state. A
 * concurrent change refuses the insert and nothing becomes current.
 */
export async function commitRevision(input: {
  readonly gateway: DataGateway;
  readonly session: SessionRow;
  readonly project: ProjectRow;
  readonly prepared: PreparedRevision;
  /** The `revision` operation row this command reserved. */
  readonly operationId: string;
}): Promise<CommitResult> {
  const { gateway, session, project, prepared } = input;

  const moduleHashes: Record<string, string> = {};
  for (const module of prepared.modules) moduleHashes[module.slot] = moduleHash(module);

  const commit = await gateway.commitSceneVersion({
    projectId: project.id,
    ownerSessionId: session.id,
    expectedRevision: project.revision,
    expectedBaseHash: prepared.base.hash,
    expectedApprovals: approvalPointers(project),
    operationId: input.operationId,
    parentVersionId: prepared.parentVersionId,
    inputHash: prepared.diff.hashes.after_scene.slice(0, 48),
    baseHash: prepared.base.hash,
    moduleHashes,
    scene: prepared.scene,
    validationSummary: prepared.verdict.summary,
    inputSnapshot: {
      project_id: project.id,
      project_revision: project.revision,
      // A revision records which command produced it and what it preserved,
      // because that is what a later reader needs in order to check the claim.
      revision_kind: prepared.changedBy,
      base_hash: prepared.base.hash,
      preserved_modules: [...prepared.preserveModules],
      model: PINNED_CHAT_MODEL,
      compiler_identifier: COMPILER_IDENTIFIER,
      prompt_identifier: PROMPT_IDENTIFIER,
      schema_identifier: SCHEMA_IDENTIFIER,
      validator_identifier: VALIDATOR_IDENTIFIER,
      // Zero, and structurally so: nothing on this path can call a provider.
      // An ending-copy preview that preceded an apply is a separate operation
      // row with its own recorded spend.
      model_calls: 0,
    },
    approvalSnapshot: prepared.approvals.map((approval) => ({
      slot: approval.slot,
      approval_id: approval.approval_id,
      scene_approval_id: sceneApprovalId(approval.approval_id),
      reference_id: approval.reference_id,
      reference_name: approval.reference_name,
      domain: approval.domain,
      source_kind: approval.source_kind,
      selected_evidence_ids: approval.selected_evidence_ids,
      approved_text: approval.approved_text,
      intended_effect: approval.intended_effect,
      // What the model actually proposed, kept beside the approved wording so
      // a historical or published view can show the two layers separately and
      // label a creator edit honestly without reading today's decisions.
      proposed_idea: approval.proposed_idea,
      edited_by_creator: approval.edited_by_creator,
      approved_at: approval.approved_at,
    })),
    modelIdentifier: PINNED_CHAT_MODEL,
    promptIdentifier: PROMPT_IDENTIFIER,
    schemaIdentifier: SCHEMA_IDENTIFIER,
    compilerIdentifier: COMPILER_IDENTIFIER,
    validatorIdentifier: VALIDATOR_IDENTIFIER,
    revisionDiff: prepared.diff,
  });

  if (commit.outcome !== "committed") {
    return {
      status: "failed",
      code: commit.outcome === "stale_input" ? "STALE_INPUT" : "VALIDATION_FAILED",
    };
  }

  return {
    status: "committed",
    versionId: commit.version_id,
    diff: { ...prepared.diff, after_version_id: commit.version_id },
    activeSlots: prepared.modules.map((module) => module.slot),
  };
}

/**
 * The one composition used by every revision path, and by the ending-copy
 * preview's own validation.
 *
 * Sharing it is what makes "the wording you previewed is the wording that was
 * validated" true: the preview checks the scene this function builds, and the
 * apply commits the scene this function builds.
 */
export function composeRevision(input: {
  readonly brief: Brief;
  readonly base: StoredBase;
  readonly modules: readonly InfluenceModule[];
  readonly approvals: readonly ApprovedInfluence[];
  readonly endingCopyOverrides: readonly EndingCopyOverride[];
}): Scene | null {
  const assembled = assembleScene({
    brief: input.brief,
    inputHash: recompositionInputHash({
      baseHash: input.base.hash,
      moduleHashes: input.modules.map((module) => moduleHash(module)),
      overrides: input.endingCopyOverrides,
    }),
    core: input.base.core,
    generatedTitle: input.base.title,
    modules: input.modules,
    approvals: input.approvals,
    endingCopyOverrides: input.endingCopyOverrides,
  });
  return assembled.ok ? assembled.scene : null;
}

/**
 * The preservation rule of section 9, as a boolean over canonical hashes.
 *
 * The world, the clean core, and the port table are not changeable by any
 * revision command, so they are checked unconditionally. `preserveModules`
 * names the slots this particular command must leave alone — the surviving slot
 * on a removal, every active slot on a wording change.
 */
export function preserved(
  diff: RevisionDiffView,
  preserveModules: readonly Slot[],
): boolean {
  if (!diff.unchanged.world || !diff.unchanged.core || !diff.unchanged.ports) return false;
  return preserveModules.every((slot) => diff.unchanged.modules[slot] === true);
}

/**
 * The composition's identity.
 *
 * Derived from the clean base, the modules that remain, and the overrides, so
 * recomposing the same material twice produces the same scene id and two
 * concurrent attempts agree. No creator text and no timestamp enters it.
 */
export function recompositionInputHash(input: {
  baseHash: string;
  moduleHashes: readonly string[];
  overrides: readonly EndingCopyOverride[];
}): string {
  return sha256Hex(
    [
      "recompose",
      input.baseHash,
      ...input.moduleHashes,
      ...input.overrides.map((override) => `${override.ending_id}:${override.creator_edit_id}`),
      COMPILER_IDENTIFIER,
    ].join("|"),
  ).slice(0, 48);
}

/** The project's active version as a scene, or null when none is readable. */
export async function readActiveScene(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
): Promise<{ versionId: string; scene: Scene } | null> {
  const versionId = project.active_version_id;
  if (versionId === null) return null;
  const read = await gateway.readSceneVersions(project.id, session.id, versionId, 1);
  if (read.outcome !== "read") return null;
  const row = read.versions[0];
  if (row === undefined) return null;
  const parsed = safeParseScene(row.scene);
  return parsed.ok ? { versionId: row.id, scene: parsed.scene } : null;
}
