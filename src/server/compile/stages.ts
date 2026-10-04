/**
 * The three compilation stages, each performing **at most one** provider
 * attempt (specification section 8).
 *
 * This is the whole repair discipline, and it is deliberately split in two:
 *
 *   * A stage function here makes one call and either commits or rejects. It
 *     never loops, never retries, and never calls a second provider, so there
 *     is no place in this file where a hidden attempt could be spent.
 *   * The *controller* decides whether a rejected result gets the one
 *     permitted repair, and the database enforces the ceiling: the stage's
 *     operation row carries `max_attempts = 2`, a rejection parks it, and the
 *     next advance's reservation spends attempt two. A third advance gets
 *     `attempts_exhausted` from `reserve_operation` itself.
 *
 * A repair sees exactly three things: the same isolated context the first
 * attempt saw, its own rejected candidate, and this application's own
 * deterministic findings. `buildRepairPayload` takes the original payload
 * value by reference, so there is no argument through which more context could
 * enter.
 */

import type { Brief } from "@/domain/brief";
import {
  BaseCompilationOutputSchema,
  ModuleCompilationOutputSchema,
  type BaseCompilationOutput,
  type ModuleCompilationOutput,
} from "@/domain/compile";
import type { ApprovedInfluence, ApprovedInfluencePayload, Slot } from "@/domain/influence";
import type { CoreScene, InfluenceModule, Scene } from "@/domain/scene";
import {
  assembleScene,
  coreFromModelOutput,
  coreHash,
  moduleFromModelOutput,
  moduleHash,
  sceneApprovalAllowlist,
  worldFromBrief,
} from "./assemble";
import {
  BASE_MAX_OUTPUT_TOKENS,
  BASE_SCHEMA_NAME,
  MODULE_MAX_OUTPUT_TOKENS,
  MODULE_SCHEMA_NAME,
  type SceneCompiler,
} from "./compiler";
import {
  BASE_INSTRUCTIONS,
  moduleInstructions,
  REPAIR_NOTE_HEADING,
} from "./instructions";
import {
  buildBaseCompilationPayload,
  buildModuleCompilationPayload,
  buildRepairPayload,
  type DeterministicError,
} from "./payloads";
import type { ModelUsage } from "../model/openai";
import { verifyBase, verifyModule } from "./verify";

/**
 * What a rejected attempt hands to the one permitted repair.
 *
 * It is stored on the stage's parked operation row between advances, which is
 * why it is a plain serializable value rather than a closure.
 */
export type RepairContext = {
  readonly candidate: unknown;
  readonly errors: readonly DeterministicError[];
};

export type StageOutcome<T> =
  | {
      readonly kind: "committed";
      readonly artifact: T;
      readonly hash: string;
      readonly model: string;
      readonly usage: ModelUsage | null;
    }
  | {
      readonly kind: "rejected";
      readonly errors: DeterministicError[];
      /** The rejected candidate, for the repair that may follow. */
      readonly candidate: unknown;
      readonly resourceLimited: boolean;
      readonly model: string;
      readonly usage: ModelUsage | null;
    };

/** The findings note a repair is shown. Codes and sentences this code wrote. */
export function repairNote(errors: readonly DeterministicError[]): string {
  return [
    REPAIR_NOTE_HEADING,
    ...errors.slice(0, 10).map((error) => `- ${error.code}: ${error.detail}`),
  ].join("\n");
}

/* ------------------------------------------------------------ base stage */

export type BaseStageInput = {
  readonly brief: Brief;
  /** The frozen compilation input hash, which fixes the candidate's scene id. */
  readonly inputHash: string;
  readonly repair: RepairContext | null;
};

export type BaseStageOutcome = StageOutcome<{
  core: CoreScene;
  title: string;
  output: BaseCompilationOutput;
}>;

/**
 * Compiles the clean, brief-only foundation.
 *
 * The candidate is assembled into a module-free scene and handed to the Phase 1
 * validator. A base that cannot stand alone is rejected here, before any
 * module is compiled against it.
 */
export async function runBaseStage(
  input: BaseStageInput,
  compiler: SceneCompiler,
): Promise<BaseStageOutcome> {
  const payload = buildBaseCompilationPayload(input.brief);
  const repairing = input.repair !== null;

  const result = await compiler.generate({
    schemaName: BASE_SCHEMA_NAME,
    schema: BaseCompilationOutputSchema,
    instructions: repairing
      ? `${BASE_INSTRUCTIONS}\n\n${repairNote(input.repair?.errors ?? [])}`
      : BASE_INSTRUCTIONS,
    payload: repairing
      ? buildRepairPayload(payload, input.repair?.candidate ?? null, input.repair?.errors ?? [])
      : payload,
    maxOutputTokens: BASE_MAX_OUTPUT_TOKENS,
  });

  const world = worldFromBrief(input.brief);
  const core = coreFromModelOutput(result.data, world);
  const assembled = assembleScene({
    brief: input.brief,
    inputHash: input.inputHash,
    core,
    generatedTitle: result.data.title,
    modules: [],
    approvals: [],
  });
  if (!assembled.ok) {
    return {
      kind: "rejected",
      errors: assembled.findings,
      candidate: result.data,
      resourceLimited: false,
      model: result.model,
      usage: result.usage,
    };
  }

  const verdict = verifyBase(assembled.scene, input.brief);
  if (!verdict.ok) {
    return {
      kind: "rejected",
      errors: verdict.errors,
      candidate: result.data,
      resourceLimited: verdict.resourceLimited,
      model: result.model,
      usage: result.usage,
    };
  }

  return {
    kind: "committed",
    artifact: { core, title: result.data.title, output: result.data },
    hash: coreHash(core),
    model: result.model,
    usage: result.usage,
  };
}

/* ---------------------------------------------------------- module stage */

export type ModuleStageInput = {
  readonly brief: Brief;
  readonly inputHash: string;
  /** The clean foundation this module attaches to. */
  readonly core: CoreScene;
  readonly baseTitle: string;
  readonly slot: Slot;
  /** The frozen approval that authorises this stage. */
  readonly approval: ApprovedInfluence;
  /** The narrowed compiler-facing payload phase 3 builds from that approval. */
  readonly approvalPayload: ApprovedInfluencePayload;
  readonly repair: RepairContext | null;
};

export type ModuleStageOutcome = StageOutcome<{
  module: InfluenceModule;
  output: ModuleCompilationOutput;
  /** The candidate this module was verified in: the clean base plus itself. */
  scene: Scene;
}>;

/**
 * Compiles one influence module, independently of the other slot.
 *
 * Verification composes the clean base with **this module alone**. That is not
 * an optimisation: it is what makes the rejection findings — and therefore the
 * repair payload — structurally incapable of mentioning the other slot, since
 * the other module is not in the scene they were computed from.
 *
 * The mechanical witness is required here, while the one repair is still
 * available, rather than only at the end.
 */
export async function runModuleStage(
  input: ModuleStageInput,
  compiler: SceneCompiler,
): Promise<ModuleStageOutcome> {
  const payload = buildModuleCompilationPayload(
    {
      title: input.baseTitle,
      world: worldFromBrief(input.brief),
      core: input.core,
    },
    input.approvalPayload,
    input.brief.forbidden_wording,
  );
  const repairing = input.repair !== null;

  const result = await compiler.generate({
    schemaName: MODULE_SCHEMA_NAME,
    schema: ModuleCompilationOutputSchema,
    instructions: repairing
      ? `${moduleInstructions(input.slot)}\n\n${repairNote(input.repair?.errors ?? [])}`
      : moduleInstructions(input.slot),
    payload: repairing
      ? buildRepairPayload(payload, input.repair?.candidate ?? null, input.repair?.errors ?? [])
      : payload,
    maxOutputTokens: MODULE_MAX_OUTPUT_TOKENS,
  });

  const world = worldFromBrief(input.brief);
  const module = moduleFromModelOutput(
    result.data,
    input.slot,
    input.approval.approval_id,
    world,
  );
  const assembled = assembleScene({
    brief: input.brief,
    inputHash: input.inputHash,
    core: input.core,
    generatedTitle: input.baseTitle,
    modules: [module],
    approvals: [input.approval],
  });
  if (!assembled.ok) {
    return {
      kind: "rejected",
      errors: assembled.findings,
      candidate: result.data,
      resourceLimited: false,
      model: result.model,
      usage: result.usage,
    };
  }

  const verdict = verifyModule(
    assembled.scene,
    input.brief,
    input.slot,
    sceneApprovalAllowlist([input.approval]),
  );
  if (!verdict.ok) {
    return {
      kind: "rejected",
      errors: verdict.errors,
      candidate: result.data,
      resourceLimited: verdict.resourceLimited,
      model: result.model,
      usage: result.usage,
    };
  }

  return {
    kind: "committed",
    artifact: { module, output: result.data, scene: assembled.scene },
    hash: moduleHash(module),
    model: result.model,
    usage: result.usage,
  };
}
