/**
 * Server-only configuration, read once from the process environment and
 * validated with the authoritative Zod contracts.
 *
 * Nothing in this module is importable from a client component: every value it
 * returns is derived from a secret or from a budget setting that the browser has
 * no business reading. The accessors are lazy on purpose, so that
 * `next build`, the static landing page, and `/example` never require a
 * configured database or model key (specification sections 10 and 12).
 */

import { z } from "zod";

/** The one pinned model snapshot. A different value is a configuration error, never a fallback. */
export const PINNED_CHAT_MODEL = "gpt-4o-mini-2024-07-18";

/** Published prices for the pinned snapshot, used only to label a cost estimate. */
export const PINNED_MODEL_PRICING_USD_PER_MTOK = {
  input: 0.15,
  output: 0.6,
} as const;

/**
 * Thrown when configuration is absent or malformed. The message names the
 * variable but never its value, and route handlers map it to a redacted
 * `PERSISTENCE_UNAVAILABLE` envelope rather than returning it verbatim.
 */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = "ConfigError";
    this.variables = variables;
  }
}

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function required(name: string): string {
  const value = read(name);
  if (value === undefined) {
    throw new ConfigError(`${name} is not configured`, [name]);
  }
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const parsed = z.coerce.number().int().min(min).max(max).safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`, [name]);
  }
  return parsed.data;
}

const SupabaseEnvSchema = z.strictObject({
  url: z.url().refine((value) => value.startsWith("https://"), {
    message: "must be an https URL",
  }),
  secretKey: z.string().min(20),
});

export type SupabaseEnv = z.infer<typeof SupabaseEnvSchema>;

/**
 * Server-side Supabase credentials. `SUPABASE_SECRET_KEY` is the secret server
 * key; it bypasses row-level security, which is exactly why every repository in
 * `src/server/db/` still scopes its queries by owner session id.
 *
 * `SUPABASE_ACCESS_TOKEN` is deliberately *not* read here. It is a CLI and
 * migration credential and must never reach the application runtime.
 */
export function supabaseEnv(): SupabaseEnv {
  const parsed = SupabaseEnvSchema.safeParse({
    url: required("SUPABASE_URL"),
    secretKey: required("SUPABASE_SECRET_KEY"),
  });
  if (!parsed.success) {
    throw new ConfigError("Supabase configuration is invalid", [
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
    ]);
  }
  return parsed.data;
}

export type OpenAiEnv = { apiKey: string; model: typeof PINNED_CHAT_MODEL };

/**
 * OpenAI credentials and the pinned model. A configured model other than
 * {@link PINNED_CHAT_MODEL} throws: the application never silently substitutes
 * another snapshot or another provider (specification section 8).
 */
export function openAiEnv(): OpenAiEnv {
  const apiKey = required("OPENAI_API_KEY");
  const model = read("OPENAI_CHAT_MODEL") ?? PINNED_CHAT_MODEL;
  if (model !== PINNED_CHAT_MODEL) {
    throw new ConfigError(
      `OPENAI_CHAT_MODEL must be pinned to ${PINNED_CHAT_MODEL}`,
      ["OPENAI_CHAT_MODEL"],
    );
  }
  return { apiKey, model };
}

/**
 * Application-level budget settings. These are application caps chosen by this
 * deployment; they are not a claim about the OpenAI account's own rate limits.
 * Each can only be read on the server, and each can be lowered by configuration.
 */
export type BudgetConfig = {
  /** Default global daily model-call cap from specification section 12. */
  readonly modelDailyCallCap: number;
  /** How long a reservation lease survives an abandoned request, in seconds. */
  readonly modelLeaseSeconds: number;
  /** Projects one anonymous session may create per rolling day. */
  readonly projectsPerSessionPerDay: number;
};

export const BUDGET_DEFAULTS = {
  modelDailyCallCap: 40,
  modelLeaseSeconds: 120,
  projectsPerSessionPerDay: 5,
} as const satisfies BudgetConfig;

export function budgetConfig(): BudgetConfig {
  return {
    modelDailyCallCap: integer(
      "MODEL_DAILY_CALL_CAP",
      BUDGET_DEFAULTS.modelDailyCallCap,
      0,
      BUDGET_DEFAULTS.modelDailyCallCap,
    ),
    modelLeaseSeconds: integer(
      "MODEL_LEASE_SECONDS",
      BUDGET_DEFAULTS.modelLeaseSeconds,
      5,
      600,
    ),
    projectsPerSessionPerDay: integer(
      "PROJECTS_PER_SESSION_PER_DAY",
      BUDGET_DEFAULTS.projectsPerSessionPerDay,
      1,
      BUDGET_DEFAULTS.projectsPerSessionPerDay,
    ),
  };
}
