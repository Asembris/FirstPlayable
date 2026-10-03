import { describe, expect, it } from "vitest";
import { BUDGET_DEFAULTS, type BudgetConfig } from "../../src/server/config";
import {
  assertGranted,
  dailyWindow,
  MODEL_BUDGET_GLOBAL_KEY,
  MODEL_BUDGET_SCOPE,
  reconcileModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../../src/server/db/budgets";
import {
  BudgetReconciliationSchema,
  BudgetReservationSchema,
} from "../../src/server/db/gateway";
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
  const { start } = dailyWindow(NOW);
  return gateway.buckets.get(`${MODEL_BUDGET_SCOPE}|${MODEL_BUDGET_GLOBAL_KEY}|${start}`);
}

describe("the daily window", () => {
  it("is the UTC day, so every instance agrees on the same bucket", () => {
    expect(dailyWindow(new Date("2026-03-01T00:00:00.000Z"))).toEqual({
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
    });
    expect(dailyWindow(new Date("2026-03-01T23:59:59.999Z")).start).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(dailyWindow(new Date("2026-03-02T00:00:00.000Z")).start).toBe(
      "2026-03-02T00:00:00.000Z",
    );
  });
});

describe("the configured application cap", () => {
  it("defaults to the specification's 40 model calls a day", () => {
    expect(BUDGET_DEFAULTS.modelDailyCallCap).toBe(40);
  });

  it("is used verbatim as the bucket's limit, and can be lowered", async () => {
    const gateway = gatewayAt(NOW);
    await reserveModelCall(gateway, config({ modelDailyCallCap: 3 }), { now: NOW });
    expect(bucketOf(gateway)?.call_limit).toBe(3);

    await reserveModelCall(gateway, config({ modelDailyCallCap: 2 }), { now: NOW });
    expect(bucketOf(gateway)?.call_limit).toBe(2);
  });
});

describe("reservation", () => {
  it("succeeds under capacity and reports what is left", async () => {
    const gateway = gatewayAt(NOW);
    const reservation = await reserveModelCall(gateway, config({ modelDailyCallCap: 2 }), {
      now: NOW,
    });

    expect(BudgetReservationSchema.safeParse(reservation).success).toBe(true);
    expect(reservation.granted).toBe(true);
    if (!reservation.granted) return;
    expect(reservation.remaining_calls).toBe(1);
    expect(reservation.lease_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(reservation.lease_expires_at)).toBeGreaterThan(NOW.getTime());
  });

  it("fails explicitly at capacity, with no fallback and no automatic increase", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 2 });

    await reserveModelCall(gateway, limits, { now: NOW });
    await reserveModelCall(gateway, limits, { now: NOW });
    const refused = await reserveModelCall(gateway, limits, { now: NOW });

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
      expect(appError.publicMessage).toContain("configured cap");
      expect(appError.publicMessage).toContain("saved example");
      expect(appError.publicMessage).not.toMatch(/upgrade|top ?up|another model|fallback/i);
    }
  });

  it("does not let a parallel burst exceed the cap", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 5 });

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => reserveModelCall(gateway, limits, { now: NOW })),
    );

    const granted = outcomes.filter((outcome) => outcome.granted);
    expect(granted).toHaveLength(5);
    const bucket = bucketOf(gateway);
    expect(bucket?.reserved_calls).toBe(5);
    expect(bucket?.active_leases).toHaveLength(5);
    expect((bucket?.used_calls ?? 0) + (bucket?.reserved_calls ?? 0)).toBeLessThanOrEqual(5);

    // Each granted reservation has its own lease; none was handed out twice.
    expect(new Set(granted.map((outcome) => (outcome.granted ? outcome.lease_id : ""))).size).toBe(
      5,
    );
  });

  it("refuses a multi-call reservation that would not fit, without partial grants", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 4 });

    const first = await reserveModelCall(gateway, limits, { calls: 3, now: NOW });
    expect(first.granted).toBe(true);
    const second = await reserveModelCall(gateway, limits, { calls: 3, now: NOW });
    expect(second.granted).toBe(false);
    expect(bucketOf(gateway)?.reserved_calls).toBe(3);
  });

  it("keeps separate windows separate", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 1 });

    expect((await reserveModelCall(gateway, limits, { now: NOW })).granted).toBe(true);
    expect((await reserveModelCall(gateway, limits, { now: NOW })).granted).toBe(false);

    const tomorrow = new Date("2026-03-02T09:30:00.000Z");
    gateway.setClock(() => tomorrow);
    expect((await reserveModelCall(gateway, limits, { now: tomorrow })).granted).toBe(true);
  });

  it("sweeps an abandoned reservation back out once its lease expires", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 1, modelLeaseSeconds: 60 });

    const abandoned = await reserveModelCall(gateway, limits, { now: NOW });
    expect(abandoned.granted).toBe(true);
    expect((await reserveModelCall(gateway, limits, { now: NOW })).granted).toBe(false);

    const later = new Date(NOW.getTime() + 61_000);
    gateway.setClock(() => later);
    const recovered = await reserveModelCall(gateway, limits, { now: later });

    expect(recovered.granted).toBe(true);
    const bucket = bucketOf(gateway);
    expect(bucket?.reserved_calls).toBe(1);
    expect(bucket?.used_calls).toBe(0);
  });
});

describe("reconciliation", () => {
  it("moves a reservation into real usage with the reported tokens", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 10 });
    const reservation = await reserveModelCall(gateway, limits, {
      estimatedTokens: 4_000,
      now: NOW,
    });
    if (!reservation.granted) throw new Error("expected a reservation");

    const result = await reconcileModelCall(gateway, reservation.lease_id, { tokens: 137 });

    expect(BudgetReconciliationSchema.safeParse(result).success).toBe(true);
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.used_calls).toBe(1);
    expect(result.used_tokens).toBe(137);
    expect(result.reserved_calls).toBe(0);
    expect(result.reserved_tokens).toBe(0);
    expect(result.remaining_calls).toBe(9);
  });

  it("releases an unsent call without recording usage", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 1 });
    const reservation = await reserveModelCall(gateway, limits, { now: NOW });
    if (!reservation.granted) throw new Error("expected a reservation");

    const released = await releaseModelCall(gateway, reservation.lease_id);
    expect(released.applied).toBe(true);
    if (!released.applied) return;
    expect(released.used_calls).toBe(0);
    expect(released.remaining_calls).toBe(1);

    // The capacity is genuinely back.
    expect((await reserveModelCall(gateway, limits, { now: NOW })).granted).toBe(true);
  });

  it("is a no-op the second time, and never drives a counter negative", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 4 });
    const reservation = await reserveModelCall(gateway, limits, {
      estimatedTokens: 1_000,
      now: NOW,
    });
    if (!reservation.granted) throw new Error("expected a reservation");

    await reconcileModelCall(gateway, reservation.lease_id, { tokens: 50 });
    const again = await reconcileModelCall(gateway, reservation.lease_id, { tokens: 50 });
    const unknown = await reconcileModelCall(gateway, "00000000-0000-4000-8000-000000000000", {
      tokens: 999,
    });

    expect(again.applied).toBe(false);
    expect(unknown.applied).toBe(false);

    const bucket = bucketOf(gateway);
    expect(bucket?.used_calls).toBe(1);
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

    const reservation = await reserveModelCall(gateway, config({ modelDailyCallCap: 2 }), {
      now: NOW,
    });
    if (!reservation.granted) throw new Error("expected a reservation");
    // The repository clamps a negative token report rather than passing it on.
    const result = await reconcileModelCall(gateway, reservation.lease_id, { tokens: -500 });
    expect(result.applied).toBe(true);
    expect(bucketOf(gateway)?.used_tokens).toBe(0);
  });

  it("counts a spent attempt even when the provider returned nothing usable", async () => {
    const gateway = gatewayAt(NOW);
    const limits = config({ modelDailyCallCap: 2 });
    const reservation = await reserveModelCall(gateway, limits, { now: NOW });
    if (!reservation.granted) throw new Error("expected a reservation");

    // A refusal or a truncated response still consumed the call.
    const result = await reconcileModelCall(gateway, reservation.lease_id, { tokens: 0 });
    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(result.used_calls).toBe(1);
    expect(result.remaining_calls).toBe(1);
  });
});
