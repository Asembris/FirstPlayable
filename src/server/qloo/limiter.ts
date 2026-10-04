/**
 * The global Qloo launch policy and the local quota reserve
 * (specification sections 6 and 12).
 *
 * Two separate concerns, deliberately kept apart:
 *
 *   * **Pacing and concurrency** — at least 250 ms between launches and at
 *     most two in flight, globally. This is enforced by `reserve_qloo_launch`
 *     in Postgres under a row lock, *not* by an in-memory semaphore: a Vercel
 *     function's memory is not shared with the next invocation, so a
 *     per-process limiter would permit as many launches per second as there
 *     are warm instances.
 *   * **Quota** — a conservative local allowance per rolling window, with a
 *     reserve held back for judging. This reuses the already-verified
 *     `reserve_model_budget` / `reconcile_model_budget` primitives under its
 *     own `scope`, so it shares the table with model budgeting but never the
 *     row, the counter, or the lease list.
 *
 * The authoritative quota signal is the `x-month-ratelimit-remaining` header
 * the API actually returns. The local counter is a second, conservative guard
 * for the case where no header comes back; it is not a claim about the API's
 * own accounting, and nothing here assumes a calendar-month reset.
 *
 * No database transaction is open while a socket is. Each reservation is one
 * statement that commits before the caller's `fetch` begins, and the release
 * is a separate statement afterwards.
 */

import type { QlooConfig } from "../config";
import type {
  BudgetReservation,
  DataGateway,
  QlooLaunchReservation,
} from "../db/gateway";
import type { QuotaDiagnostics } from "@/domain/qloo";
import { appErrors } from "../security/errors";
import {
  QLOO_ERROR_CODES,
  QlooError,
  type QlooLaunchGuard,
  type QlooLaunchLease,
} from "./client";

/** The pacing row's scope and key. One row, globally, for the whole deployment. */
export const QLOO_LAUNCH_SCOPE = "qloo_launch";
export const QLOO_LAUNCH_KEY = "global";

/** The quota row's scope and key. A different scope means a different row. */
export const QLOO_QUOTA_SCOPE = "qloo_calls";
export const QLOO_QUOTA_KEY = "global";

/**
 * The pacing row does not roll over.
 *
 * `last_launch_at` has to be comparable across any two launches, so the
 * window is one fixed interval rather than a day or a month: a rolling window
 * would reset the gap at its boundary and let one launch through early.
 */
export const QLOO_LAUNCH_WINDOW = {
  start: "1970-01-01T00:00:00.000Z",
  end: "2270-01-01T00:00:00.000Z",
} as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A 30-day rolling quota window, anchored to the Unix epoch.
 *
 * Anchoring makes it deterministic, so every serverless instance computes the
 * same boundary without coordinating. It is explicitly **not** a claim that
 * the API resets on this schedule: the live header reported roughly 28.7 days
 * remaining on a window this application does not control, which is why the
 * returned header, not this counter, is the authority.
 */
export function qlooQuotaWindow(now: Date): { start: string; end: string } {
  const index = Math.floor(now.getTime() / THIRTY_DAYS_MS);
  const start = new Date(index * THIRTY_DAYS_MS);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + THIRTY_DAYS_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Launch pacing
// ---------------------------------------------------------------------------

/** How long the guard will keep waiting for a launch slot before giving up. */
export const LAUNCH_WAIT_BUDGET_MS = 9_000;

/** A hard ceiling on retries, so a pathological policy cannot spin. */
export const LAUNCH_MAX_ATTEMPTS = 32;

export type LaunchGuardDeps = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Observes every reservation outcome, for the smoke record and for tests. */
  onReservation?: (reservation: QlooLaunchReservation) => void;
};

/**
 * Builds the production launch guard over the database-backed policy.
 *
 * `acquire` waits exactly as long as the policy asks and no longer. A refusal
 * carries `retry_after_ms`, so this is a bounded wait on a known delay rather
 * than a poll loop with a guessed interval. Exhausting the wait budget is an
 * honest `QLOO_LAUNCH_UNAVAILABLE`, not a call made anyway.
 */
export function databaseLaunchGuard(
  gateway: DataGateway,
  config: QlooConfig,
  deps: LaunchGuardDeps = {},
): QlooLaunchGuard {
  const clock = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    acquire: async (label: string): Promise<QlooLaunchLease> => {
      const deadline = clock().getTime() + LAUNCH_WAIT_BUDGET_MS;
      let attempts = 0;
      let lastRefusal: Extract<QlooLaunchReservation, { granted: false }> | null = null;

      for (;;) {
        attempts += 1;
        const reservation = await gateway.reserveQlooLaunch({
          scope: QLOO_LAUNCH_SCOPE,
          bucketKey: QLOO_LAUNCH_KEY,
          windowStart: QLOO_LAUNCH_WINDOW.start,
          windowEnd: QLOO_LAUNCH_WINDOW.end,
          maxLeases: config.maxActiveLeases,
          minSpacingMs: config.launchSpacingMs,
          leaseSeconds: config.launchLeaseSeconds,
        });
        deps.onReservation?.(reservation);

        if (reservation.granted) {
          const leaseId = reservation.lease_id;
          let released = false;
          return {
            release: async () => {
              if (released) return;
              released = true;
              await gateway.releaseQlooLaunch(QLOO_LAUNCH_SCOPE, leaseId);
            },
          };
        }

        lastRefusal = reservation;
        const now = clock().getTime();
        if (attempts >= LAUNCH_MAX_ATTEMPTS || now + reservation.retry_after_ms > deadline) {
          throw new QlooError(
            QLOO_ERROR_CODES.QLOO_LAUNCH_UNAVAILABLE,
            `the global launch policy refused ${label} for ${lastRefusal.reason} after ${attempts} attempts`,
            0,
          );
        }
        // Small jitter, so two instances refused at the same instant do not
        // wake in lockstep and refuse each other again.
        await sleep(reservation.retry_after_ms + Math.floor(Math.random() * 40));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/**
 * The application cap for one window: the configured allowance minus the
 * judging reserve. Reaching it is an honest refusal, not a slower retrieval.
 */
export function qlooCallLimit(config: QlooConfig): number {
  return Math.max(0, config.monthlyCallAllowance - config.judgingReserveCalls);
}

export type ReserveQlooCallsOptions = {
  /** Worst-case upstream calls this operation may spend, retries included. */
  calls: number;
  now?: Date;
};

/**
 * Reserves the worst-case number of upstream calls an operation may spend,
 * then reconciles the actual count afterwards.
 *
 * Reserving the ceiling rather than the expectation is what keeps the reserve
 * honest: a retrieval that would only fit if every retry were free is not
 * admitted (specification section 12).
 */
export async function reserveQlooCalls(
  gateway: DataGateway,
  config: QlooConfig,
  options: ReserveQlooCallsOptions,
): Promise<BudgetReservation> {
  const window = qlooQuotaWindow(options.now ?? new Date());
  return gateway.reserveModelBudget({
    scope: QLOO_QUOTA_SCOPE,
    bucketKey: QLOO_QUOTA_KEY,
    windowStart: window.start,
    windowEnd: window.end,
    callLimit: qlooCallLimit(config),
    calls: options.calls,
    tokens: 0,
    leaseSeconds: Math.max(5, config.launchLeaseSeconds * 2),
  });
}

/** Writes back the calls actually spent, including the ones that failed. */
export async function reconcileQlooCalls(
  gateway: DataGateway,
  leaseId: string,
  actualCalls: number,
): Promise<void> {
  await gateway.reconcileModelBudget({
    leaseId,
    actualCalls: Math.max(0, Math.trunc(actualCalls)),
    actualTokens: 0,
  });
}

/** Turns a refused reservation into the honest exhausted-reserve error. */
export function assertQlooCallsGranted(
  reservation: BudgetReservation,
): Extract<BudgetReservation, { granted: true }> {
  if (reservation.granted) return reservation;
  throw appErrors.budgetExhausted(
    "This application is holding back its remaining Qloo calls as a reserve. " +
      "Retrieval is paused until the window resets. The saved example still plays.",
  );
}

/**
 * Whether the quota the API itself reported has fallen into the judging
 * reserve.
 *
 * This is the authoritative check, because it reads the provider's own
 * counter rather than this application's approximation of it. A `null`
 * remaining figure means the header was absent and this check abstains — it
 * never guesses a figure in order to look decisive.
 */
export function observedQuotaWithinReserve(
  quota: QuotaDiagnostics | null,
  config: QlooConfig,
): boolean {
  if (quota === null || quota.month_remaining === null) return false;
  return quota.month_remaining <= config.judgingReserveCalls;
}

/** The refusal to raise once {@link observedQuotaWithinReserve} is true. */
export function quotaReserveError(): never {
  throw appErrors.budgetExhausted(
    "The remaining upstream allowance is down to this application's judging reserve, " +
      "so fresh retrieval is paused. Already-retrieved references and the saved example still work.",
  );
}
