/**
 * `POST /api/projects/:id/revisions` (specification sections 9 and 11).
 *
 * One route, five typed commands, and no arbitrary patch. What this handler
 * cannot be asked to do is as much the point as what it does: the request
 * contract has no field for a scene, a core action, a world entity, a
 * condition, an effect, a gate, a port, a module, a hash, a version to
 * overwrite, or a validation verdict, so "a revision changes one influence
 * module or one ending's wording" is a property of the contract rather than of
 * this file's care.
 *
 * The ordering is the same for every command that produces a version, and it is
 * what keeps a refusal clean:
 *
 *   1. reserve one `revision` operation row, so a double-clicked button cannot
 *      compose two versions;
 *   2. **prepare** — compose, validate every supported subset, compare against
 *      the active version, and check preservation — while nothing is written;
 *   3. only then move the approval pointer or the override list;
 *   4. commit the version under the SQL compare-and-swap, as *pending*.
 *
 * A revision therefore never becomes current by itself: the creator confirms it
 * through the same `POST /api/projects/:id/activate` that a fresh compilation
 * goes through, and until they do, the previous active version is the one that
 * plays.
 *
 * Provider calls: `remove`, `edit`, `replace`, and `ending_copy_apply` make
 * **zero**. Only `ending_copy_preview` makes one, inside its own operation row
 * with the same two-attempt ceiling and under the same cumulative spend cap as
 * every other call in the application.
 */

import {
  type DecisionKind,
  type DecisionSnapshot,
  DecisionSnapshotSchema,
  type ProposedInterpretation,
  ProposedInterpretationSchema,
  type Slot,
} from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import {
  type EndingCopyPreview,
  EndingCopyPreviewSchema,
  REVISION_FAILURE_MESSAGES,
  type RevisionFailureCode,
  type RevisionRequest,
  RevisionRequestSchema,
  type RevisionResponse,
} from "@/domain/revision";
import type { InfluenceModule } from "@/domain/scene";
import { containsLiteralPhrase, isPlainText } from "@/domain/text";
import { z } from "zod";
import { ModelError, estimateUsdCostMicros, type ModelUsage } from "../model/openai";
import { openAiCompiler, type SceneCompiler } from "../compile/compiler";
import { readStoredBase, readStoredModules } from "../compile/state";
import { sceneApprovalAllowlist } from "../compile/assemble";
import { readRepairContext } from "../compile/controller";
import {
  budgetExhaustedMessage,
  modelCallRecord,
  recordModelCall,
  reconcileModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../db/budgets";
import type { DataGateway, ProjectRow, SessionRow } from "../db/gateway";
import {
  OPERATION_MAX_ATTEMPTS,
  reserveStage,
  settleStage,
} from "../db/operations";
import { readProjectViewForOwner } from "../db/projects";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { activeApprovalIds, listDecisions, proposalDraftOf, resolveApprovals } from "../influence/approvals";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import { sha256Hex } from "@/engine/hash";
import { runEndingCopyStage } from "../revision/copy";
import {
  commitRevision,
  composeRevision,
  prepareRevision,
  type PreparedRevision,
} from "../revision/recompose";
import {
  creatorEditId,
  previewHash,
  readEndingCopyOverrides,
  withOverride,
} from "../revision/overrides";
import type { Phase4Deps } from "./deps";
import { parseProjectId, requireProject, validateBody } from "./shared";

/** The stages that consume the daily revision allowance of section 12. */
const REVISION_STAGES = ["revision", "ending_copy"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The stored shape of a committed preview, on its own operation row. */
const StoredPreviewSchema = z.object({
  preview: z.object({
    ending_id: z.string().min(1).max(64),
    text: z.string().min(1),
    preview_hash: z.string().min(16).max(64),
    model: z.string().min(1).max(80),
  }),
});

function compilerFor(deps: Phase4Deps): SceneCompiler {
  if (deps.compiler !== undefined) return deps.compiler;
  return openAiCompiler(deps.modelClient === undefined ? {} : { client: deps.modelClient });
}

/**
 * A refused revision is a finished state with a real next step.
 *
 * The reason reaches the creator, because "that slot is empty", "this wording
 * was not previewed", and "this would not have preserved what it does not own"
 * are different things to do next. The code and the sentence are both this
 * application's own; neither is a provider message or a database error.
 */
function refuse(code: RevisionFailureCode, lastGood: string | null): never {
  throw appErrors.refused(
    `${code}: ${REVISION_FAILURE_MESSAGES[code]}${lastGood === null ? "" : ` Your active version ${lastGood} is unchanged and still plays.`}`,
  );
}

export async function handleRevision(
  request: Request,
  deps: Phase4Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  // Reported in the error envelope of section 11, so a refusal always names the
  // version that is still current.
  let lastGoodVersionId: string | null = null;
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input: RevisionRequest = validateBody(RevisionRequestSchema, raw);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    let row = await requireProject(gateway, session, id);
    if (row.revision !== input.expected_revision) {
      throw appErrors.rateLimited(
        `Your choices changed while this request was in flight. Reload: the project is now at revision ${row.revision}.`,
      );
    }

    // Every revision revises something. A project with no activated version has
    // nothing to revise, and saying so is better than composing a "revision" of
    // a scene the creator never confirmed.
    if (row.active_version_id === null) refuse("NO_ACTIVE_VERSION", null);
    lastGoodVersionId = row.active_version_id;

    await assertRevisionAllowance(gateway, session, deps, now);

    const brief = (await readProjectViewForOwner(gateway, session, row)).brief;
    const approvals = await resolveApprovals(gateway, session, row);
    const overrides = readEndingCopyOverrides(row.ending_copy_overrides);
    const occupied = new Map(
      activeApprovalIds(row).map((pointer) => [pointer.slot, pointer.decisionId]),
    );

    /* ------------------------------------------------- ending-copy preview */

    if (input.kind === "ending_copy_preview") {
      const preview = await previewEndingCopy({
        gateway,
        session,
        deps,
        project: row,
        brief,
        approvals,
        overrides,
        endingId: input.ending_id,
        creatorRequest: input.request,
        now,
      });
      const project = await readProjectViewForOwner(
        gateway,
        session,
        await requireProject(gateway, session, id),
      );
      const response: RevisionResponse = {
        outcome: "preview",
        kind: input.kind,
        project,
        decision_id: null,
        pending_version_id: null,
        last_good_version_id: row.active_version_id,
        diff: null,
        preview: preview.preview,
        model_calls: preview.modelCalls,
      };
      return json(response, requestId);
    }

    /* ----------------------------------------------- edit and replace */

    if (input.kind === "edit" || input.kind === "replace") {
      const current = occupied.get(input.slot);
      if (current === undefined) refuse("SLOT_EMPTY", row.active_version_id);

      const proposal =
        input.kind === "edit"
          ? await frozenProposalOf(gateway, session, row, current)
          : proposalFromDraft(row, input.proposal_id);
      if (proposal === null) {
        throw appErrors.validationFailed(
          input.kind === "edit"
            ? "this slot's frozen proposal could not be read back, so it cannot be re-approved"
            : "that proposal is not in this project's current proposal set",
        );
      }

      const approvedText = (input.approved_text ?? proposal.idea).trim();
      const intendedEffect = (input.intended_effect ?? proposal.intended_interaction).trim();
      assertCreatorText("approved_text", approvedText, brief.forbidden_wording);
      assertCreatorText("intended_effect", intendedEffect, brief.forbidden_wording);

      const evidenceIds = narrowed(input.selected_evidence_ids, proposal);
      const snapshot = decisionSnapshot({
        kind: "replace",
        proposal,
        approvedText,
        intendedEffect,
        editedByCreator:
          approvedText !== proposal.idea.trim() ||
          intendedEffect !== proposal.intended_interaction.trim(),
        revision: row.revision,
        now,
      });

      // Always `replace`: the slot is occupied, so this is the explicit
      // displacement of one immutable approval by another, with the one it
      // displaced recorded as its predecessor. History is never rewritten.
      const appended = await gateway.appendInfluenceDecision({
        projectId: id,
        ownerSessionId: session.id,
        expectedRevision: row.revision,
        decisionKind: "replace",
        slot: input.slot,
        proposalSnapshot: snapshot,
        selectedEvidenceIds: evidenceIds,
        creatorText: approvedText,
        predecessorId: current,
      });
      if (appended.outcome === "not_found") throw appErrors.notFound();
      if (appended.outcome === "revision_conflict") {
        throw appErrors.rateLimited(
          `Your choices changed while this request was in flight. Reload: the project is now at revision ${appended.current_revision}.`,
        );
      }

      // The slot's stored module belongs to the approval that was just
      // displaced, so it is dropped: the next compilation recompiles this slot
      // and reuses the clean base and the other slot's module by input hash.
      await dropStoredModule(gateway, session, id, input.slot);

      row = await requireProject(gateway, session, id);
      const project = await readProjectViewForOwner(gateway, session, row);
      const response: RevisionResponse = {
        outcome: "requires_compilation",
        kind: input.kind,
        project,
        decision_id: appended.decision_id,
        pending_version_id: null,
        last_good_version_id: row.active_version_id,
        diff: null,
        preview: null,
        model_calls: 0,
      };
      return json(response, requestId);
    }

    /* ------------------------------------- remove and ending-copy apply */

    // The text is part of an apply's identity: a refused apply of different
    // wording under the same preview hash is a different command, and must not
    // settle the key the genuine apply of the previewed wording needs.
    const commandHash = sha256Hex(
      input.kind === "remove"
        ? `remove|${input.slot}|${row.revision}`
        : `apply|${input.ending_id}|${input.preview_hash}|${sha256Hex(input.text)}|${row.revision}`,
    ).slice(0, 48);

    const reservation = await reserveStage(
      gateway,
      session,
      {
        projectId: id,
        stage: "revision",
        inputRevision: row.revision,
        inputHash: commandHash,
      },
      { maxAttempts: OPERATION_MAX_ATTEMPTS },
    );
    if (reservation.outcome === "not_found") throw appErrors.notFound();
    if (reservation.outcome === "attempts_exhausted") {
      refuse("ATTEMPTS_EXHAUSTED", row.active_version_id);
    }
    if (reservation.outcome !== "reserved") {
      // Already running, or already done for exactly this command. Either way,
      // this request must not compose a second version.
      throw appErrors.rateLimited(
        "This change is already being applied. Reload to see the result.",
      );
    }
    const operationId = reservation.operation.id;

    let prepared: PreparedRevision;
    let decisionId: string | null = null;

    if (input.kind === "remove") {
      if (!occupied.has(input.slot)) {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "SLOT_EMPTY" },
        });
        refuse("SLOT_EMPTY", row.active_version_id);
      }
      const surviving = approvals.filter((approval) => approval.slot !== input.slot);
      prepared = await prepareOrFail(
        gateway,
        session,
        operationId,
        row,
        {
          gateway,
          session,
          project: row,
          brief,
          approvals: surviving,
          endingCopyOverrides: overrides,
          changedBy: "remove",
          // Every slot that survives must come through byte-identical.
          preserveModules: surviving.map((approval) => approval.slot),
        },
      );

      const current = occupied.get(input.slot) as string;
      const appended = await gateway.appendInfluenceDecision({
        projectId: id,
        ownerSessionId: session.id,
        expectedRevision: row.revision,
        decisionKind: "remove",
        slot: input.slot,
        proposalSnapshot: removalSnapshot(input.slot, row.revision, now),
        selectedEvidenceIds: [],
        creatorText: null,
        predecessorId: current,
      });
      if (appended.outcome !== "appended") {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "STALE_INPUT" },
        });
        refuse("STALE_INPUT", row.active_version_id);
      }
      decisionId = appended.decision_id;
      await dropStoredModule(gateway, session, id, input.slot);
    } else {
      const stored = await readComposition(gateway, session, row);
      if (stored === null) {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "NO_ACTIVE_VERSION" },
        });
        refuse("NO_ACTIVE_VERSION", row.active_version_id);
      }
      const ending = stored.base.core.endings.find(
        (candidate) => candidate.id === input.ending_id,
      );
      if (ending === undefined) {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "ENDING_UNKNOWN" },
        });
        refuse("ENDING_UNKNOWN", row.active_version_id);
      }
      if (previewHash(input.ending_id, input.text) !== input.preview_hash) {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "PREVIEW_MISMATCH" },
        });
        refuse("PREVIEW_MISMATCH", row.active_version_id);
      }
      // The wording must be wording this application generated and showed. An
      // override is a generated, previewed text-only change (section 9), not a
      // field through which arbitrary prose enters a validated scene.
      const shown = await lastShownPreview(gateway, session, row);
      if (
        shown === null ||
        shown.ending_id !== input.ending_id ||
        shown.text !== input.text
      ) {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "PREVIEW_MISMATCH" },
        });
        refuse("PREVIEW_MISMATCH", row.active_version_id);
      }

      const nextOverrides = withOverride(overrides, {
        ending_id: input.ending_id,
        text: input.text,
        creator_edit_id: creatorEditId(input.ending_id, input.text),
      });
      prepared = await prepareOrFail(gateway, session, operationId, row, {
        gateway,
        session,
        project: row,
        brief,
        approvals,
        endingCopyOverrides: nextOverrides,
        changedBy: "ending_copy_apply",
        // A wording change owns nothing mechanical, so every active module must
        // come through byte-identical.
        preserveModules: approvals.map((approval) => approval.slot),
      });

      const update = await gateway.setProjectEndingCopyOverrides({
        projectId: id,
        ownerSessionId: session.id,
        expectedRevision: row.revision,
        overrides: nextOverrides,
      });
      if (update.outcome !== "updated") {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "STALE_INPUT" },
        });
        refuse("STALE_INPUT", row.active_version_id);
      }
    }

    row = await requireProject(gateway, session, id);
    const committed = await commitRevision({
      gateway,
      session,
      project: row,
      prepared,
      operationId,
    });
    if (committed.status === "failed") {
      await settleStage(gateway, session, operationId, {
        status: "failed",
        error: { code: committed.code },
      });
      refuse(committed.code, row.active_version_id);
    }

    await settleStage(gateway, session, operationId, {
      status: "succeeded",
      result: { version_id: committed.versionId, label: committed.diff.label },
    });

    row = await requireProject(gateway, session, id);
    const project = await readProjectViewForOwner(gateway, session, row);
    const response: RevisionResponse = {
      outcome: "version_pending",
      kind: input.kind,
      project,
      decision_id: decisionId,
      pending_version_id: committed.versionId,
      last_good_version_id: row.active_version_id,
      diff: committed.diff,
      preview: null,
      model_calls: 0,
    };
    return json(response, requestId);
  } catch (error) {
    return errorResponse(error, requestId, lastGoodVersionId);
  }
}

/* ------------------------------------------------------------- the prepare */

async function prepareOrFail(
  gateway: DataGateway,
  session: SessionRow,
  operationId: string,
  project: ProjectRow,
  input: Parameters<typeof prepareRevision>[0],
): Promise<PreparedRevision> {
  const result = await prepareRevision(input);
  if (result.status === "ready") return result.prepared;
  if (result.status === "requires_compilation") {
    await settleStage(gateway, session, operationId, {
      status: "failed",
      error: { code: "REQUIRES_COMPILATION", slot: result.slot },
    });
    throw appErrors.validationFailed(
      `the ${result.slot} slot has no compiled module for its current approval, so build the scene again before revising it`,
    );
  }
  await settleStage(gateway, session, operationId, {
    status: "failed",
    error: { code: result.code },
  });
  refuse(result.code, project.active_version_id);
}

/* ------------------------------------------------------- ending-copy preview */

async function previewEndingCopy(input: {
  gateway: DataGateway;
  session: SessionRow;
  deps: Phase4Deps;
  project: ProjectRow;
  brief: Awaited<ReturnType<typeof readProjectViewForOwner>>["brief"];
  approvals: Awaited<ReturnType<typeof resolveApprovals>>;
  overrides: ReturnType<typeof readEndingCopyOverrides>;
  endingId: string;
  creatorRequest: string;
  now: Date;
}): Promise<{ preview: EndingCopyPreview; modelCalls: number }> {
  const { gateway, session, project } = input;
  const stored = await readComposition(gateway, session, project);
  if (stored === null) refuse("NO_ACTIVE_VERSION", project.active_version_id);

  const ending = stored.base.core.endings.find(
    (candidate) => candidate.id === input.endingId,
  );
  if (ending === undefined) refuse("ENDING_UNKNOWN", project.active_version_id);

  const currentText =
    input.overrides.find((override) => override.ending_id === input.endingId)?.text ??
    ending.text;

  const stageHash = sha256Hex(
    ["ending_copy", input.endingId, currentText, input.creatorRequest.trim()].join("|"),
  ).slice(0, 48);

  const reservation = await reserveStage(
    gateway,
    session,
    {
      projectId: project.id,
      stage: "ending_copy",
      inputRevision: project.revision,
      inputHash: stageHash,
    },
    { maxAttempts: OPERATION_MAX_ATTEMPTS },
  );
  switch (reservation.outcome) {
    case "not_found":
      throw appErrors.notFound();
    case "lease_held":
      throw appErrors.rateLimited("This wording step is already running.");
    case "attempts_exhausted":
      refuse("ATTEMPTS_EXHAUSTED", project.active_version_id);
      break;
    case "settled": {
      // The same ending, the same current wording, and the same request: the
      // committed preview replays, and no second provider call is made.
      const replayed = StoredPreviewSchema.safeParse(reservation.operation.result);
      if (!replayed.success) refuse("MODEL_STAGE_FAILED", project.active_version_id);
      return {
        preview: EndingCopyPreviewSchema.parse({
          ending_id: input.endingId,
          current_text: currentText,
          proposed_text: replayed.data.preview.text,
          preview_hash: replayed.data.preview.preview_hash,
          wording_only: true,
          model: replayed.data.preview.model,
        }),
        modelCalls: 0,
      };
    }
    case "reserved":
      break;
  }

  const operationId = reservation.operation.id;
  const attempt = reservation.operation.attempts;
  const repair = attempt > 1 ? readRepairContext(reservation.operation.result) : null;

  const budget = await reserveModelCall(gateway, input.deps.budget(), { now: input.now });
  if (!budget.granted) {
    await gateway.parkOperation(operationId, session.id, null);
    throw appErrors.budgetExhausted(budgetExhaustedMessage(budget.call_limit));
  }

  const startedAt = Date.now();
  let reconciled = false;
  const settleSpend = async (outcome: {
    model: string | null;
    usage: ModelUsage | null;
  }): Promise<void> => {
    if (reconciled) return;
    reconciled = true;
    const costMicros = estimateUsdCostMicros(outcome.usage);
    recordModelCall(
      modelCallRecord({
        stage: "ending_copy",
        attempt,
        model: outcome.model,
        usage: outcome.usage,
        costMicros,
        latencyMs: Date.now() - startedAt,
      }),
    );
    await reconcileModelCall(gateway, budget.lease_id, {
      costMicros,
      tokens: outcome.usage?.total_tokens ?? 0,
    });
  };

  try {
    const outcome = await runEndingCopyStage(
      {
        brief: input.brief,
        ending: {
          id: ending.id,
          title: ending.title,
          baseText: ending.text,
          currentText,
        },
        request: input.creatorRequest.trim(),
        candidateFor: (text) =>
          composeRevision({
            brief: input.brief,
            base: stored.base,
            modules: stored.modules,
            approvals: input.approvals,
            endingCopyOverrides: withOverride(input.overrides, {
              ending_id: input.endingId,
              text,
              creator_edit_id: creatorEditId(input.endingId, text),
            }),
          }),
        approvedApprovalIds: sceneApprovalAllowlist(input.approvals),
        repair,
      },
      compilerFor(input.deps),
    );
    await settleSpend(outcome);

    if (outcome.kind === "rejected") {
      if (attempt >= OPERATION_MAX_ATTEMPTS) {
        await settleStage(gateway, session, operationId, {
          status: "failed",
          error: { code: "ATTEMPTS_EXHAUSTED" },
        });
        refuse("ATTEMPTS_EXHAUSTED", project.active_version_id);
      }
      // Parked, so the one permitted repair stays inside the same ceiling.
      await gateway.parkOperation(operationId, session.id, {
        rejected: outcome.candidate,
        errors: outcome.errors.slice(0, 10),
      });
      refuse(
        outcome.resourceLimited ? "VALIDATION_RESOURCE_LIMIT" : "VALIDATION_FAILED",
        project.active_version_id,
      );
    }

    const hash = previewHash(input.endingId, outcome.text);
    await settleStage(gateway, session, operationId, {
      status: "succeeded",
      result: {
        preview: {
          ending_id: input.endingId,
          text: outcome.text,
          preview_hash: hash,
          model: outcome.model,
        },
      },
    });

    return {
      preview: EndingCopyPreviewSchema.parse({
        ending_id: input.endingId,
        current_text: currentText,
        proposed_text: outcome.text,
        preview_hash: hash,
        wording_only: true,
        model: outcome.model,
      }),
      modelCalls: 1,
    };
  } catch (cause) {
    await settleSpend({ model: null, usage: null }).catch(() => undefined);
    if (!(cause instanceof ModelError)) {
      await gateway.parkOperation(operationId, session.id, null);
      throw cause;
    }
    if (!cause.attemptSpent) {
      await releaseModelCall(gateway, budget.lease_id).catch(() => undefined);
      await settleStage(gateway, session, operationId, {
        status: "failed",
        error: { code: cause.code },
      });
      refuse("MODEL_STAGE_FAILED", project.active_version_id);
    }
    if (attempt >= OPERATION_MAX_ATTEMPTS) {
      await settleStage(gateway, session, operationId, {
        status: "failed",
        error: { code: "ATTEMPTS_EXHAUSTED" },
      });
      refuse("ATTEMPTS_EXHAUSTED", project.active_version_id);
    }
    await gateway.parkOperation(operationId, session.id, {
      rejected: null,
      errors: [{ code: cause.code, detail: "the provider did not return a usable result" }],
    });
    refuse("MODEL_STAGE_FAILED", project.active_version_id);
  }
}

/** The most recent wording this application generated and showed the creator. */
async function lastShownPreview(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
): Promise<{ ending_id: string; text: string } | null> {
  const operation = await gateway.findLatestOperation(project.id, session.id, "ending_copy");
  if (operation === null) return null;
  const parsed = StoredPreviewSchema.safeParse(operation.result);
  if (!parsed.success) return null;
  return { ending_id: parsed.data.preview.ending_id, text: parsed.data.preview.text };
}

/* --------------------------------------------------------------- helpers */

/** The stored clean base and the modules bound to the current approvals. */
async function readComposition(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
): Promise<{
  base: NonNullable<ReturnType<typeof readStoredBase>>;
  modules: InfluenceModule[];
} | null> {
  const stored = await gateway.findProjectCompilationState(project.id, session.id);
  if (stored === null) return null;
  const base = readStoredBase(stored.base_scene);
  if (base === null) return null;
  const storedModules = readStoredModules(stored.compiled_modules);
  const modules = SLOTS.flatMap((slot) => {
    const entry = storedModules[slot];
    return entry === undefined ? [] : [entry.module];
  });
  return { base, modules };
}

async function dropStoredModule(
  gateway: DataGateway,
  session: SessionRow,
  projectId: string,
  slot: Slot,
): Promise<void> {
  const row = await gateway.findProjectForOwner(projectId, session.id);
  if (row === null) return;
  const stored = await gateway.findProjectCompilationState(projectId, session.id);
  if (stored === null) return;
  const modules = readStoredModules(stored.compiled_modules);
  if (modules[slot] === undefined) return;
  const remaining: Record<string, unknown> = {};
  for (const candidate of SLOTS) {
    if (candidate === slot) continue;
    const entry = modules[candidate];
    if (entry !== undefined) remaining[candidate] = entry;
  }
  await gateway.setProjectCompilationState({
    projectId,
    ownerSessionId: session.id,
    expectedRevision: row.revision,
    baseScene: null,
    baseHash: null,
    compiledModules: remaining,
    workflowState: null,
  });
}

/** The frozen proposal behind one current approval, read from its own row. */
async function frozenProposalOf(
  gateway: DataGateway,
  session: SessionRow,
  project: ProjectRow,
  decisionId: string,
): Promise<ProposedInterpretation | null> {
  const decisions = await listDecisions(gateway, session, project.id);
  const decision = decisions.find((candidate) => candidate.id === decisionId);
  if (decision === undefined) return null;
  const snapshot = DecisionSnapshotSchema.safeParse(decision.proposal_snapshot);
  if (!snapshot.success || snapshot.data.proposal === null) return null;
  const parsed = ProposedInterpretationSchema.safeParse(snapshot.data.proposal);
  return parsed.success ? parsed.data : null;
}

function proposalFromDraft(
  project: ProjectRow,
  proposalId: string,
): ProposedInterpretation | null {
  const draft = proposalDraftOf(project);
  return (
    draft?.proposals.find((candidate) => candidate.proposal_id === proposalId) ?? null
  );
}

function decisionSnapshot(input: {
  kind: DecisionKind;
  proposal: ProposedInterpretation;
  approvedText: string;
  intendedEffect: string;
  editedByCreator: boolean;
  revision: number;
  now: Date;
}): DecisionSnapshot {
  return DecisionSnapshotSchema.parse({
    kind: input.kind,
    // Frozen exactly as it was shown. A revision approves new wording beside
    // this snapshot; it never rewrites the snapshot or its Qloo evidence.
    proposal: input.proposal,
    proposed_slot: input.proposal.slot,
    approved_text: input.approvedText,
    intended_effect: input.intendedEffect,
    edited_by_creator: input.editedByCreator,
    source_kind: "qloo",
    decided_at: input.now.toISOString(),
    project_revision: input.revision,
  } satisfies DecisionSnapshot);
}

function removalSnapshot(slot: Slot, revision: number, now: Date): DecisionSnapshot {
  return DecisionSnapshotSchema.parse({
    kind: "remove",
    proposal: null,
    proposed_slot: slot,
    approved_text: null,
    intended_effect: null,
    edited_by_creator: false,
    source_kind: "qloo",
    decided_at: now.toISOString(),
    project_revision: revision,
  } satisfies DecisionSnapshot);
}

/** A revision may cite fewer of the proposal's evidence items, never others. */
function narrowed(
  requested: readonly string[] | undefined,
  proposal: ProposedInterpretation,
): string[] {
  if (requested === undefined) return [...proposal.selected_evidence_ids];
  const owned = new Set(proposal.selected_evidence_ids);
  for (const candidate of requested) {
    if (!owned.has(candidate)) {
      throw appErrors.validationFailed(
        "a revision may cite fewer of the proposal's evidence items, never others",
      );
    }
  }
  const unique = [...new Set(requested)];
  if (unique.length === 0) {
    throw appErrors.validationFailed("an approval must cite at least one evidence item");
  }
  return unique;
}

function assertCreatorText(
  field: string,
  value: string,
  forbidden: readonly string[],
): void {
  if (value.trim().length === 0) throw appErrors.validationFailed(`${field} is empty`);
  if (!isPlainText(value)) {
    throw appErrors.validationFailed(`${field} contains control characters`);
  }
  for (const phrase of forbidden) {
    if (containsLiteralPhrase(value, phrase)) {
      throw appErrors.validationFailed(`${field} uses wording this brief forbids`);
    }
  }
}

/**
 * The daily revision allowance of section 12.
 *
 * Counted per reserved operation row across both revision stages, so a
 * replayed identical command does not consume a second unit — its reservation
 * is the same row — and a failed one does consume its own.
 */
async function assertRevisionAllowance(
  gateway: DataGateway,
  session: SessionRow,
  deps: Phase4Deps,
  now: Date,
): Promise<void> {
  const limit = deps.budget().revisionsPerSessionPerDay;
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const used = await gateway.countOperationsForOwnerSince(
    session.id,
    REVISION_STAGES,
    since,
  );
  if (used >= limit) {
    throw appErrors.rateLimited(
      `This browser has used its ${limit} revisions for today. Your scene and every version of it are unchanged.`,
    );
  }
}

function json(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
