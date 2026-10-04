/**
 * The four locked Phase 4 routes (specification section 11).
 *
 * ```text
 * POST /api/projects/:id/compile      freeze the inputs, create the operation
 * POST /api/operations/:id/advance    perform the next permitted stage
 * GET  /api/operations/:id            owner-only checkpoint, initiates nothing
 * POST /api/projects/:id/activate     explicit review confirmation or decline
 * ```
 *
 * None of them is an arbitrary prompt endpoint and none is an arbitrary
 * state-transition endpoint. `compile` takes one field, the revision the
 * creator is acting against. `advance` takes an **empty** body: there is no
 * field in which to name a stage, a prompt, a model, a schema, or a tool, and
 * the controller chooses the only legal transition. `activate` names the
 * version the creator reviewed, and the compare-and-swap in SQL decides
 * whether it may still become current.
 *
 * Compilation makes **zero Qloo calls**. It reads the frozen approvals and the
 * immutable captures the creator already approved; when that evidence cannot
 * be authoritatively rebuilt it fails with `MISSING_APPROVED_EVIDENCE` rather
 * than retrieving a replacement.
 */

import {
  ActivateRequestSchema,
  AdvanceRequestSchema,
  type AdvanceResponse,
  type ActivateResponse,
  type CompilationCheckpoint,
  type CompilationStatus,
  CompileRequestSchema,
  type CompileResponse,
  FAILURE_MESSAGES,
  STAGE_LABELS,
} from "@/domain/compile";
import type { ApprovedInfluence, ApprovedInfluencePayload, Slot } from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import { WorkflowStateSchema } from "@/domain/project";
import {
  advanceCompilation,
  freezeCompilation,
  initialCheckpoint,
  nextStage,
  ORDERED_STAGES,
  readCheckpoint,
  stateOf,
} from "../compile/controller";
import { openAiCompiler, type SceneCompiler } from "../compile/compiler";
import { buildApprovedInfluencePayload } from "../influence/payload";
import { resolveApprovals } from "../influence/approvals";
import { captureIdsForApprovals } from "../influence/provenance";
import { readCapturesByIds } from "../qloo/cache";
import { readProjectForOwner } from "../db/projects";
import type { DataGateway, OperationSummary, ProjectRow, SessionRow } from "../db/gateway";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { reserveStage } from "../db/operations";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import type { Phase4Deps } from "./deps";
import { parseProjectId, requireProject, validateBody } from "./shared";

/** The controller row's lease, long enough to outlive one stage deadline. */
const COMPILE_STAGE = "compile" as const;

/** Four attempts is a ceiling on controller rows, not on provider calls. */
const COMPILE_CONTROLLER_MAX_ATTEMPTS = 4;

function compilerFor(deps: Phase4Deps): SceneCompiler {
  if (deps.compiler !== undefined) return deps.compiler;
  return openAiCompiler(deps.modelClient === undefined ? {} : { client: deps.modelClient });
}

/* ------------------------------------------------------- shared resolution */

type CompilationInputs = {
  brief: Awaited<ReturnType<typeof readBrief>>;
  approvals: ApprovedInfluence[];
  approvalPayloads: Map<Slot, ApprovedInfluencePayload>;
};

async function readBrief(gateway: DataGateway, session: SessionRow, row: ProjectRow) {
  const { readProjectViewForOwner } = await import("../db/projects");
  return (await readProjectViewForOwner(gateway, session, row)).brief;
}

/**
 * Resolves the frozen approvals and their compiler-facing payloads.
 *
 * The payload comes from phase 3's `buildApprovedInfluencePayload`, which
 * returns `null` when the approval's cited evidence is not present in the
 * capture it names. That `null` is a hard failure here: a compilation that
 * cannot ground a module in stored evidence must not quietly proceed on a
 * narrower input, and it must not go and fetch a replacement.
 */
async function resolveCompilationInputs(
  gateway: DataGateway,
  session: SessionRow,
  row: ProjectRow,
): Promise<CompilationInputs> {
  const brief = await readBrief(gateway, session, row);
  const approvals = await resolveApprovals(gateway, session, row);
  if (approvals.length === 0) {
    throw appErrors.validationFailed(FAILURE_MESSAGES.NO_ACTIVE_APPROVAL);
  }

  // Read by id, so a capture a frozen approval points at is available
  // regardless of its lookup TTL. No upstream request is made here.
  const captures = await readCapturesByIds(gateway, captureIdsForApprovals(approvals));
  const byCaptureId = new Map(
    captures
      .filter((capture) => capture.capture_id !== null)
      .map((capture) => [capture.capture_id as string, capture]),
  );

  const approvalPayloads = new Map<Slot, ApprovedInfluencePayload>();
  for (const slot of SLOTS) {
    const approval = approvals.find((candidate) => candidate.slot === slot);
    if (approval === undefined) continue;
    const capture =
      approval.capture_id === null ? undefined : byCaptureId.get(approval.capture_id);
    const payload =
      capture === undefined ? null : buildApprovedInfluencePayload(approval, capture);
    if (payload === null) {
      throw appErrors.validationFailed(FAILURE_MESSAGES.MISSING_APPROVED_EVIDENCE);
    }
    approvalPayloads.set(slot, payload);
  }

  return { brief, approvals, approvalPayloads };
}

/* ------------------------------------------------------------ the status */

export function toCompilationStatus(
  operation: OperationSummary,
  checkpoint: CompilationCheckpoint,
  project: ProjectRow,
): CompilationStatus {
  const stage = nextStage(checkpoint);
  const workflow = WorkflowStateSchema.safeParse(project.workflow_state);
  return {
    operation_id: operation.id,
    state: stateOf(checkpoint),
    next_stage: stage,
    next_stage_label: stage === null ? null : STAGE_LABELS[stage],
    stages: ORDERED_STAGES.filter(
      (candidate) => checkpoint.stages[candidate] !== undefined,
    ).map((candidate) => {
      const entry = checkpoint.stages[candidate];
      return {
        stage: candidate,
        label: STAGE_LABELS[candidate],
        status:
          entry === undefined
            ? ("waiting" as const)
            : entry.status === "pending" && entry.attempts === 0
              ? ("waiting" as const)
              : entry.status,
        attempts: entry?.attempts ?? 0,
        repaired: entry?.repaired ?? false,
      };
    }),
    model_calls: checkpoint.model_calls,
    version_id: checkpoint.version_id,
    failure:
      checkpoint.failure === null
        ? null
        : {
            code: checkpoint.failure.code,
            stage: checkpoint.failure.stage,
            message: FAILURE_MESSAGES[checkpoint.failure.code],
          },
    workflow_state: workflow.success ? workflow.data : "FAILED",
    // Preserved across every failure. The previous playable stays playable.
    last_good_version_id: project.active_version_id,
  };
}

/* ------------------------------------------------------- POST .../compile */

export async function handleCompile(
  request: Request,
  deps: Phase4Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input = validateBody(CompileRequestSchema, raw);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    const row = await requireProject(gateway, session, id);
    if (row.revision !== input.expected_revision) {
      throw appErrors.rateLimited(
        `Your choices changed while this request was in flight. Reload: the project is now at revision ${row.revision}.`,
      );
    }

    const inputs = await resolveCompilationInputs(gateway, session, row);
    const stored = await gateway.findProjectCompilationState(id, session.id);
    const frozen = freezeCompilation({
      project: row,
      brief: inputs.brief,
      approvals: inputs.approvals,
      approvalPayloads: inputs.approvalPayloads,
      baseHash: stored?.base_hash ?? null,
      now,
    });

    // An existing compilation for these exact frozen inputs is replayed rather
    // than duplicated, so a double-clicked button buys no second operation.
    const existing = await gateway.findLatestOperation(id, session.id, COMPILE_STAGE);
    if (existing !== null && existing.input_hash === frozen.inputHash) {
      const checkpoint = readCheckpoint(existing.result) ?? initialCheckpoint(frozen.snapshot);
      const response: CompileResponse = {
        status: toCompilationStatus(existing, checkpoint, row),
        replayed: true,
      };
      return json(response, requestId);
    }

    // One active generation operation per project (specification section 12).
    if (existing !== null && existing.status !== "succeeded" && existing.status !== "failed") {
      const leaseLive =
        existing.lease_expires_at !== null &&
        Date.parse(existing.lease_expires_at) > now.getTime();
      if (leaseLive) {
        throw appErrors.rateLimited(
          "This project already has a build in progress. Wait for it to finish.",
        );
      }
      // Abandoned against inputs that have since moved: close it honestly.
      const abandoned = readCheckpoint(existing.result);
      await gateway.completeOperation({
        operationId: existing.id,
        ownerSessionId: session.id,
        status: "failed",
        result:
          abandoned === null
            ? null
            : { ...abandoned, state: "FAILED", failure: { code: "STALE_INPUT", stage: null } },
        error: { code: "STALE_INPUT" },
      });
    }

    const reservation = await reserveStage(
      gateway,
      session,
      {
        projectId: id,
        stage: COMPILE_STAGE,
        inputRevision: row.revision,
        inputHash: frozen.inputHash,
      },
      { maxAttempts: COMPILE_CONTROLLER_MAX_ATTEMPTS },
    );
    if (reservation.outcome === "not_found") throw appErrors.notFound();
    if (reservation.outcome !== "reserved") {
      throw appErrors.rateLimited(
        "This project already has a build in progress. Wait for it to finish.",
      );
    }

    const checkpoint = initialCheckpoint(frozen.snapshot);
    // Park immediately: creating a compilation performs no provider call, and
    // the browser asks for the first stage in a separate advance request.
    await gateway.parkOperation(reservation.operation.id, session.id, checkpoint);
    await gateway.setProjectCompilationState({
      projectId: id,
      ownerSessionId: session.id,
      expectedRevision: row.revision,
      baseScene: null,
      baseHash: null,
      pendingModules: null,
      workflowState: "AWAITING_APPROVAL",
    });

    const refreshed = await requireProject(gateway, session, id);
    const response: CompileResponse = {
      status: toCompilationStatus(reservation.operation, checkpoint, refreshed),
      replayed: false,
    };
    return json(response, requestId, 201);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/* ------------------------------------------- POST /api/operations/:id/advance */

export async function handleAdvance(
  request: Request,
  deps: Phase4Deps,
  operationId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    // An empty body. There is no field here that could name a stage.
    validateBody(AdvanceRequestSchema, raw);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(operationId);
    const operation = await gateway.findOperationForOwner(id, session.id);
    if (operation === null || operation.stage !== COMPILE_STAGE) throw appErrors.notFound();

    const checkpoint = readCheckpoint(operation.result);
    if (checkpoint === null) {
      throw appErrors.rateLimited(
        "This build has no readable checkpoint. Start a new build.",
      );
    }

    const row = await readProjectForOwner(gateway, session, operation.project_id);
    if (row === null) throw appErrors.notFound();

    const inputs = await resolveCompilationInputs(gateway, session, row);
    const result = await advanceCompilation(
      {
        gateway,
        session,
        brief: inputs.brief,
        approvals: inputs.approvals,
        approvalPayloads: inputs.approvalPayloads,
        compiler: compilerFor(deps),
        budget: deps.budget(),
        now,
      },
      row,
      id,
      checkpoint,
    );

    const refreshedOperation =
      (await gateway.findOperationForOwner(id, session.id)) ?? operation;
    const refreshedProject = (await readProjectForOwner(gateway, session, row.id)) ?? row;
    const response: AdvanceResponse = {
      status: toCompilationStatus(refreshedOperation, result.checkpoint, refreshedProject),
      model_calls: result.modelCalls === 0 ? 0 : 1,
      replayed: result.replayed,
    };
    return json(response, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/* ------------------------------------------------- GET /api/operations/:id */

/**
 * The owner-only checkpoint read. It initiates nothing: no reservation, no
 * lease, no provider call. Polling this route cannot cause work.
 */
export async function handleOperationStatus(
  request: Request,
  deps: Phase4Deps,
  operationId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);

    const id = parseProjectId(operationId);
    const operation = await gateway.findOperationForOwner(id, session.id);
    if (operation === null || operation.stage !== COMPILE_STAGE) throw appErrors.notFound();

    const checkpoint = readCheckpoint(operation.result);
    if (checkpoint === null) throw appErrors.notFound();

    const row = await readProjectForOwner(gateway, session, operation.project_id);
    if (row === null) throw appErrors.notFound();

    return json(
      { status: toCompilationStatus(operation, checkpoint, row), replayed: true },
      requestId,
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/* ------------------------------------------------ POST .../activate */

/**
 * The creator's explicit review decision.
 *
 * Activation is never implicit: a successful compilation leaves a *pending*
 * version, and only this route makes one current. Declining preserves the
 * previously active version and leaves the declined version row untouched as a
 * labelled historical version.
 */
export async function handleActivate(
  request: Request,
  deps: Phase4Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input = validateBody(ActivateRequestSchema, raw);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    const row = await requireProject(gateway, session, id);

    const decision =
      input.decline === true
        ? await gateway.declineSceneVersion({
            projectId: id,
            ownerSessionId: session.id,
            expectedRevision: input.expected_revision,
            versionId: input.version_id,
          })
        : await gateway.activateSceneVersion({
            projectId: id,
            ownerSessionId: session.id,
            expectedRevision: input.expected_revision,
            versionId: input.version_id,
          });

    switch (decision.outcome) {
      case "not_found":
        throw appErrors.notFound();
      case "not_pending":
        throw appErrors.validationFailed(
          "that version is not the one awaiting your review",
        );
      case "revision_conflict":
        throw appErrors.rateLimited(
          `Your choices changed while this request was in flight. Reload: the project is now at revision ${decision.current_revision}.`,
        );
      case "stale_input":
        throw appErrors.rateLimited(FAILURE_MESSAGES.STALE_INPUT);
      default: {
        const workflow = WorkflowStateSchema.safeParse(decision.workflow_state);
        const response: ActivateResponse = {
          outcome: decision.outcome,
          active_version_id: decision.active_version_id,
          pending_version_id: decision.pending_version_id,
          workflow_state: workflow.success ? workflow.data : row.workflow_state === "READY" ? "READY" : "FAILED",
        };
        return json(response, requestId);
      }
    }
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

function json(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
