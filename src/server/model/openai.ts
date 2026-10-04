/**
 * The one narrow model adapter (specification section 8).
 *
 * Server only. One provider, one pinned snapshot, one function. There is no
 * public arbitrary-prompt endpoint anywhere in this application: the only
 * callers are this repository's own code and the explicit opt-in smoke command.
 *
 * Four rules the specification is unambiguous about, each enforced here:
 *
 *   * **The model is pinned.** A configured model other than
 *     `gpt-4o-mini-2024-07-18` is a configuration error, and a response that
 *     came back from a different model is rejected. There is no fallback
 *     model, no fallback provider, and no silent substitution.
 *   * **The application owns the retry budget.** The SDK is constructed with
 *     `maxRetries: 0`, so a transport failure is one failed attempt counted by
 *     the caller rather than three invisible paid ones.
 *   * **Provider schema compliance is not validation.** Structured Outputs
 *     constrains the shape; the authoritative Zod schema still has to accept
 *     the value before any caller sees it.
 *   * **Each call is independent.** No conversation handle, no previous
 *     response id, no stored state is sent, so nothing can cross the approval
 *     boundary between stages.
 */

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z, type ZodType } from "zod";
import { openAiEnv, PINNED_CHAT_MODEL, PINNED_MODEL_PRICING_USD_PER_MTOK } from "../config";

/** Specification section 8: at most 45,000 characters of context per stage. */
export const MAX_CONTEXT_CHARS = 45_000;

/** Specification section 8: at most 32,000 characters of returned model text. */
export const MAX_OUTPUT_CHARS = 32_000;

/** Specification section 8: individual provider call timeout of 60 seconds. */
export const PROVIDER_TIMEOUT_MS = 60_000;

export const MODEL_ERROR_CODES = {
  /** The model declined. A refusal is a failed stage, never partial output. */
  MODEL_REFUSED: "MODEL_REFUSED",
  /** The response stopped early. Partial text is never parsed as a result. */
  MODEL_TRUNCATED: "MODEL_TRUNCATED",
  /** Nothing parseable came back, or Zod rejected what did. */
  MODEL_INVALID_OUTPUT: "MODEL_INVALID_OUTPUT",
  /** The returned text exceeded the configured read cap. */
  MODEL_OVERSIZED: "MODEL_OVERSIZED",
  /** A different model answered. Never accepted as a substitute. */
  MODEL_MISMATCH: "MODEL_MISMATCH",
  /** The request never produced a usable response. One spent attempt. */
  MODEL_TRANSPORT: "MODEL_TRANSPORT",
  /** The request itself was over the context cap and was not sent. */
  MODEL_REQUEST_TOO_LARGE: "MODEL_REQUEST_TOO_LARGE",
} as const;

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[keyof typeof MODEL_ERROR_CODES];

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  /** True when the provider was reached, so the call is spent either way. */
  readonly attemptSpent: boolean;

  constructor(code: ModelErrorCode, detail: string, attemptSpent: boolean) {
    super(`${code}: ${detail}`);
    this.name = "ModelError";
    this.code = code;
    this.attemptSpent = attemptSpent;
  }
}

export type ModelUsage = {
  input_tokens: number;
  /**
   * The part of `input_tokens` the provider reported as a cache hit. Zero when
   * the provider reported no detail block; it is never inferred, and it is
   * always a subset of `input_tokens`, not an addition to it.
   */
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type StructuredResult<T> = {
  data: T;
  /** The model identifier the provider reported, recorded with the result. */
  model: string;
  /** Null when the provider returned no usage block. Never invented. */
  usage: ModelUsage | null;
  response_id: string | null;
};

/**
 * Exactly the response fields this adapter reads, validated before use.
 *
 * Provider headers, rate-limit metadata, and anything else the SDK exposes are
 * deliberately absent: they are never read, so they can never be returned.
 */
const ResponseEnvelopeSchema = z.object({
  id: z.string().nullish(),
  model: z.string(),
  status: z.string().nullish(),
  incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
  output_text: z.string().nullish(),
  output_parsed: z.unknown(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().nullish(),
              refusal: z.string().nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().nullish() })
        .nullish(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .nullish(),
});

/**
 * The minimal surface this adapter uses, so a test can supply refusal,
 * truncation, malformed-output, and transport-failure responses without a real
 * API call or a key.
 */
export type ResponsesClient = {
  responses: { parse: (body: Record<string, unknown>) => Promise<unknown> };
};

export type StructuredRequest<S extends ZodType> = {
  /** Model-visible schema name, used by Structured Outputs. */
  schemaName: string;
  /** The authoritative Zod schema. It both shapes and validates the output. */
  schema: S;
  /** Fixed instructions. Never built from untrusted retrieved text verbatim. */
  instructions: string;
  /** The stage's data. Qloo and creator text are data here, not instructions. */
  input: string;
  maxOutputTokens: number;
};

export type GenerateStructuredDeps = {
  client?: ResponsesClient;
  /** Overridable only so a test can assert the pinned-model check itself. */
  expectedModel?: string;
};

/** Builds the real SDK client. The application, not the SDK, owns retries. */
export function openAiClient(): ResponsesClient {
  const env = openAiEnv();
  const client = new OpenAI({
    apiKey: env.apiKey,
    maxRetries: 0,
    timeout: PROVIDER_TIMEOUT_MS,
  });
  return {
    responses: {
      parse: (body) =>
        client.responses.parse(
          body as unknown as Parameters<typeof client.responses.parse>[0],
        ) as unknown as Promise<unknown>,
    },
  };
}

/**
 * One bounded Structured Outputs call.
 *
 * Returns the Zod-validated value, the model the provider reported, and the
 * usage it reported. Every other outcome — refusal, truncation, an unparseable
 * body, a foreign model, a transport failure — throws a {@link ModelError} with
 * a stable code, so a caller can neither mistake partial output for a result
 * nor silently retry into a second provider.
 */
export async function generateStructured<S extends ZodType>(
  request: StructuredRequest<S>,
  deps: GenerateStructuredDeps = {},
): Promise<StructuredResult<z.output<S>>> {
  const expectedModel = deps.expectedModel ?? PINNED_CHAT_MODEL;

  const contextChars = request.instructions.length + request.input.length;
  if (contextChars > MAX_CONTEXT_CHARS) {
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_REQUEST_TOO_LARGE,
      `context is ${contextChars} characters, over the ${MAX_CONTEXT_CHARS} cap`,
      false,
    );
  }

  const client = deps.client ?? openAiClient();

  let raw: unknown;
  try {
    raw = await client.responses.parse({
      model: expectedModel,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
      // No conversation handle, no previous_response_id, no stored state.
      store: false,
      text: { format: zodTextFormat(request.schema, request.schemaName) },
    });
  } catch (cause) {
    // The provider may or may not have been reached. Count the attempt as
    // spent rather than optimistically assuming it was free.
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_TRANSPORT,
      cause instanceof Error ? cause.name : "unknown transport failure",
      true,
    );
  }

  const envelope = ResponseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
      "the response envelope did not match the expected shape",
      true,
    );
  }
  const response = envelope.data;

  if (response.model !== expectedModel) {
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_MISMATCH,
      `expected ${expectedModel} and will not accept a substitute`,
      true,
    );
  }

  const usage: ModelUsage | null =
    response.usage === undefined || response.usage === null
      ? null
      : {
          input_tokens: response.usage.input_tokens,
          // Clamped to the reported input, so a surprising detail block can
          // never make the cached portion larger than the input itself.
          cached_input_tokens: Math.min(
            response.usage.input_tokens,
            response.usage.input_tokens_details?.cached_tokens ?? 0,
          ),
          output_tokens: response.usage.output_tokens,
          total_tokens: response.usage.total_tokens,
        };

  const refusal = (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => part.refusal)
    .find((value) => typeof value === "string" && value.length > 0);
  if (refusal !== undefined && refusal !== null) {
    throw new ModelError(MODEL_ERROR_CODES.MODEL_REFUSED, "the model declined", true);
  }

  if (response.status === "incomplete" || response.status === "failed") {
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_TRUNCATED,
      `status ${response.status}, reason ${response.incomplete_details?.reason ?? "unstated"}`,
      true,
    );
  }

  const text = response.output_text ?? null;
  if (text !== null && text.length > MAX_OUTPUT_CHARS) {
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_OVERSIZED,
      `returned ${text.length} characters, over the ${MAX_OUTPUT_CHARS} cap`,
      true,
    );
  }

  let candidate: unknown = response.output_parsed;
  if (candidate === undefined || candidate === null) {
    if (text === null || text.trim().length === 0) {
      throw new ModelError(
        MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
        "no structured output and no text",
        true,
      );
    }
    try {
      candidate = JSON.parse(text);
    } catch {
      // A truncated JSON body lands here. It is never parsed as a partial scene.
      throw new ModelError(
        MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
        "the returned text was not valid JSON",
        true,
      );
    }
  }

  // The provider constrained the shape. This is what decides it is acceptable.
  const validated = request.schema.safeParse(candidate);
  if (!validated.success) {
    throw new ModelError(
      MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
      `the authoritative contract rejected the output at ${validated.error.issues
        .map((issue) => issue.path.join("."))
        .join(",")}`,
      true,
    );
  }

  return {
    data: validated.data as z.output<S>,
    model: response.model,
    usage,
    response_id: response.id ?? null,
  };
}

/**
 * The one cost helper: provider-reported usage in, a US-dollar estimate out.
 *
 * It is arithmetic on the token counts the provider reported, priced at the
 * pinned snapshot's published list prices. It is *not* a billed amount read
 * back from the account, and it is not a general billing abstraction: there is
 * one provider and one model here, so there is one price table and one
 * function. Cached input is priced at the discounted cached rate, and the
 * uncached remainder at the full input rate.
 */
export function estimateUsdCost(usage: ModelUsage): number {
  const cached = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const uncached = usage.input_tokens - cached;
  const perMillion = (tokens: number, price: number) => (tokens / 1_000_000) * price;
  return (
    perMillion(uncached, PINNED_MODEL_PRICING_USD_PER_MTOK.input) +
    perMillion(cached, PINNED_MODEL_PRICING_USD_PER_MTOK.cached_input) +
    perMillion(usage.output_tokens, PINNED_MODEL_PRICING_USD_PER_MTOK.output)
  );
}

/**
 * The same estimate as an integer number of micro-dollars, rounded **up**.
 *
 * The cumulative cap is enforced against this integer, so it is deliberately
 * never rounded down: a call that cost a fraction of a micro-dollar still
 * costs one, and the counter can only ever overstate spend, never understate
 * it. Usage the provider did not report costs nothing here, which is why the
 * conservative reservation is taken before the call rather than after.
 */
export function estimateUsdCostMicros(usage: ModelUsage | null): number {
  if (usage === null) return 0;
  return Math.ceil(estimateUsdCost(usage) * 1_000_000);
}
