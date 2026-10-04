/**
 * A deterministic {@link SceneCompiler} for the offline suite.
 *
 * It answers from a script, one entry per call, dispatching on the schema name
 * so a test states "the base comes back valid, then the Discovery module comes
 * back mechanically empty, then its repair is fine" without assembling a
 * provider response envelope.
 *
 * What it does **not** do is decide anything. It returns candidates; the Phase
 * 1 engine validates them. A script entry that returns an illegal module still
 * has to get past `validateScene`, and none of these tests mocks that.
 *
 * `requests` records every request it was given, so a test can assert what
 * would actually have been sent — the payload, the instructions, and nothing
 * else.
 */

import type { ZodType } from "zod";
import type {
  CompilerRequest,
  CompilerResult,
  SceneCompiler,
} from "../../../src/server/compile/compiler";
import {
  BASE_SCHEMA_NAME,
  MODULE_SCHEMA_NAME,
} from "../../../src/server/compile/compiler";
import { ModelError } from "../../../src/server/model/openai";
import type { ModelUsage } from "../../../src/server/model/openai";

export const PINNED_MODEL = "gpt-4o-mini-2024-07-18";

const DEFAULT_USAGE: ModelUsage = {
  input_tokens: 2_400,
  output_tokens: 900,
  total_tokens: 3_300,
};

/** One scripted answer. Exactly one of the three fields is used. */
export type CompilerScriptEntry =
  | { readonly output: unknown; readonly usage?: ModelUsage | null; readonly model?: string }
  /** A provider failure, with the stage-failure code the adapter would raise. */
  | { readonly fail: ModelError };

export type FakeCompiler = SceneCompiler & {
  /** Every request, in order: schema name, instructions, and payload. */
  readonly requests: { schemaName: string; instructions: string; payload: unknown }[];
  /** How many provider attempts were actually made. */
  readonly calls: () => number;
};

/**
 * A compiler that replays `base` answers and per-slot `module` answers.
 *
 * Each list is consumed in order. Running out is an explicit error rather than
 * a repeated last answer: a test that makes one more call than it scripted has
 * found a bug, not a missing fixture.
 */
export function fakeCompiler(script: {
  base?: readonly CompilerScriptEntry[];
  module?: readonly CompilerScriptEntry[];
}): FakeCompiler {
  const requests: { schemaName: string; instructions: string; payload: unknown }[] = [];
  const queues = new Map<string, CompilerScriptEntry[]>([
    [BASE_SCHEMA_NAME, [...(script.base ?? [])]],
    [MODULE_SCHEMA_NAME, [...(script.module ?? [])]],
  ]);
  let calls = 0;

  return {
    requests,
    calls: () => calls,
    generate: async <S extends ZodType>(
      request: CompilerRequest<S>,
    ): Promise<CompilerResult<unknown>> => {
      requests.push({
        schemaName: request.schemaName,
        instructions: request.instructions,
        payload: request.payload,
      });
      calls += 1;

      const queue = queues.get(request.schemaName);
      const entry = queue?.shift();
      if (entry === undefined) {
        throw new Error(
          `the fake compiler was asked for an unscripted ${request.schemaName} call`,
        );
      }
      if ("fail" in entry) throw entry.fail;

      // The authoritative schema still decides, exactly as it does in
      // production: a fake cannot hand a stage something the contract rejects.
      const parsed = request.schema.safeParse(entry.output);
      if (!parsed.success) {
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          `the authoritative contract rejected the scripted output at ${parsed.error.issues
            .map((issue) => issue.path.join("."))
            .join(",")}`,
          true,
        );
      }
      return {
        data: parsed.data,
        model: entry.model ?? PINNED_MODEL,
        usage: entry.usage === undefined ? DEFAULT_USAGE : entry.usage,
      };
    },
  } as FakeCompiler;
}

/* ------------------------------------------------------- failure shortcuts */

export const providerRefusal = (): CompilerScriptEntry => ({
  fail: new ModelError("MODEL_REFUSED", "the model declined", true),
});

export const providerTransportFailure = (): CompilerScriptEntry => ({
  fail: new ModelError("MODEL_TRANSPORT", "TypeError", true),
});

export const providerTruncation = (): CompilerScriptEntry => ({
  fail: new ModelError("MODEL_TRUNCATED", "status incomplete, reason max_output_tokens", true),
});

/** Structured output that the authoritative contract itself rejects. */
export const malformedOutput = (): CompilerScriptEntry => ({
  output: { title: "only a title, nothing else" },
});
