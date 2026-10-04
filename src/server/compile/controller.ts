/**
 * The persisted compilation controller (specification section 8).
 *
 * It is a bounded state machine over database rows, not an agent and not a
 * planner. Five properties are load-bearing, and each one is a mechanism
 * rather than a convention:
 *
 *   * **The controller chooses the stage.** {@link nextStage} reads the
 *     committed checkpoint and returns the only legal next transition. The
 *     browser's advance request carries an empty body, so there is nothing in
 *     it that could name a stage, a prompt, a model, or a tool.
 *   * **One advance performs at most one provider attempt.** Each stage
 *     function makes exactly one call and returns; the controller runs exactly
 *     one stage per advance and commits before returning.
 *   * **The attempt ceiling is the database's.** Every model stage has its own
 *     `operations` row with `max_attempts = 2`. A rejected candidate parks the
 *     row, the next advance's reservation spends attempt two, and a third
 *     advance gets `attempts_exhausted` from `reserve_operation` itself. There
 *     is no counter in this file that could drift from that.
 *   * **Duplicate work is impossible, not merely unlikely.** The controller
 *     row's lease is a row-locked mutex for the whole advance, and each stage
 *     is additionally keyed by its own frozen idempotency key.
 *   * **A stale result cannot become current.** The snapshot is re-checked
 *     against the live project at the start of every advance, and the version
 *     commit carries the same comparison into a single SQL compare-and-swap.
 *
 * Nothing here calls Qloo. Compilation reads the frozen approvals and the
 * stored evidence the creator already approved; if that evidence cannot be
 * authoritatively rebuilt, the compilation fails with
 * `MISSING_APPROVED_EVIDENCE` rather than retrieving a replacement.
 */

import type { Brief } from "@/domain/brief";
import {
  type CompilationCheckpoint,
  CompilationCheckpointSchema,
  type CompilationFailureCode,
  type CompilationSnapshot,
  type CompilationStage,
  type CompilationState,
  COMPILATION_STAGES,
  type StageCheckpoint,
} from "@/domain/compile";
import type { ApprovedInfluence, ApprovedInfluencePayload, Slot } from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import { hashCanonical, sha256Hex } from "@/engine/hash";
import { PINNED_CHAT_MODEL, type BudgetConfig } from "../config";
import {
  reconcileModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../db/budgets";
import type { DataGateway, ProjectRow, SessionRow } from "../db/gateway";
import {
  OPERATION_LEASE_SECONDS,
  OPERATION_MAX_ATTEMPTS,
  reserveStage,
  settleStage,
  type OperationStage,
} from "../db/operations";
import { ModelError } from "../model/openai";
import { appErrors } from "../security/errors";
import {
  assembleScene,
  coreHash,
  moduleHash,
  sceneApprovalAllowlist,
  sceneApprovalId,
} from "./assemble";
import type { SceneCompiler } from "./compiler";
import {
  COMPILER_IDENTIFIER,
  PROMPT_IDENTIFIER,
  SCHEMA_IDENTIFIER,
  VALIDATOR_IDENTIFIER,
} from "./identifiers";
import { buildBaseCompilationPayload, payloadHash } from "./payloads";
import {
  readStoredBase,
  readStoredModules,
  storedBaseFor,
  storedModuleFor,
  type StoredBase,
  type StoredModules,
} from "./state";
import {
  runBaseStage,
  runModuleStage,
  type RepairContext,
} from "./stages";
import { verifyCandidate } from "./verify";

/** The operation stage name for one slot's module. */
export function moduleStageFor(slot: Slot): CompilationStage {
  return slot === "discovery" ? "module_discovery" : "module_commitment";
}

export function slotOfStage(stage: CompilationStage): Slot | null {
  if (stage === "module_discovery") return "discovery";
  if (stage === "module_commitment") return "commitment";
  return null;
}

/* ------------------------------------------------------------- the freeze */

export type FrozenCompilation = {
  readonly snapshot: CompilationSnapshot;
  /** The compile operation's idempotency input, derived from the snapshot. */
  readonly inputHash: string;
  /** The brief-only base stage's own input hash. Independent of any approval. */
  readonly baseInputHash: string;
  /** One module stage input hash per approved slot. */
  readonly moduleInputHashes: Readonly<Partial<Record<Slot, string>>>;
};

/**
 * Freezes exactly what a compilation will use.
 *
 * `baseInputHash` is derived from the brief-only payload, so it does not move
 * when an approval changes. That is what makes "do not regenerate the base
 * merely because a module changed" a property of the key rather than a rule
 * someone has to remember.
 */
export function freezeCompilation(input: {
  project: ProjectRow;
  brief: Brief;
  approvals: readonly ApprovedInfluence[];
  approvalPayloads: ReadonlyMap<Slot, ApprovedInfluencePayload>;
  baseHash: string | null;
  now: Date;
}): FrozenCompilation {
  const briefHash = hashCanonical(input.brief);
  const baseInputHash = payloadHash(buildBaseCompilationPayload(input.brief));

  const approvals = SLOTS.flatMap((slot) => {
    const approval = input.approvals.find((candidate) => candidate.slot === slot);
    const payload = input.approvalPayloads.get(slot);
    if (approval === undefined || payload === undefined) return [];
    return [
      {
        slot,
        approval_id: approval.approval_id,
        input_hash: payloadHash(payload),
      },
    ];
  });

  const moduleInputHashes: Partial<Record<Slot, string>> = {};
  for (const entry of approvals) {
    moduleInputHashes[entry.slot] = sha256Hex(
      [
        "module",
        entry.slot,
        baseInputHash,
        entry.approval_id,
        entry.input_hash,
        COMPILER_IDENTIFIER,
        PROMPT_IDENTIFIER,
        SCHEMA_IDENTIFIER,
      ].join("|"),
    ).slice(0, 48);
  }

  const snapshot: CompilationSnapshot = {
    project_id: input.project.id,
    project_revision: input.project.revision,
    brief_hash: briefHash.slice(0, 48),
    base_hash: input.baseHash,
    approvals,
    model: PINNED_CHAT_MODEL,
    compiler_identifier: COMPILER_IDENTIFIER,
    prompt_identifier: PROMPT_IDENTIFIER,
    schema_identifier: SCHEMA_IDENTIFIER,
    validator_identifier: VALIDATOR_IDENTIFIER,
    frozen_at: input.now.toISOString(),
  };

  return {
    snapshot,
    inputHash: sha256Hex(
      [
        "compile",
        snapshot.project_revision,
        snapshot.brief_hash,
        ...approvals.flatMap((entry) => [entry.slot, entry.approval_id, entry.input_hash]),
        COMPILER_IDENTIFIER,
        PROMPT_IDENTIFIER,
        SCHEMA_IDENTIFIER,
        VALIDATOR_IDENTIFIER,
      ].join("|"),
    ).slice(0, 48),
    baseInputHash,
    moduleInputHashes,
  };
}

/* --------------------------------------------------------- the checkpoint */

const WAITING: StageCheckpoint = {
  status: "pending",
  attempts: 0,
  repaired: false,
  artifact_hash: null,
  failure_code: null,
};

export function initialCheckpoint(snapshot: CompilationSnapshot): CompilationCheckpoint {
  const stages: CompilationCheckpoint["stages"] = { base: { ...WAITING } };
  for (const entry of snapshot.approvals) stages[moduleStageFor(entry.slot)] = { ...WAITING };
  stages.validate = { ...WAITING };
  return {
    snapshot,
    state: "AWAITING_APPROVAL",
    stages,
    version_id: null,
    failure: null,
    model_calls: 0,
  };
}

export function readCheckpoint(value: unknown): CompilationCheckpoint | null {
  const parsed = CompilationCheckpointSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The only legal next transition, chosen here and nowhere else.
 *
 * Base first, then one module per approved slot in the fixed slot order, then
 * the deterministic validation stage. A failed compilation has no next stage.
 */
export function nextStage(checkpoint: CompilationCheckpoint): CompilationStage | null {
  if (checkpoint.failure !== null) return null;
  if (committed(checkpoint, "validate")) return null;
  if (!committed(checkpoint, "base")) return "base";
  for (const entry of checkpoint.snapshot.approvals) {
    const stage = moduleStageFor(entry.slot);
    if (!committed(checkpoint, stage)) return stage;
  }
  return "validate";
}

function committed(checkpoint: CompilationCheckpoint, stage: CompilationStage): boolean {
  return checkpoint.stages[stage]?.status === "committed";
}

/** The controller state implied by the committed stages. */
export function stateOf(checkpoint: CompilationCheckpoint): CompilationState {
  if (checkpoint.failure !== null) return "FAILED";
  if (committed(checkpoint, "validate")) return "REVIEW_PLAYABLE";
  if (!committed(checkpoint, "base")) return "AWAITING_APPROVAL";
  const modulesDone = checkpoint.snapshot.approvals.every((entry) =>
    committed(checkpoint, moduleStageFor(entry.slot)),
  );
  return modulesDone ? "MODULES_READY" : "BASE_READY";
}

function withStage(
  checkpoint: CompilationCheckpoint,
  stage: CompilationStage,
  patch: Partial<StageCheckpoint>,
): CompilationCheckpoint {
  const current = checkpoint.stages[stage] ?? { ...WAITING };
  const stages = { ...checkpoint.stages, [stage]: { ...current, ...patch } };
  const next = { ...checkpoint, stages };
  return { ...next, state: stateOf(next) };
}

function failed(
  checkpoint: CompilationCheckpoint,
  code: CompilationFailureCode,
  stage: CompilationStage | null,
): CompilationCheckpoint {
  return {
    ...checkpoint,
    state: "FAILED",
    failure: { code, stage },
    stages:
      stage === null
        ? checkpoint.stages
        : {
            ...checkpoint.stages,
            [stage]: {
              ...(checkpoint.stages[stage] ?? { ...WAITING }),
              status: "failed",
              failure_code: code,
            },
          },
  };
}

/* ----------------------------------------------------- the advance context */

export type CompilationContext = {
  readonly gateway: DataGateway;
  readonly session: SessionRow;
  readonly brief: Brief;
  readonly approvals: readonly ApprovedInfluence[];
  readonly approvalPayloads: ReadonlyMap<Slot, ApprovedInfluencePayload>;
  readonly compiler: SceneCompiler;
  readonly budget: BudgetConfig;
  readonly now: Date;
};

export type AdvanceResult = {
  readonly checkpoint: CompilationCheckpoint;
  /** Provider attempts this advance made. Never more than one. */
  readonly modelCalls: number;
  /** True when the requested stage was already committed. */
  readonly replayed: boolean;
  /** True when the operation reached a terminal state in this advance. */
  readonly settled: boolean;
};

/**
 * Re-checks the frozen snapshot against the live project.
 *
 * Called at the start of every advance and again, in SQL, when a version is
 * committed. An approval that moved while a provider call was in flight is
 * caught here even though the call itself knew nothing about it.
 */
export function snapshotMatches(
  snapshot: CompilationSnapshot,
  project: ProjectRow,
  brief: Brief,
): boolean {
  if (project.revision !== snapshot.project_revision) return false;
  if (hashCanonical(brief).slice(0, 48) !== snapshot.brief_hash) return false;

  const frozen = new Map(snapshot.approvals.map((entry) => [entry.slot, entry.approval_id]));
  const live = new Map<string, string>();
  for (const slot of SLOTS) {
    const value = project.active_approvals[slot];
    if (typeof value === "string" && value.length > 0) live.set(slot, value);
  }
  if (frozen.size !== live.size) return false;
  for (const [slot, approvalId] of frozen) {
    if (live.get(slot) !== approvalId) return false;
  }
  return true;
}

/** The project's current approval pointers, for the SQL compare-and-swap. */
export function approvalPointers(project: ProjectRow): Record<string, string> {
  const pointers: Record<string, string> = {};
  for (const slot of SLOTS) {
    const value = project.active_approvals[slot];
    if (typeof value === "string" && value.length > 0) pointers[slot] = value;
  }
  return pointers;
}

/* ------------------------------------------------------------- the advance */

/**
 * Performs the next legal stage, commits it, and returns.
 *
 * `project` must be the row read in this request, so the compare-and-swap uses
 * live state rather than the state the compilation was created against.
 */
export async function advanceCompilation(
  context: CompilationContext,
  project: ProjectRow,
  operationId: string,
  checkpoint: CompilationCheckpoint,
): Promise<AdvanceResult> {
  const { gateway, session } = context;

  // 1. Stale inputs stop the compilation before anything else happens.
  if (!snapshotMatches(checkpoint.snapshot, project, context.brief)) {
    const stale = failed(checkpoint, "STALE_INPUT", nextStage(checkpoint));
    await settleCompilation(context, operationId, stale);
    return { checkpoint: stale, modelCalls: 0, replayed: false, settled: true };
  }

  const stage = nextStage(checkpoint);
  if (stage === null) {
    return { checkpoint, modelCalls: 0, replayed: true, settled: false };
  }

  // 2. The controller row's lease is the mutex for this whole advance.
  const lease = await gateway.leaseCompileOperation(
    operationId,
    session.id,
    OPERATION_LEASE_SECONDS,
  );
  switch (lease.outcome) {
    case "not_found":
      throw appErrors.notFound();
    case "lease_held":
      throw appErrors.rateLimited(
        "This project already has a step in progress. Wait for it to finish.",
      );
    case "settled":
      return { checkpoint, modelCalls: 0, replayed: true, settled: true };
    case "leased":
      break;
  }

  try {
    const result =
      stage === "validate"
        ? await runValidateStage(context, project, operationId, checkpoint)
        : await runModelStage(context, project, checkpoint, stage);

    if (result.settled) {
      await settleCompilation(context, operationId, result.checkpoint);
    } else {
      await gateway.parkOperation(operationId, session.id, result.checkpoint);
    }
    return result;
  } catch (error) {
    // An unexpected failure must not leave the controller leased forever.
    await gateway.parkOperation(operationId, session.id, checkpoint);
    throw error;
  }
}

async function settleCompilation(
  context: CompilationContext,
  operationId: string,
  checkpoint: CompilationCheckpoint,
): Promise<void> {
  await context.gateway.completeOperation({
    operationId,
    ownerSessionId: context.session.id,
    status: checkpoint.failure === null ? "succeeded" : "failed",
    result: checkpoint,
    error:
      checkpoint.failure === null
        ? null
        : { code: checkpoint.failure.code, stage: checkpoint.failure.stage },
  });
}

/* --------------------------------------------------------- the model stages */

type StageRun = AdvanceResult;

async function runModelStage(
  context: CompilationContext,
  project: ProjectRow,
  checkpoint: CompilationCheckpoint,
  stage: Exclude<CompilationStage, "validate">,
): Promise<StageRun> {
  const { gateway, session } = context;
  const slot = slotOfStage(stage);

  const stored = await gateway.findProjectCompilationState(project.id, session.id);
  if (stored === null) throw appErrors.notFound();
  const storedBase = readStoredBase(stored.base_scene);
  const storedModules = readStoredModules(stored.pending_modules);

  const frozen = freezeCompilation({
    project,
    brief: context.brief,
    approvals: context.approvals,
    approvalPayloads: context.approvalPayloads,
    baseHash: stored.base_hash,
    now: context.now,
  });

  const stageInputHash =
    slot === null
      ? frozen.baseInputHash
      : (frozen.moduleInputHashes[slot] ?? frozen.baseInputHash);

  // A clean base compiled for this exact brief is reused, not regenerated.
  if (stage === "base" && storedBase !== null && storedBase.input_hash === frozen.baseInputHash) {
    return {
      checkpoint: withStage(checkpoint, "base", {
        status: "committed",
        artifact_hash: storedBase.hash,
      }),
      modelCalls: 0,
      replayed: true,
      settled: false,
    };
  }

  // A module already committed under this exact frozen input is reused too.
  if (slot !== null) {
    const existing = storedModules[slot];
    if (existing !== undefined && existing.input_hash === stageInputHash) {
      return {
        checkpoint: withStage(checkpoint, stage, {
          status: "committed",
          artifact_hash: existing.hash,
        }),
        modelCalls: 0,
        replayed: true,
        settled: false,
      };
    }
  }

  if (stage !== "base" && storedBase === null) {
    // The foundation is gone, so there is nothing to attach to.
    return {
      checkpoint: failed(checkpoint, "VALIDATION_FAILED", stage),
      modelCalls: 0,
      replayed: false,
      settled: true,
    };
  }

  // The stage's own operation row owns the attempt ceiling.
  const reservation = await reserveStage(
    gateway,
    session,
    {
      projectId: project.id,
      stage: stage as OperationStage,
      inputRevision: project.revision,
      inputHash: stageInputHash,
    },
    { maxAttempts: OPERATION_MAX_ATTEMPTS },
  );

  switch (reservation.outcome) {
    case "not_found":
      throw appErrors.notFound();
    case "lease_held":
      throw appErrors.rateLimited(
        "This step is already running. Wait for it to finish.",
      );
    case "attempts_exhausted":
      return {
        checkpoint: failed(checkpoint, "ATTEMPTS_EXHAUSTED", stage),
        modelCalls: 0,
        replayed: false,
        settled: true,
      };
    case "settled":
      // Committed earlier but not yet reflected in the checkpoint; the
      // artifact reuse above will pick it up on the next advance.
      return {
        checkpoint: withStage(checkpoint, stage, {
          status: "pending",
          attempts: reservation.operation.attempts,
        }),
        modelCalls: 0,
        replayed: true,
        settled: false,
      };
    case "reserved":
      break;
  }

  const stageOperationId = reservation.operation.id;
  const attempt = reservation.operation.attempts;
  const repair = attempt > 1 ? readRepairContext(reservation.operation.result) : null;

  // The budget is reserved before the call and reconciled after it.
  const budget = await reserveModelCall(gateway, context.budget, { now: context.now });
  if (!budget.granted) {
    await gateway.parkOperation(stageOperationId, session.id, null);
    throw appErrors.budgetExhausted(
      `This application's configured cap of ${budget.call_limit} model calls for the current window is used up. It resets at ${budget.window_end}. The saved example still plays.`,
    );
  }

  let outcomeCheckpoint = checkpoint;
  let settled = false;

  try {
    if (stage === "base") {
      const outcome = await runBaseStage(
        { brief: context.brief, inputHash: frozen.inputHash, repair },
        context.compiler,
      );
      await reconcileModelCall(gateway, budget.lease_id, {
        tokens: outcome.usage?.total_tokens ?? 0,
      });

      if (outcome.kind === "rejected") {
        await gateway.parkOperation(stageOperationId, session.id, {
          rejected: outcome.candidate,
          errors: outcome.errors.slice(0, 10),
        });
        outcomeCheckpoint = withStage(checkpoint, "base", {
          status: "pending",
          attempts: attempt,
          failure_code: outcome.resourceLimited
            ? "VALIDATION_RESOURCE_LIMIT"
            : "VALIDATION_FAILED",
        });
        if (attempt >= OPERATION_MAX_ATTEMPTS) {
          outcomeCheckpoint = failed(
            outcomeCheckpoint,
            outcome.resourceLimited ? "VALIDATION_RESOURCE_LIMIT" : "VALIDATION_FAILED",
            "base",
          );
          settled = true;
        }
      } else {
        const hash = coreHash(outcome.artifact.core);
        const update = await gateway.setProjectCompilationState({
          projectId: project.id,
          ownerSessionId: session.id,
          expectedRevision: project.revision,
          baseScene: storedBaseFor({
            inputHash: frozen.baseInputHash,
            hash,
            title: outcome.artifact.title,
            core: outcome.artifact.core,
            model: outcome.model,
            compiledAt: context.now.toISOString(),
          }),
          baseHash: hash,
          pendingModules: null,
          workflowState: "BASE_READY",
        });
        if (update.outcome !== "updated") {
          await settleStage(gateway, session, stageOperationId, {
            status: "failed",
            error: { code: "STALE_INPUT" },
          });
          return {
            checkpoint: failed(checkpoint, "STALE_INPUT", "base"),
            modelCalls: 1,
            replayed: false,
            settled: true,
          };
        }
        await settleStage(gateway, session, stageOperationId, {
          status: "succeeded",
          result: { artifact_hash: hash, attempts: attempt },
        });
        outcomeCheckpoint = withStage(checkpoint, "base", {
          status: "committed",
          attempts: attempt,
          repaired: attempt > 1,
          artifact_hash: hash,
          failure_code: null,
        });
      }
    } else {
      const approval = context.approvals.find((candidate) => candidate.slot === slot);
      const approvalPayload = slot === null ? undefined : context.approvalPayloads.get(slot);
      if (approval === undefined || approvalPayload === undefined || slot === null) {
        await reconcileModelCall(gateway, budget.lease_id, { tokens: 0 });
        await settleStage(gateway, session, stageOperationId, {
          status: "failed",
          error: { code: "MISSING_APPROVED_EVIDENCE" },
        });
        return {
          checkpoint: failed(checkpoint, "MISSING_APPROVED_EVIDENCE", stage),
          modelCalls: 0,
          replayed: false,
          settled: true,
        };
      }

      const base = storedBase as StoredBase;
      const outcome = await runModuleStage(
        {
          brief: context.brief,
          inputHash: frozen.inputHash,
          core: base.core,
          baseTitle: base.title,
          slot,
          approval,
          approvalPayload,
          repair,
        },
        context.compiler,
      );
      await reconcileModelCall(gateway, budget.lease_id, {
        tokens: outcome.usage?.total_tokens ?? 0,
      });

      if (outcome.kind === "rejected") {
        await gateway.parkOperation(stageOperationId, session.id, {
          rejected: outcome.candidate,
          errors: outcome.errors.slice(0, 10),
        });
        outcomeCheckpoint = withStage(checkpoint, stage, {
          status: "pending",
          attempts: attempt,
          failure_code: outcome.resourceLimited
            ? "VALIDATION_RESOURCE_LIMIT"
            : "VALIDATION_FAILED",
        });
        if (attempt >= OPERATION_MAX_ATTEMPTS) {
          outcomeCheckpoint = failed(
            outcomeCheckpoint,
            outcome.resourceLimited ? "VALIDATION_RESOURCE_LIMIT" : "VALIDATION_FAILED",
            stage,
          );
          settled = true;
        }
      } else {
        const hash = moduleHash(outcome.artifact.module);
        const nextModules: StoredModules = {
          ...storedModules,
          [slot]: storedModuleFor({
            inputHash: stageInputHash,
            hash,
            module: outcome.artifact.module,
            model: outcome.model,
            compiledAt: context.now.toISOString(),
          }),
        };
        const update = await gateway.setProjectCompilationState({
          projectId: project.id,
          ownerSessionId: session.id,
          expectedRevision: project.revision,
          baseScene: null,
          baseHash: null,
          pendingModules: nextModules,
          workflowState: "MODULES_READY",
        });
        if (update.outcome !== "updated") {
          await settleStage(gateway, session, stageOperationId, {
            status: "failed",
            error: { code: "STALE_INPUT" },
          });
          return {
            checkpoint: failed(checkpoint, "STALE_INPUT", stage),
            modelCalls: 1,
            replayed: false,
            settled: true,
          };
        }
        await settleStage(gateway, session, stageOperationId, {
          status: "succeeded",
          result: { artifact_hash: hash, attempts: attempt },
        });
        outcomeCheckpoint = withStage(checkpoint, stage, {
          status: "committed",
          attempts: attempt,
          repaired: attempt > 1,
          artifact_hash: hash,
          failure_code: null,
        });
      }
    }
  } catch (cause) {
    // A provider failure is one spent attempt. The stage is parked so the one
    // permitted further attempt stays available inside the same ceiling.
    await reconcileModelCall(gateway, budget.lease_id, { tokens: 0 }).catch(() => undefined);
    if (!(cause instanceof ModelError)) {
      await gateway.parkOperation(stageOperationId, session.id, null);
      throw cause;
    }
    if (!cause.attemptSpent) {
      await releaseModelCall(gateway, budget.lease_id).catch(() => undefined);
      await settleStage(gateway, session, stageOperationId, {
        status: "failed",
        error: { code: cause.code },
      });
      return {
        checkpoint: failed(checkpoint, "MODEL_STAGE_FAILED", stage),
        modelCalls: 0,
        replayed: false,
        settled: true,
      };
    }
    await gateway.parkOperation(stageOperationId, session.id, {
      rejected: null,
      errors: [{ code: cause.code, detail: "the provider did not return a usable result" }],
    });
    let next = withStage(checkpoint, stage, {
      status: "pending",
      attempts: attempt,
      failure_code: "MODEL_STAGE_FAILED",
    });
    if (attempt >= OPERATION_MAX_ATTEMPTS) {
      next = failed(next, "MODEL_STAGE_FAILED", stage);
      return { checkpoint: next, modelCalls: 1, replayed: false, settled: true };
    }
    return { checkpoint: next, modelCalls: 1, replayed: false, settled: false };
  }

  return {
    checkpoint: { ...outcomeCheckpoint, model_calls: checkpoint.model_calls + 1 },
    modelCalls: 1,
    replayed: false,
    settled,
  };
}

/** The parked candidate and findings a repair attempt is shown. */
export function readRepairContext(result: unknown): RepairContext | null {
  if (result === null || typeof result !== "object") return null;
  const source = result as { rejected?: unknown; errors?: unknown };
  if (!Array.isArray(source.errors)) return null;
  const errors = source.errors
    .filter(
      (entry): entry is { code: string; detail: string } =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { code?: unknown }).code === "string" &&
        typeof (entry as { detail?: unknown }).detail === "string",
    )
    .slice(0, 10);
  if (errors.length === 0) return null;
  return { candidate: source.rejected ?? null, errors };
}

/* ------------------------------------------------------- the validate stage */

/**
 * The deterministic stage: no provider call at all.
 *
 * It composes the clean base with every committed module, validates the full
 * candidate and every supported removal subset, requires a mechanical witness
 * per active module, and commits the version under the SQL compare-and-swap.
 */
async function runValidateStage(
  context: CompilationContext,
  project: ProjectRow,
  operationId: string,
  checkpoint: CompilationCheckpoint,
): Promise<StageRun> {
  const { gateway, session } = context;
  const stored = await gateway.findProjectCompilationState(project.id, session.id);
  if (stored === null) throw appErrors.notFound();

  const base = readStoredBase(stored.base_scene);
  const modules = readStoredModules(stored.pending_modules);
  if (base === null) {
    return {
      checkpoint: failed(checkpoint, "VALIDATION_FAILED", "validate"),
      modelCalls: 0,
      replayed: false,
      settled: true,
    };
  }

  const activeApprovals = checkpoint.snapshot.approvals.flatMap((entry) => {
    const approval = context.approvals.find((candidate) => candidate.slot === entry.slot);
    return approval === undefined ? [] : [approval];
  });
  const activeModules = checkpoint.snapshot.approvals.flatMap((entry) => {
    const module = modules[entry.slot];
    return module === undefined ? [] : [module.module];
  });

  if (activeModules.length !== checkpoint.snapshot.approvals.length) {
    return {
      checkpoint: failed(checkpoint, "VALIDATION_FAILED", "validate"),
      modelCalls: 0,
      replayed: false,
      settled: true,
    };
  }

  const assembled = assembleScene({
    brief: context.brief,
    inputHash: checkpoint.snapshot.approvals
      .map((entry) => entry.input_hash)
      .concat(base.hash)
      .join("|"),
    core: base.core,
    generatedTitle: base.title,
    modules: activeModules,
    approvals: activeApprovals,
  });
  if (!assembled.ok) {
    return {
      checkpoint: failed(checkpoint, "VALIDATION_FAILED", "validate"),
      modelCalls: 0,
      replayed: false,
      settled: true,
    };
  }

  const verdict = verifyCandidate(
    assembled.scene,
    context.brief,
    sceneApprovalAllowlist(activeApprovals),
  );
  if (!verdict.ok) {
    const code: CompilationFailureCode = verdict.resourceLimited
      ? "VALIDATION_RESOURCE_LIMIT"
      : verdict.subsetConflict
        ? "SUBSET_CONFLICT"
        : "VALIDATION_FAILED";
    return {
      checkpoint: failed(checkpoint, code, "validate"),
      modelCalls: 0,
      replayed: false,
      settled: true,
    };
  }

  const moduleHashes: Record<string, string> = {};
  for (const module of activeModules) moduleHashes[module.slot] = moduleHash(module);

  const commit = await gateway.commitSceneVersion({
    projectId: project.id,
    ownerSessionId: session.id,
    expectedRevision: checkpoint.snapshot.project_revision,
    expectedBaseHash: base.hash,
    expectedApprovals: approvalPointers(project),
    operationId,
    parentVersionId: project.active_version_id,
    inputHash: checkpoint.snapshot.brief_hash,
    baseHash: base.hash,
    moduleHashes,
    scene: assembled.scene,
    validationSummary: verdict.summary,
    inputSnapshot: checkpoint.snapshot,
    // Frozen per version, so a historical view does not change with today's
    // approvals. Identifiers and frozen wording only: no capture diagnostics.
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
    modelIdentifier: checkpoint.snapshot.model,
    promptIdentifier: checkpoint.snapshot.prompt_identifier,
    schemaIdentifier: checkpoint.snapshot.schema_identifier,
    compilerIdentifier: checkpoint.snapshot.compiler_identifier,
    validatorIdentifier: checkpoint.snapshot.validator_identifier,
  });

  if (commit.outcome !== "committed") {
    return {
      checkpoint: failed(
        checkpoint,
        commit.outcome === "stale_input" ? "STALE_INPUT" : "VALIDATION_FAILED",
        "validate",
      ),
      modelCalls: 0,
      replayed: false,
      settled: true,
    };
  }

  const done = withStage(checkpoint, "validate", {
    status: "committed",
    attempts: 1,
    artifact_hash: base.hash,
  });
  return {
    checkpoint: { ...done, version_id: commit.version_id, state: "REVIEW_PLAYABLE" },
    modelCalls: 0,
    replayed: false,
    settled: true,
  };
}

/** Every stage of a compilation, in order, for the status projection. */
export const ORDERED_STAGES: readonly CompilationStage[] = COMPILATION_STAGES;
