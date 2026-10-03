import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PINNED_CHAT_MODEL } from "../../src/server/config";
import {
  estimateUsdCost,
  generateStructured,
  MAX_CONTEXT_CHARS,
  MAX_OUTPUT_CHARS,
  MODEL_ERROR_CODES,
  ModelError,
  type ResponsesClient,
  type StructuredRequest,
} from "../../src/server/model/openai";

/** The same tiny schema the opt-in smoke command uses. */
const ColourSchema = z.object({
  colour: z.string().min(1).max(20),
  letters: z.number().int().min(1).max(20),
});

function request(
  overrides: Partial<StructuredRequest<typeof ColourSchema>> = {},
): StructuredRequest<typeof ColourSchema> {
  return {
    schemaName: "colour_probe",
    schema: ColourSchema,
    instructions: "Reply with one primary colour and the number of letters in its name.",
    input: "Name one primary colour.",
    maxOutputTokens: 64,
    ...overrides,
  };
}

const USAGE = { input_tokens: 40, output_tokens: 12, total_tokens: 52 };

function clientReturning(response: unknown): ResponsesClient & { calls: number } {
  const stub = {
    calls: 0,
    responses: {
      parse: async (_body: Record<string, unknown>) => {
        stub.calls += 1;
        return response;
      },
    },
  };
  return stub;
}

function completed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_test",
    model: PINNED_CHAT_MODEL,
    status: "completed",
    output_parsed: { colour: "blue", letters: 4 },
    output_text: JSON.stringify({ colour: "blue", letters: 4 }),
    usage: USAGE,
    output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
    ...overrides,
  };
}

describe("generateStructured on a well-formed response", () => {
  it("returns the validated value, the reported model, and the reported usage", async () => {
    const client = clientReturning(completed());
    const result = await generateStructured(request(), { client });

    expect(result.data).toEqual({ colour: "blue", letters: 4 });
    expect(result.model).toBe(PINNED_CHAT_MODEL);
    expect(result.usage).toEqual(USAGE);
    expect(result.response_id).toBe("resp_test");
    expect(client.calls).toBe(1);
  });

  it("sends the pinned model, no stored state, and no conversation handle", async () => {
    const seen: Record<string, unknown>[] = [];
    const client: ResponsesClient = {
      responses: {
        parse: async (body) => {
          seen.push(body);
          return completed();
        },
      },
    };

    await generateStructured(request(), { client });

    const body = seen[0] ?? {};
    expect(body["model"]).toBe(PINNED_CHAT_MODEL);
    expect(body["store"]).toBe(false);
    expect(body["max_output_tokens"]).toBe(64);
    expect(Object.keys(body)).not.toContain("previous_response_id");
    expect(Object.keys(body)).not.toContain("conversation");
    expect(Object.keys(body)).not.toContain("tools");
  });

  it("reports a null usage rather than inventing token counts", async () => {
    const client = clientReturning(completed({ usage: null }));
    const result = await generateStructured(request(), { client });
    expect(result.usage).toBeNull();
  });

  it("re-validates with the authoritative contract even when the provider complied", async () => {
    // Structured Outputs constrained the shape, but the value is still wrong.
    const client = clientReturning(
      completed({
        output_parsed: { colour: "blue", letters: 400 },
        output_text: JSON.stringify({ colour: "blue", letters: 400 }),
      }),
    );

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
    );
  });

  it("falls back to parsing the returned text when no parsed value is present", async () => {
    const client = clientReturning(completed({ output_parsed: null }));
    const result = await generateStructured(request(), { client });
    expect(result.data).toEqual({ colour: "blue", letters: 4 });
  });
});

describe("generateStructured refuses every unusable outcome", () => {
  it("treats a refusal as a failed stage, not as partial output", async () => {
    const client = clientReturning(
      completed({
        output_parsed: null,
        output_text: null,
        output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help." }] }],
      }),
    );

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError &&
        error.code === MODEL_ERROR_CODES.MODEL_REFUSED &&
        error.attemptSpent,
    );
  });

  it("never parses a truncated response", async () => {
    const client = clientReturning(
      completed({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_parsed: null,
        output_text: '{"colour":"bl',
      }),
    );

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_TRUNCATED,
    );
  });

  it("rejects malformed JSON instead of guessing at it", async () => {
    const client = clientReturning(
      completed({ output_parsed: null, output_text: '{"colour": "blue", ' }),
    );

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
    );
  });

  it("rejects an empty response", async () => {
    const client = clientReturning(completed({ output_parsed: null, output_text: "   " }));

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
    );
  });

  it("rejects an unrecognisable response envelope", async () => {
    const client = clientReturning({ unexpected: true });

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_INVALID_OUTPUT,
    );
  });

  it("refuses output that came back from a different model", async () => {
    const client = clientReturning(completed({ model: "gpt-4o-mini" }));

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_MISMATCH,
    );
  });

  it("refuses output over the read cap", async () => {
    const client = clientReturning(
      completed({ output_parsed: null, output_text: "x".repeat(MAX_OUTPUT_CHARS + 1) }),
    );

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === MODEL_ERROR_CODES.MODEL_OVERSIZED,
    );
  });

  it("turns a transport failure into one spent attempt, never a hidden retry", async () => {
    const parse = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const client: ResponsesClient = { responses: { parse } };

    await expect(generateStructured(request(), { client })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError &&
        error.code === MODEL_ERROR_CODES.MODEL_TRANSPORT &&
        error.attemptSpent,
    );
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("refuses an over-cap request without contacting the provider at all", async () => {
    const parse = vi.fn(async () => completed());
    const client: ResponsesClient = { responses: { parse } };

    await expect(
      generateStructured(request({ input: "x".repeat(MAX_CONTEXT_CHARS + 1) }), { client }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError &&
        error.code === MODEL_ERROR_CODES.MODEL_REQUEST_TOO_LARGE &&
        !error.attemptSpent,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("never carries a provider header, request detail, or key into its message", async () => {
    const client: ResponsesClient = {
      responses: {
        parse: async () => {
          const error = new Error(
            "401 Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
          );
          error.name = "AuthenticationError";
          throw error;
        },
      },
    };

    try {
      await generateStructured(request(), { client });
      throw new Error("expected a model error");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      const message = (error as ModelError).message;
      expect(message).not.toContain("sk-proj-");
      expect(message).not.toContain("Incorrect API key");
      expect(message).toBe("MODEL_TRANSPORT: AuthenticationError");
    }
  });
});

describe("the pinned model and the cost estimate", () => {
  it("is the exact snapshot the specification names", () => {
    expect(PINNED_CHAT_MODEL).toBe("gpt-4o-mini-2024-07-18");
  });

  it("estimates cost from the published list price, labelled as arithmetic", () => {
    // 1M input tokens at $0.15 and 1M output tokens at $0.60.
    expect(
      estimateUsdCost({ input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 }),
    ).toBeCloseTo(0.15, 10);
    expect(
      estimateUsdCost({ input_tokens: 0, output_tokens: 1_000_000, total_tokens: 1_000_000 }),
    ).toBeCloseTo(0.6, 10);
    expect(estimateUsdCost(USAGE)).toBeCloseTo(40e-6 * 0.15 + 12e-6 * 0.6, 12);
  });
});
