/**
 * The one explicit, opt-in OpenAI Structured Outputs smoke call.
 *
 *   RUN_OPENAI_SMOKE=1 npm run smoke:openai
 *
 * It is never part of `npm test`, never part of `npm run build`, and never
 * runs during deployment. Without the guard it exits with instructions and
 * makes no request at all.
 *
 * One call. One tiny schema. Trivial, non-confidential content, because
 * OpenAI's default abuse-monitoring logs may retain request content for up to
 * 30 days (specification sections 8 and 10). It prints the model, the token
 * usage the API reported, and a list-price cost estimate clearly labelled as
 * arithmetic — never the key, and never anything confidential.
 */

import { z } from "zod";
import { ConfigError, openAiEnv, PINNED_CHAT_MODEL } from "../src/server/config";
import {
  estimateUsdCost,
  generateStructured,
  ModelError,
} from "../src/server/model/openai";

const GUARD = "RUN_OPENAI_SMOKE";

/** Deliberately tiny: two fields, both trivially checkable. */
const ProbeSchema = z.object({
  colour: z.string().min(1).max(20),
  letters: z.number().int().min(1).max(20),
});

function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Already-exported variables are fine; a missing .env is reported below.
  }
}

async function main(): Promise<number> {
  if (process.env[GUARD] !== "1") {
    console.log(
      [
        "smoke:openai did not run, and made no request.",
        "",
        "This command spends real tokens on the pinned model, so it is opt-in:",
        "",
        `  ${GUARD}=1 npm run smoke:openai`,
        "",
        "Run it once to establish phase 2 acceptance. Do not loop it.",
      ].join("\n"),
    );
    return 0;
  }

  loadEnvFile();

  let configured: { model: string };
  try {
    configured = openAiEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`smoke:openai FAILED — ${error.message}`);
      console.error("Set OPENAI_API_KEY in .env. Its value is never printed.");
      return 1;
    }
    throw error;
  }

  console.log("smoke:openai");
  console.log(`  pinned model      ${PINNED_CHAT_MODEL}`);
  console.log(`  configured model  ${configured.model}`);
  console.log("  schema            colour_probe { colour: string, letters: int }");
  console.log("  calls             1");
  console.log("");

  const startedAt = Date.now();
  try {
    const result = await generateStructured({
      schemaName: "colour_probe",
      schema: ProbeSchema,
      instructions:
        "You fill in a tiny fixed schema. Reply with one primary colour and the number of letters in the English name of that colour.",
      input: "Give one primary colour.",
      maxOutputTokens: 64,
    });
    const elapsedMs = Date.now() - startedAt;

    console.log(`  PASS  validated output   ${JSON.stringify(result.data)}`);
    console.log(`  PASS  model reported     ${result.model}`);
    console.log(`  PASS  zod validated      yes (${Object.keys(result.data).join(", ")})`);
    console.log(`        elapsed            ${elapsedMs} ms`);

    if (result.usage === null) {
      console.log("        usage              not returned by the API on this call");
    } else {
      console.log(`        input tokens       ${result.usage.input_tokens}`);
      console.log(`        output tokens      ${result.usage.output_tokens}`);
      console.log(`        total tokens       ${result.usage.total_tokens}`);
      const estimate = estimateUsdCost(result.usage);
      console.log(
        `        cost ESTIMATE      $${estimate.toFixed(8)} (list-price arithmetic on the tokens above, not a billed amount)`,
      );
    }
    if (result.response_id !== null) {
      console.log(`        response id        ${result.response_id}`);
    }
    console.log("");
    console.log("smoke:openai OK");
    return 0;
  } catch (error) {
    if (error instanceof ModelError) {
      console.error(`smoke:openai FAILED — ${error.code}`);
      console.error(`  ${error.message}`);
      console.error(
        `  attempt spent: ${error.attemptSpent ? "yes" : "no"}. The model stays pinned to ${PINNED_CHAT_MODEL}; no other model or provider is tried.`,
      );
      return 1;
    }
    console.error("smoke:openai FAILED — unexpected error");
    console.error(`  ${error instanceof Error ? error.name : "unknown"}`);
    return 1;
  }
}

// `process.exitCode` rather than `process.exit`, so the SDK's sockets close
// before the process does.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`smoke:openai FAILED — ${error instanceof Error ? error.name : "unknown"}`);
    process.exitCode = 1;
  },
);
