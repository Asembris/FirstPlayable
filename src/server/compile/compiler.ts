/**
 * The narrow injectable compiler boundary (specification section 8).
 *
 * One method. It takes a schema name, the authoritative Zod schema, fixed
 * instructions, and a payload value, and it returns the validated output with
 * the model the provider reported and the usage it reported. There is no
 * conversation handle, no previous response id, no tool list, no temperature,
 * and no model parameter: the pinned snapshot lives in configuration and the
 * adapter refuses a substitute.
 *
 * Why a boundary at all, when `generateStructured` already accepts an injected
 * client: a test that needs "a refusal", "a malformed body", or "a candidate
 * that fails the engine" should not have to assemble a provider response
 * envelope to say so. The offline suite therefore drives compilation stages
 * through a deterministic {@link SceneCompiler}, and a separate set of tests
 * drives {@link openAiCompiler} over a scripted transport so the real
 * adapter's own refusal, truncation, oversize, pinned-model, and Zod checks
 * stay covered.
 *
 * What a fake never replaces is the validator. A fake produces candidates; the
 * Phase 1 engine decides whether they are acceptable.
 */

import type { z, ZodType } from "zod";
import {
  generateStructured,
  type GenerateStructuredDeps,
  type ModelUsage,
} from "../model/openai";
import { serializeCompilerPayload } from "./payloads";

/** Bounded output budgets. A base is larger than a module, and both are small. */
export const BASE_MAX_OUTPUT_TOKENS = 6_000;
export const MODULE_MAX_OUTPUT_TOKENS = 3_000;
/** One ending's prose and nothing else, so the smallest budget of the three. */
export const ENDING_COPY_MAX_OUTPUT_TOKENS = 1_200;

/** The schema names the two stages use, so a fake can dispatch on them. */
export const BASE_SCHEMA_NAME = "firstplayable_scene_base";
export const MODULE_SCHEMA_NAME = "firstplayable_scene_module";
export const ENDING_COPY_SCHEMA_NAME = "firstplayable_ending_copy";

export type CompilerRequest<S extends ZodType> = {
  readonly schemaName: string;
  /** The authoritative contract. It both shapes and validates the output. */
  readonly schema: S;
  /** Fixed instructions, built from constants. Never from retrieved text. */
  readonly instructions: string;
  /** The stage's isolated payload. Qloo and creator text are data here. */
  readonly payload: unknown;
  readonly maxOutputTokens: number;
};

export type CompilerResult<T> = {
  readonly data: T;
  /** What the provider reported. Recorded with the version, never invented. */
  readonly model: string;
  readonly usage: ModelUsage | null;
};

export type SceneCompiler = {
  generate<S extends ZodType>(
    request: CompilerRequest<S>,
  ): Promise<CompilerResult<z.output<S>>>;
};

/**
 * The production compiler: the one pinned OpenAI adapter.
 *
 * It serializes the payload here rather than at each call site, so every stage
 * sends the same deterministic JSON the payload tests inspected.
 */
export function openAiCompiler(deps: GenerateStructuredDeps = {}): SceneCompiler {
  return {
    generate: async <S extends ZodType>(request: CompilerRequest<S>) => {
      const result = await generateStructured(
        {
          schemaName: request.schemaName,
          schema: request.schema,
          instructions: request.instructions,
          input: serializeCompilerPayload(request.payload),
          maxOutputTokens: request.maxOutputTokens,
        },
        deps,
      );
      return { data: result.data, model: result.model, usage: result.usage };
    },
  };
}
