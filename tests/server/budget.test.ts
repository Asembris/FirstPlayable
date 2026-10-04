import { describe, expect, it } from "vitest";
import {
  BUDGET_DEFAULTS,
  type BudgetConfig,
  MODEL_COST_CAP_MICROS,
  PINNED_CHAT_MODEL,
} from "../../src/server/config";
import {
  assertGranted,
  budgetExhaustedMessage,
  cumulativeWindow,
  formatMicrosUsd,
  MODEL_BUDGET_GLOBAL_KEY,
  MODEL_BUDGET_SCOPE,
  MODEL_CALL_RESERVATION_MICROS,
  modelCallRecord,
  reconcileModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../../src/server/db/budgets";
import {
  BudgetReconciliationSchema,
  BudgetReservationSchema,
} from "../../src/server/db/gateway";
import { estimateUsdCost, estimateUsdCostMicros } from "../../src/server/model/openai";
import { AppError, ERROR_CODES } from "../../src/server/security/errors";
import { MemoryGateway } from "./support/memory-gateway";

const NOW = new Date("2026-03-01T09:30:00.000Z");

function config(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return { ...BUDGET_DEFAULTS, ...overrides };
}

function gatewayAt(now: Date): MemoryGateway {
  const gateway = new MemoryGateway();
  gateway.setClock(() => now);
  return gateway;
}

function bucketOf(gateway: MemoryGateway) {
  const { start } = cumulativeWindow();
  return gateway.buckets.get(`${MODEL_BUDGET_SCOPE}|${MODEL_BUDGET_GLOBAL_KEY}|${start}`);
}

/** Reserve an exact number of micro-dollars, so the arithmetic stays legible. */
function reserve(gateway: MemoryGateway, limits: BudgetConfig, costMicros: number) {
  return reserveModelCall(gateway, limits, { costMicros, now: NOW });
}

describe("the cost window", () => {
  it("is cumulative and does not roll over, so spend never resets", () => {
    const window = cumulativeWindow();
    expect(window.start).toBe("1970-01-01T00:00:00.000Z");
    expect(Date.parse(window.end)).toBeGreaterThan(Date.parse("2200-01-01T00:00:00.000Z"));
    // The same row whatever the clock says. There is no next window to wait for.
    expect(cumulativeWindow()).toEqual(window);
  });

  it("gates a scope whose counters hold micro-dollars, not calls", () => {
    expect(MODEL_BUDGET_SCOPE).toBe("model_cost_micros");
    // The retired daily call cap lived under its own scope; its rows stay
    // readable as history and cannot be mistaken for the live cap.
    expect(MODEL_BUDGET_SCOPE).not.toBe("model_calls");
  });
});

describe("the configured application cap", () => {
  it("is a hard cumulative $0.60, in micro-dollars", () => {
    expect(MODEL_COST_CAP_MICROS).toBe(600_000);
    expect(BUDGET_DEFAULTS.modelCostCapMicros).toBe(600_000);
    expect(formatMicrosUsd(MODEL_COST_CAP_MICROS)).toBe("$0.60");
  });

  it("no longer exposes a model-call cap of any kind", () => {
    expect(Object.keys(BUDGET_DEFAULTS)).not.toContain("modelDailyCallCap");
  });

  it("is used verbatim as the bucket's limit, and can be lowered", async () => {
    const gateway = gatewayAt(NOW);
    await reserve(gateway, config({ modelCostCapMicros: 300_000 }), 1_000);
    expect(bucketOf(gateway)?.call_limit).toBe(300_000);

    await reserve(gateway, config({ modelCostCapMicros: 100_000 }), 1_000);
    expect(bucketOf(gateway)?.call_limit).toBe(100_000);
  });

  it("reserves one call's conservative worst case by default", async () => {
    // 45,000 context characters at three characters per token priced as
    // uncached input, plus the largest stage's 6,000 output tokens.
    expect(MODEL_CALL_RESERVATION_MICROS).toBe(5_850);
    // The cap therefore admits a usable number of calls even before any of
    // them reconciles down to what it really cost.
    expect(Math.floor(MODEL_COST_CAP_MICROS / MODEL_CALL_RESERVATION_MICROS)).toBeGreaterThan(50);

    const gateway = gatewayAt(NOW);
    const reservation = await reserveModelCall(gateway, config(), { now: NOW });
    expect(reservation.granted).toBe(true);
    expect(bucketOf(gateway)?.reserved_calls).toBe(MODEL_CALL_RESERVATION_MICROS);
  });
});

describe("reservation", () => {
  it("succeeds under capacity and reports what is left", async () => {
    const gateway = gatewayAt(NOW);
    const reservation = await reserve(gateway, config({ modelCostCapMicros: 10_000 }), 4_000);

    expect(BudgetReservationSchema.safeParse(reservation).success).toBe(true);
    expect(reservation.granted).toBe(true);
    if (!reservation.granted) return;
    expect(reservation.remaining_calls).toBe(6_000);
    expect(reservation.lease_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(reservation.lease_expires_at)).toBeGreaterThan(NOW.getTime());
  });

  it("fails explicitly at the spend cap, with no fallback and no automatic increase", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 10_000 });

    await reserve(gateway, limits, 6_000);
    await reserve(gateway, limits, 4_000);
    const refused = await reserve(gateway, limits, 1);

    expect(refused.granted).toBe(false);
    if (refused.granted) return;
    expect(refused.reason).toBe("budget_exhausted");
    expect(refused.remaining_calls).toBe(0);

    try {
      assertGranted(refused);
      throw new Error("expected an exhausted-budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ERROR_CODES.BUDGET_EXHAUSTED);
      expect(appError.publicMessage).toContain("$0.01");
      expect(appError.publicMessage).toContain("does not reset");
      expect(appError.publicMessage).toContain("saved example");
      expect(appError.publicMessage).not.toMatch(/upgrade|top ?up|another model|fallback/i);
      // It must not promise a window reset, because there is no window.
      expect(appError.publicMessage).not.toMatch(/resets at|try again tomorrow/i);
    }
  });

  it("names the real $0.60 cap when that is the cap in force", () => {
    expect(budgetExhaustedMessage(MODEL_COST_CAP_MICROS)).toContain("$0.60");
  });

  it("does not let a parallel burst exceed the spend cap", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 25_000 });

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => reserve(gateway, limits, 5_000)),
    );

    const granted = outcomes.filter((outcome) => outcome.granted);
    expect(granted).toHaveLength(5);
    const bucket = bucketOf(gateway);
    expect(bucket?.reserved_calls).toBe(25_000);
    expect((bucket?.used_calls ?? 0) + (bucket?.reserved_calls ?? 0)).toBeLessThanOrEqual(25_000);
    expect(bucket?.active_leases).toHaveLength(5);

    // Each granted reservation has its own lease; none was handed out twice.
    expect(new Set(granted.map((outcome) => (outcome.granted ? outcome.lease_id : ""))).size).toBe(
      5,
    );
  });

  it("refuses a reservation that would not fit, without partial grants", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 8_000 });

    expect((await reserve(gateway, limits, 6_000)).granted).toBe(true);
    expect((await reserve(gateway, limits, 6_000)).granted).toBe(false);
    expect(bucketOf(gateway)?.reserved_calls).toBe(6_000);
  });

  it("stays exhausted a year later, because the cap is cumulative", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 5_000 });

    const spending = await reserve(gateway, limits, 5_000);
    expect(spending.granted).toBe(true);
    if (!spending.granted) return;
    // Reconciled into real spend, so there is nothing for a lease sweep to
    // give back: the money is gone, not merely held.
    await reconcileModelCall(gateway, spending.lease_id, { costMicros: 5_000, tokens: 1_000 });
    expect((await reserve(gateway, limits, 1)).granted).toBe(false);

    const nextYear = new Date("2027-03-01T09:30:00.000Z");
    gateway.setClock(() => nextYear);
    const stillRefused = await reserveModelCall(gateway, limits, {
      costMicros: 1,
      now: nextYear,
    });
    expect(stillRefused.granted).toBe(false);
    // Same row, a year on. The retired daily cap would have reset here.
    expect(bucketOf(gateway)?.used_calls).toBe(5_000);
  });

  it("sweeps an abandoned reservation back out once its lease expires", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 5_000, modelLeaseSeconds: 60 });

    const abandoned = await reserve(gateway, limits, 5_000);
    expect(abandoned.granted).toBe(true);
    expect((await reserve(gateway, limits, 5_000)).granted).toBe(false);

    const later = new Date(NOW.getTime() + 61_000);
    gateway.setClock(() => later);
    const recovered = await reserveModelCall(gateway, limits, { costMicros: 5_000, now: later });

    expect(recovered.granted).toBe(true);
    const bucket = bucketOf(gateway);
    expect(bucket?.reserved_calls).toBe(5_000);
    expect(bucket?.used_calls).toBe(0);
  });
});

describe("reconciliation", () => {
  it("replaces the conservative reservation with what the call really cost", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 100_000 });
    const reservation = await reserveModelCall(gateway, limits, {
      estimatedTokens: 4_000,
      now: NOW,
    });
    if (!reservation.granted) throw new Error("expected a reservation");
    expect(reservation.remaining_calls).toBe(100_000 - MODEL_CALL_RESERVATION_MICROS);

    const result = await reconcileModelCall(gateway, reservation.lease_id, {
      costMicros: 214,
      tokens: 137,
    });

    expect(BudgetReconciliationSchema.safeParse(result).success).toBe(true);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.used_calls).toBe(214);
    expect(result.used_tokens).toBe(137);
    expect(result.reserved_calls).toBe(0);
    expect(result.reserved_tokens).toBe(0);
    // The unspent part of the reservation came back.
    expect(result.remaining_calls).toBe(99_786);
  });

  it("releases an unsent call without recording spend", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 6_000 });
    const reservation = await reserve(gateway, limits, 6_000);
    if (!reservation.granted) throw new Error("expected a reservation");

    const released = await releaseModelCall(gateway, reservation.lease_id);
    expect(released.applied).toBe(true);
    if (!released.applied) return;
    expect(released.used_calls).toBe(0);
    expect(released.remaining_calls).toBe(6_000);

    // The capacity is genuinely back.
    expect((await reserve(gateway, limits, 6_000)).granted).toBe(true);
  });

  it("is a no-op the second time, and never drives a counter negative", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 20_000 });
    const reservation = await reserveModelCall(gateway, limits, {
      estimatedTokens: 1_000,
      now: NOW,
    });
    if (!reservation.granted) throw new Error("expected a reservation");

    await reconcileModelCall(gateway, reservation.lease_id, { costMicros: 90, tokens: 50 });
    const again = await reconcileModelCall(gateway, reservation.lease_id, {
      costMicros: 90,
      tokens: 50,
    });
    const unknown = await reconcileModelCall(gateway, "00000000-0000-4000-8000-000000000000", {
      costMicros: 999,
      tokens: 999,
    });

    expect(again.applied).toBe(false);
    expect(unknown.applied).toBe(false);

    const bucket = bucketOf(gateway);
    expect(bucket?.used_calls).toBe(90);
    expect(bucket?.used_tokens).toBe(50);
    expect(bucket?.reserved_calls).toBe(0);
    expect(bucket?.reserved_tokens).toBe(0);
    for (const counter of [
      bucket?.used_calls,
      bucket?.used_tokens,
      bucket?.reserved_calls,
      bucket?.reserved_tokens,
    ]) {
      expect(counter).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses to record negative usage at all", async () => {
    const gateway = gatewayAt(NOW);
    await expect(
      gateway.reconcileModelBudget({
        leaseId: "00000000-0000-4000-8000-000000000000",
        actualCalls: -1,
        actualTokens: 0,
      }),
    ).rejects.toBeInstanceOf(AppError);

    const reservation = await reserve(gateway, config({ modelCostCapMicros: 20_000 }), 6_000);
    if (!reservation.granted) throw new Error("expected a reservation");
    // The repository clamps a negative report rather than passing it on.
    const result = await reconcileModelCall(gateway, reservation.lease_id, {
      costMicros: -7,
      tokens: -500,
    });
    expect(result.applied).toBe(true);
    expect(bucketOf(gateway)?.used_tokens).toBe(0);
    expect(bucketOf(gateway)?.used_calls).toBe(0);
  });

  it("charges nothing for an attempt the provider reported no usage for", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelCostCapMicros: 20_000 });
    const reservation = await reserve(gateway, limits, 6_000);
    if (!reservation.granted) throw new Error("expected a reservation");

    // A refusal or a transport failure reports no tokens, so it costs nothing.
    // The spent *attempt* is still bounded, by the per-stage attempt ceiling
    // in the operations table rather than by this counter.
    const result = await reconcileModelCall(gateway, reservation.lease_id, {
      costMicros: estimateUsdCostMicros(null),
      tokens: 0,
    });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.used_calls).toBe(0);
    expect(result.remaining_calls).toBe(20_000);
  });
});

describe("the cost estimate", () => {
  const usage = (over: Partial<Parameters<typeof estimateUsdCost>[0]> = {}) => ({
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    ...over,
  });

  it("prices a million of each kind of token at the published list price", () => {
    expect(estimateUsdCost(usage({ input_tokens: 1_000_000 }))).toBeCloseTo(0.15, 12);
    expect(estimateUsdCost(usage({ output_tokens: 1_000_000 }))).toBeCloseTo(0.6, 12);
    expect(
      estimateUsdCost(usage({ input_tokens: 1_000_000, cached_input_tokens: 1_000_000 })),
    ).toBeCloseTo(0.075, 12);
  });

  it("treats cached tokens as a discounted part of the input, never an addition", () => {
    const half = estimateUsdCost(
      usage({ input_tokens: 1_000_000, cached_input_tokens: 500_000 }),
    );
    expect(half).toBeCloseTo(500_000e-6 * 0.15 + 500_000e-6 * 0.075, 12);
    // A cached count larger than the input cannot inflate or deflate the bill.
    expect(
      estimateUsdCost(usage({ input_tokens: 1_000, cached_input_tokens: 9_999 })),
    ).toBeCloseTo(estimateUsdCost(usage({ input_tokens: 1_000, cached_input_tokens: 1_000 })), 12);
  });

  it("rounds micro-dollars up, so the counter can only overstate spend", () => {
    expect(estimateUsdCostMicros(null)).toBe(0);
    // One output token costs $0.0000006, which is a fraction of a micro-dollar.
    expect(estimateUsdCostMicros(usage({ output_tokens: 1 }))).toBe(1);
    expect(estimateUsdCostMicros(usage({ input_tokens: 1_000_000 }))).toBe(150_000);
    const observed = usage({ input_tokens: 4_000, output_tokens: 1_200, total_tokens: 5_200 });
    expect(estimateUsdCostMicros(observed)).toBe(Math.ceil(4_000 * 0.15 + 1_200 * 0.6));
  });

  it("puts a realistic compilation well inside the cap", () => {
    // Four stages of roughly the shape the live runs report.
    const perCall = estimateUsdCostMicros(
      usage({ input_tokens: 3_000, output_tokens: 1_500, total_tokens: 4_500 }),
    );
    expect(perCall * 4).toBeLessThan(MODEL_COST_CAP_MICROS / 10);
  });
});

describe("the telemetry record", () => {
  it("carries the tokens, the estimate, the latency, the stage, and the attempt", () => {
    const record = modelCallRecord({
      stage: "module_discovery",
      attempt: 2,
      model: PINNED_CHAT_MODEL,
      usage: {
        input_tokens: 3_200,
        cached_input_tokens: 1_024,
        output_tokens: 900,
        total_tokens: 4_100,
      },
      costMicros: 867,
      latencyMs: 2_410.7,
    });

    expect(record).toEqual({
      stage: "module_discovery",
      attempt: 2,
      model: PINNED_CHAT_MODEL,
      input_tokens: 3_200,
      cached_input_tokens: 1_024,
      output_tokens: 900,
      total_tokens: 4_100,
      estimated_usd_micros: 867,
      latency_ms: 2_411,
      calls: 1,
    });
  });

  it("keeps the call count as telemetry and never invents a model or a token", () => {
    const record = modelCallRecord({
      stage: "base",
      attempt: 1,
      model: null,
      usage: null,
      costMicros: 0,
      latencyMs: -5,
    });

    expect(record.calls).toBe(1);
    expect(record.model).toBe("unreported");
    expect(record.total_tokens).toBe(0);
    expect(record.cached_input_tokens).toBe(0);
    expect(record.estimated_usd_micros).toBe(0);
    expect(record.latency_ms).toBe(0);
  });
});
