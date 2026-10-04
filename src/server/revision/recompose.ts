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
 * On top of that, this module enforces **preservation**, and enforces it as a
 * refusal rather than a report. Section 9 names, per command, exactly which
 * owned objects must be identical afterwards; `assertPreserved` compares their
 * canonical hashes and refuses the whole revision if any of them moved. A
 * revision that would have altered the world, the clean core, the port table,
 * or a module it does not own composes nothing and commits nothing, and the
 * previous active version stays current and playable.
 */

import type { Brief } from "@/domain/brief";
import type { ApprovedInfluence, Slot } from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import type { RevisionDiffView, RevisionFailureCode, RevisionKind } from "@/domain/revision";
import type { EndingCopyOverride, Scene } from "@/domain/scene";
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
import { readStoredBase, readStoredModules } from "../compile/state";
import { verifyCandidate } from "../compile/verify";
import { PINNED_CHAT_MODEL } from "../config";
import type { DataGateway, ProjectRow, SessionRow } from "../db/gateway";
import { revisionDiffView } from "./diff";

export type RecomposeInput = {
  readonly gateway: DataGateway;
  readonly session: SessionRow;
  /** The row read in this request, so the compare-and-swap uses live state. */
  readonly project: ProjectRow;
  readonly brief: Brief;
  /** The approvals that remain active after the command was recorded. */
  readonly approvals: readonly ApprovedInfluence[];
  /** The creator's ending-wording overrides as they now stand. */
  readonly endingCopyOverrides: readonly EndingCopyOverride[];
  /** The `revision` operation row this command reserved. */
  readonly operationId: string;
  readonly changedBy: RevisionKind;
  /**
   * The owned objects this command may not change, beyond the world, the clean
   * core, and the port table, which are never changeable by any of them.
   */
  readonly preserveModules: readonly Slot[];
};

export type RecomposeResult =
  | {
      readonly status: "committed";
      readonly versionId: string;
      readonly diff: RevisionDiffView | null;
      readonly activeSlots: readonly Slot[];
    }
  /** A module the composition needs is missing or belongs to another approval. */
  | { readonly status: "requires_compilation"; readonly slot: Slot }
  | { readonly status: "failed"; readonly code: RevisionFailureCode };

/**
 * Recomposes, validates, and commits one revision. Makes no provider call.
 *
 * There is no compiler, no payload builder, and no model client in scope here,
 * which is the mechanism behind "removal costs zero model and zero Qloo calls":
 * this function could not make one.
 */
export async function recomposeRevision(
  input: RecomposeInput,
): Promise<RecomposeResult> {
  const { gateway, session, project } = input;

  const stored = await gateway.findProjectCompilationState(project.id, session.id);
  if (stored === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  const base = readStoredBase(stored.base_scene);
  if (base === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  const storedModules = readStoredModules(stored.compiled_modules);

  // One module per remaining approval, and it must be the module compiled for
  // *that* approval. A stored artifact bound to a different approval id is not
  // reused under a new one: that slot needs its own compilation.
  const activeModules = [];
  for (const slot of SLOTS) {
    const approval = input.approvals.find((candidate) => candidate.slot === slot);
    if (approval === undefined) continue;
    const entry = storedModules[slot];
    if (entry === undefined) return { status: "requires_compilation", slot };
    if (entry.module.approval_id !== sceneApprovalId(approval.approval_id)) {
      return { status: "requires_compilation", slot };
    }
    activeModules.push(entry.module);
  }

  const activeApprovals = SLOTS.flatMap((slot) => {
    const approval = input.approvals.find((candidate) => candidate.slot === slot);
    return approval === undefined ? [] : [approval];
  });

  const assembled = assembleScene({
    brief: input.brief,
    inputHash: recompositionInputHash({
      baseHash: base.hash,
      moduleHashes: activeModules.map((module) => moduleHash(module)),
      overrides: input.endingCopyOverrides,
    }),
    core: base.core,
    generatedTitle: base.title,
    modules: activeModules,
    approvals: activeApprovals,
    endingCopyOverrides: input.endingCopyOverrides,
  });
  if (!assembled.ok) return { status: "failed", code: "VALIDATION_FAILED" };

  const verdict = verifyCandidate(
    assembled.scene,
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

  // The comparison, and the preservation refusal built on it. Both happen
  // before anything is written.
  const previous = await readActiveScene(gateway, session, project);
  if (previous === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  const diff = revisionDiffView({
    before: previous,
    after: { versionId: null, scene: assembled.scene },
    changedBy: input.changedBy,
  });
  if (diff === null) return { status: "failed", code: "NO_ACTIVE_VERSION" };
  if (!preserved(diff, input.preserveModules)) {
    return { status: "failed", code: "PRESERVATION_VIOLATED" };
  }

  const moduleHashes: Record<string, string> = {};
  for (const module of activeModules) moduleHashes[module.slot] = moduleHash(module);

  const commit = await gateway.commitSceneVersion({
    projectId: project.id,
    ownerSessionId: session.id,
    expectedRevision: project.revision,
    expectedBaseHash: base.hash,
    expectedApprovals: approvalPointers(project),
    operationId: input.operationId,
    parentVersionId: project.active_version_id,
    inputHash: diff.hashes.after_scene.slice(0, 48),
    baseHash: base.hash,
    moduleHashes,
    scene: assembled.scene,
    validationSummary: verdict.summary,
    inputSnapshot: {
      project_id: project.id,
      project_revision: project.revision,
      // A revision records which command produced it and what it preserved,
      // because that is what a later reader needs in order to check the claim.
      revision_kind: input.changedBy,
      base_hash: base.hash,
      preserved_modules: [...input.preserveModules],
      model: PINNED_CHAT_MODEL,
      compiler_identifier: COMPILER_IDENTIFIER,
      prompt_identifier: PROMPT_IDENTIFIER,
      schema_identifier: SCHEMA_IDENTIFIER,
      validator_identifier: VALIDATOR_IDENTIFIER,
      // Zero, measured rather than asserted: nothing in this module can call a
      // provider, and the ending-copy preview that may have preceded it is a
      // separate operation row with its own spend record.
      model_calls: 0,
    },
    approvalSnapshot: activeApprovals.map((approval) => ({
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
      edited_by_creator: approval.edited_by_creator,
      approved_at: approval.approved_at,
    })),
    modelIdentifier: PINNED_CHAT_MODEL,
    promptIdentifier: PROMPT_IDENTIFIER,
    schemaIdentifier: SCHEMA_IDENTIFIER,
    compilerIdentifier: COMPILER_IDENTIFIER,
    validatorIdentifier: VALIDATOR_IDENTIFIER,
    revisionDiff: diff,
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
    diff: { ...diff, after_version_id: commit.version_id },
    activeSlots: activeModules.map((module) => module.slot),
  };
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

async function readActiveScene(
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
