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

/**
 * Published list prices for the pinned snapshot, in US dollars per million
 * tokens. They exist to turn provider-reported usage into a labelled estimate;
 * they are not a billing figure read back from the account.
 *
 * `cached_input` is the discounted rate the provider charges for the portion of
 * the input it reports as a cache hit. Charging those tokens at the full input
 * rate would overstate spend, which matters now that the estimate is what the
 * cap is enforced against.
 */
export const PINNED_MODEL_PRICING_USD_PER_MTOK = {
  input: 0.15,
  cached_input: 0.075,
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

export type QlooEnv = { apiKey: string; baseUrl: string; host: string };

const QlooEnvSchema = z.strictObject({
  apiKey: z.string().min(8),
  baseUrl: z.url().refine((value) => value.startsWith("https://"), {
    message: "must be an https URL",
  }),
});

/**
 * Qloo credentials and base URL. Server only.
 *
 * `QLOO_API_KEY` travels in the `X-Api-Key` header of exactly three frozen
 * request shapes and nowhere else. No browser-exposed variant of it exists —
 * the publicly prefixed form is forbidden and asserted against by
 * `tests/server/secrets.test.ts` — and the browser reaches Qloo only through
 * this application's own owner-scoped routes (specification sections 6 and 12).
 *
 * `host` is derived here rather than at each call site, because it is part of
 * every capture's cache key: a configured base-URL change must not serve a
 * capture taken from another host.
 */
export function qlooEnv(): QlooEnv {
  const baseUrl = required("QLOO_API_BASE_URL").replace(/\/+$/u, "");
  const parsed = QlooEnvSchema.safeParse({ apiKey: required("QLOO_API_KEY"), baseUrl });
  if (!parsed.success) {
    throw new ConfigError("Qloo configuration is invalid", [
      "QLOO_API_KEY",
      "QLOO_API_BASE_URL",
    ]);
  }
  let host: string;
  try {
    host = new URL(parsed.data.baseUrl).host.toLowerCase();
  } catch {
    throw new ConfigError("QLOO_API_BASE_URL is not a parseable URL", ["QLOO_API_BASE_URL"]);
  }
  return { apiKey: parsed.data.apiKey, baseUrl: parsed.data.baseUrl, host };
}

/**
 * The application's own Qloo safety policy.
 *
 * Every number here is a conservative local decision, not a figure read out of
 * the API's documentation. The live recon on 4 October 2026 observed
 * `x-month-ratelimit-limit: 10000` and `x-second-ratelimit-limit: 5`; this
 * application paces itself well inside both and keeps a reserve for judging
 * (specification section 12).
 */
export type QlooConfig = {
  /** Local conservative allowance for one rolling window. Lowerable only. */
  readonly monthlyCallAllowance: number;
  /** Calls held back for judging once that many remain. */
  readonly judgingReserveCalls: number;
  /** Minimum milliseconds between two launches, globally. */
  readonly launchSpacingMs: number;
  /** Maximum simultaneously active request leases, globally. */
  readonly maxActiveLeases: number;
  /** How long a launch lease survives an abandoned request, in seconds. */
  readonly launchLeaseSeconds: number;
};

export const QLOO_DEFAULTS = {
  monthlyCallAllowance: 10_000,
  judgingReserveCalls: 500,
  launchSpacingMs: 250,
  maxActiveLeases: 2,
  launchLeaseSeconds: 40,
} as const satisfies QlooConfig;

export function qlooConfig(): QlooConfig {
  return {
    monthlyCallAllowance: integer(
      "QLOO_MONTHLY_CALL_ALLOWANCE",
      QLOO_DEFAULTS.monthlyCallAllowance,
      0,
      QLOO_DEFAULTS.monthlyCallAllowance,
    ),
    judgingReserveCalls: integer(
      "QLOO_JUDGING_RESERVE_CALLS",
      QLOO_DEFAULTS.judgingReserveCalls,
      0,
      5_000,
    ),
    // Only ever slower than the default, never faster.
    launchSpacingMs: integer(
      "QLOO_LAUNCH_SPACING_MS",
      QLOO_DEFAULTS.launchSpacingMs,
      QLOO_DEFAULTS.launchSpacingMs,
      5_000,
    ),
    maxActiveLeases: integer(
      "QLOO_MAX_ACTIVE_LEASES",
      QLOO_DEFAULTS.maxActiveLeases,
      1,
      QLOO_DEFAULTS.maxActiveLeases,
    ),
    launchLeaseSeconds: integer(
      "QLOO_LAUNCH_LEASE_SECONDS",
      QLOO_DEFAULTS.launchLeaseSeconds,
      5,
      300,
    ),
  };
}

/**
 * Application-level budget settings. These are application caps chosen by this
 * deployment; they are not a claim about the OpenAI account's own rate limits.
 * Each can only be read on the server, and each can be lowered by configuration.
 */
export type BudgetConfig = {
  /**
   * The hard cumulative OpenAI spend cap, in micro-dollars, measured against
   * the estimate computed from provider-reported usage. It is cumulative and
   * it does not reset: once it is reached, this application stops calling the
   * provider until the cap is deliberately raised in configuration.
   *
   * It replaces the earlier 40-calls-per-UTC-day cap, which blocked real work
   * long before any meaningful amount of money had been spent. Call count is
   * still recorded, but it no longer gates anything.
   */
  readonly modelCostCapMicros: number;
  /** How long a reservation lease survives an abandoned request, in seconds. */
  readonly modelLeaseSeconds: number;
  /** Projects one anonymous session may create per rolling day. */
  readonly projectsPerSessionPerDay: number;
};

/** $0.60, expressed in micro-dollars so the counter stays an exact integer. */
export const MODEL_COST_CAP_MICROS = 600_000;

export const BUDGET_DEFAULTS = {
  modelCostCapMicros: MODEL_COST_CAP_MICROS,
  modelLeaseSeconds: 120,
  projectsPerSessionPerDay: 5,
} as const satisfies BudgetConfig;

export function budgetConfig(): BudgetConfig {
  return {
    // Lowerable only. A configured value above the compiled-in cap is refused
    // rather than honoured, so configuration cannot widen the spend ceiling.
    modelCostCapMicros: integer(
      "MODEL_COST_CAP_MICROS",
      BUDGET_DEFAULTS.modelCostCapMicros,
      0,
      BUDGET_DEFAULTS.modelCostCapMicros,
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
