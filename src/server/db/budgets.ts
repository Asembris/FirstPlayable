/**
 * The database-backed OpenAI spend budget (specification section 12).
 *
 * Four things matter here, and nothing else:
 *
 *   1. **The cap is money, not calls.** A hard cumulative cap of
 *      {@link MODEL_COST_CAP_MICROS} micro-dollars — $0.60 — is the one thing
 *      that blocks a provider call. It replaces the earlier 40-calls-per-UTC-day
 *      cap, which refused real work while the account had spent a few cents.
 *      Call count is still recorded as telemetry; it gates nothing.
 *   2. **Reservation is atomic.** The counter lives in one Postgres row and the
 *      decision happens under `select ... for update`. There is no in-memory
 *      counter pretending to be serverless-safe: a Vercel function's memory is
 *      not shared with the next invocation.
 *   3. **The cap is this application's own.** It is *not* a claim about the
 *      OpenAI account's limits or its real billed total, and reaching it is an
 *      honest exhausted-budget state rather than a paid fallback.
 *   4. **Reserve before, reconcile after.** A conservative upper bound on cost
 *      is reserved before the call, then the estimate computed from the usage
 *      the provider actually reported is written back. An abandoned request's
 *      reservation is swept out when its lease expires, so a crash costs
 *      capacity for one lease rather than permanently.
 *
 * It reuses the existing `budget_buckets` primitive unchanged — no new table,
 * no new function, no migration. The primitive gates one integer dimension
 * against one integer limit; this module supplies micro-dollars for that
 * dimension. The `tokens` dimension, which the primitive tracks but does not
 * gate, carries total tokens. See {@link MODEL_BUDGET_SCOPE} for why the
 * column names read as they do.
 */

import {
  type BudgetConfig,
  MODEL_COST_CAP_MICROS,
  PINNED_MODEL_PRICING_USD_PER_MTOK,
} from "../config";
import { BASE_MAX_OUTPUT_TOKENS } from "../compile/compiler";
import { MAX_CONTEXT_CHARS, type ModelUsage } from "../model/openai";
import { appErrors } from "../security/errors";
import type { BudgetReconciliation, BudgetReservation, DataGateway } from "./gateway";

export { MODEL_COST_CAP_MICROS };

/**
 * One cumulative bucket for OpenAI spend.
 *
 * The scope name says what the gated counter holds, because the primitive's
 * columns are named `call_limit`, `used_calls`, and `reserved_calls` and this
 * scope stores **micro-dollars** in them, not calls. Reading the row without
 * knowing that would badly misread the numbers. The scope is deliberately
 * distinct from the retired `model_calls` scope, so the old daily rows stay
 * readable as history and cannot be mistaken for the live cap.
 */
export const MODEL_BUDGET_SCOPE = "model_cost_micros";
export const MODEL_BUDGET_GLOBAL_KEY = "global";

export type BudgetWindow = { start: string; end: string };

/**
 * The single window the cumulative cap lives in.
 *
 * The primitive is windowed, so a cumulative cap is expressed as one window
 * wide enough never to roll over, exactly as the Qloo launch limiter already
 * does. There is no reset: spend accumulates in this one row for the lifetime
 * of the deployment.
 */
export const CUMULATIVE_WINDOW: BudgetWindow = {
  start: "1970-01-01T00:00:00.000Z",
  end: "2270-01-01T00:00:00.000Z",
};

export function cumulativeWindow(): BudgetWindow {
  return CUMULATIVE_WINDOW;
}

/**
 * The conservative cost reserved before a call, in micro-dollars.
 *
 * It is the arithmetic worst case of one call under this application's own
 * caps, not a guess: the whole context cap charged as uncached input at three
 * characters per token, plus the largest stage's full output allowance.
 * Observed calls reconcile to a small fraction of it, so the reservation only
 * ever makes the cap bind sooner than real spend would.
 */
export const MODEL_CALL_RESERVATION_MICROS = Math.ceil(
  (MAX_CONTEXT_CHARS / 3) * PINNED_MODEL_PRICING_USD_PER_MTOK.input +
    BASE_MAX_OUTPUT_TOKENS * PINNED_MODEL_PRICING_USD_PER_MTOK.output,
);

export type ReserveModelCallOptions = {
  /**
   * A conservative upper bound on this call's cost, in micro-dollars.
   * Defaults to {@link MODEL_CALL_RESERVATION_MICROS}; raise it only for a
   * caller that really does claim more than one call's worth.
   */
  costMicros?: number;
  /** A conservative upper bound on tokens, reconciled against reality after. */
  estimatedTokens?: number;
  bucketKey?: string;
  now?: Date;
};

/**
 * Reserves spending capacity for one model call.
 *
 * Returns the reservation rather than throwing, because an exhausted budget is
 * a state the product shows honestly, not an internal error.
 */
export async function reserveModelCall(
  gateway: DataGateway,
  config: BudgetConfig,
  options: ReserveModelCallOptions = {},
): Promise<BudgetReservation> {
  const window = cumulativeWindow();
  return gateway.reserveModelBudget({
    scope: MODEL_BUDGET_SCOPE,
    bucketKey: options.bucketKey ?? MODEL_BUDGET_GLOBAL_KEY,
    windowStart: window.start,
    windowEnd: window.end,
    callLimit: config.modelCostCapMicros,
    // Micro-dollars, in the primitive's one gated integer dimension.
    calls: Math.max(1, Math.trunc(options.costMicros ?? MODEL_CALL_RESERVATION_MICROS)),
    tokens: options.estimatedTokens ?? 0,
    leaseSeconds: config.modelLeaseSeconds,
  });
}

/**
 * Records what the call actually cost and releases the reservation.
 *
 * `costMicros` is the estimate computed from the usage the provider reported.
 * A call that reached the provider but returned nothing usable still costs
 * whatever it reported, and costs nothing when it reported nothing — the
 * conservative reservation is what covers that gap while the call is in
 * flight. Reconciling a lease twice, or reconciling one the sweeper already
 * reclaimed, is a no-op and cannot drive a counter negative.
 */
export async function reconcileModelCall(
  gateway: DataGateway,
  leaseId: string,
  usage: { costMicros: number; tokens: number },
): Promise<BudgetReconciliation> {
  return gateway.reconcileModelBudget({
    leaseId,
    actualCalls: Math.max(0, Math.trunc(usage.costMicros)),
    actualTokens: Math.max(0, Math.trunc(usage.tokens)),
  });
}

/**
 * Releases a reservation that never reached the provider, recording no spend.
 * Use it when a call is abandoned before it is sent.
 */
export async function releaseModelCall(
  gateway: DataGateway,
  leaseId: string,
): Promise<BudgetReconciliation> {
  return gateway.reconcileModelBudget({ leaseId, actualCalls: 0, actualTokens: 0 });
}

/** Micro-dollars as a dollar string, for the one message that names the cap. */
export function formatMicrosUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * The one honest exhausted-budget message.
 *
 * It names this application's own cumulative cap and says plainly that it does
 * not reset, because it does not: there is no window to wait for. It promises
 * no automatic top-up, no spend increase, and no fallback provider.
 */
export function budgetExhaustedMessage(callLimitMicros: number): string {
  return (
    `This application's own cumulative OpenAI spend cap of ${formatMicrosUsd(callLimitMicros)} ` +
    "is used up, so no further model call will be made. It does not reset. " +
    "The saved example still plays."
  );
}

/** Converts a refused reservation into the honest exhausted-budget error. */
export function assertGranted(
  reservation: BudgetReservation,
): Extract<BudgetReservation, { granted: true }> {
  if (reservation.granted) return reservation;
  throw appErrors.budgetExhausted(budgetExhaustedMessage(reservation.call_limit));
}

/**
 * One model call's telemetry record: what it cost, how long it took, and which
 * stage attempt it belonged to.
 *
 * It is infrastructure, not a product surface. Nothing renders it, nothing
 * aggregates it into a dashboard, and it carries no prompt text, no scene
 * content, and no creator writing — only counters the provider reported plus
 * stage labels this application already knows.
 */
export type ModelCallRecord = {
  readonly stage: string;
  readonly attempt: number;
  readonly model: string;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly estimated_usd_micros: number;
  readonly latency_ms: number;
  /** Always 1. Recorded because call count is now telemetry, not a limit. */
  readonly calls: 1;
};

/**
 * The one sink for a telemetry record: a single structured line in the server
 * log, which on Vercel is the function log and nowhere else.
 *
 * This is deliberately not a metrics pipeline, not a database table, and not
 * anything the browser can read. The durable number that matters — cumulative
 * spend — already lives in the budget bucket; this line is what makes one
 * call's share of it attributable to a stage and an attempt.
 */
export function recordModelCall(record: ModelCallRecord): void {
  console.info(`[model-call] ${JSON.stringify(record)}`);
}

export function modelCallRecord(input: {
  stage: string;
  attempt: number;
  model: string | null;
  usage: ModelUsage | null;
  costMicros: number;
  latencyMs: number;
}): ModelCallRecord {
  return {
    stage: input.stage,
    attempt: input.attempt,
    // Never invented: a call that reported no model is labelled as such.
    model: input.model ?? "unreported",
    input_tokens: input.usage?.input_tokens ?? 0,
    cached_input_tokens: input.usage?.cached_input_tokens ?? 0,
    output_tokens: input.usage?.output_tokens ?? 0,
    total_tokens: input.usage?.total_tokens ?? 0,
    estimated_usd_micros: Math.max(0, Math.trunc(input.costMicros)),
    latency_ms: Math.max(0, Math.round(input.latencyMs)),
    calls: 1,
  };
}
