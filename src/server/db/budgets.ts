/**
 * The database-backed model budget (specification section 12).
 *
 * Three things matter here, and nothing else:
 *
 *   1. **Reservation is atomic.** The counter lives in one Postgres row and the
 *      decision happens under `select ... for update`. There is no in-memory
 *      counter pretending to be serverless-safe: a Vercel function's memory is
 *      not shared with the next invocation.
 *   2. **The cap is this application's own.** 40 model calls per day is the
 *      default from the specification, lowerable by configuration. It is *not*
 *      a claim about the OpenAI account's verified rate limit, and reaching it
 *      is an honest exhausted-budget state rather than a paid fallback.
 *   3. **Reserve before, reconcile after.** A call is reserved conservatively,
 *      then the usage the provider actually reported is written back. An
 *      abandoned request's reservation is swept out when its lease expires, so
 *      a crash costs capacity for one lease and not for the rest of the day.
 */

import type { BudgetConfig } from "../config";
import { appErrors } from "../security/errors";
import type { BudgetReconciliation, BudgetReservation, DataGateway } from "./gateway";

/** One global daily bucket for model calls. */
export const MODEL_BUDGET_SCOPE = "model_calls";
export const MODEL_BUDGET_GLOBAL_KEY = "global";

export type BudgetWindow = { start: string; end: string };

/** The UTC day containing `now`. Deterministic, and shared by every instance. */
export function dailyWindow(now: Date): BudgetWindow {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export type ReserveModelCallOptions = {
  /** How many provider calls this reservation claims. Usually 1. */
  calls?: number;
  /** A conservative upper bound on tokens, reconciled against reality after. */
  estimatedTokens?: number;
  bucketKey?: string;
  now?: Date;
};

/**
 * Reserves capacity for one or more model calls.
 *
 * Returns the reservation rather than throwing, because an exhausted budget is
 * a state the product shows honestly, not an internal error.
 */
export async function reserveModelCall(
  gateway: DataGateway,
  config: BudgetConfig,
  options: ReserveModelCallOptions = {},
): Promise<BudgetReservation> {
  const now = options.now ?? new Date();
  const window = dailyWindow(now);
  return gateway.reserveModelBudget({
    scope: MODEL_BUDGET_SCOPE,
    bucketKey: options.bucketKey ?? MODEL_BUDGET_GLOBAL_KEY,
    windowStart: window.start,
    windowEnd: window.end,
    callLimit: config.modelDailyCallCap,
    calls: options.calls ?? 1,
    tokens: options.estimatedTokens ?? 0,
    leaseSeconds: config.modelLeaseSeconds,
  });
}

/**
 * Records what the provider actually reported and releases the reservation.
 *
 * `calls` defaults to 1 because an attempt that reached the provider is spent
 * whether or not it returned something usable. Reconciling a lease twice, or
 * reconciling one the sweeper already reclaimed, is a no-op and cannot drive a
 * counter negative.
 */
export async function reconcileModelCall(
  gateway: DataGateway,
  leaseId: string,
  usage: { calls?: number; tokens: number },
): Promise<BudgetReconciliation> {
  return gateway.reconcileModelBudget({
    leaseId,
    actualCalls: usage.calls ?? 1,
    actualTokens: Math.max(0, Math.trunc(usage.tokens)),
  });
}

/**
 * Releases a reservation that never reached the provider, recording no usage.
 * Use it when a call is abandoned before it is sent.
 */
export async function releaseModelCall(
  gateway: DataGateway,
  leaseId: string,
): Promise<BudgetReconciliation> {
  return gateway.reconcileModelBudget({ leaseId, actualCalls: 0, actualTokens: 0 });
}

/**
 * Converts a refused reservation into the honest exhausted-budget error. The
 * message names the application cap and the window, and promises no automatic
 * top-up, no spend increase, and no fallback provider.
 */
export function assertGranted(
  reservation: BudgetReservation,
): Extract<BudgetReservation, { granted: true }> {
  if (reservation.granted) return reservation;
  throw appErrors.budgetExhausted(
    `This application's configured cap of ${reservation.call_limit} model calls for the current window is used up. It resets at ${reservation.window_end}. The saved example still plays.`,
  );
}
