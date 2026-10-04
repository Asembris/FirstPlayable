import { describe, expect, it } from "vitest";
import { QLOO_DEFAULTS, type QlooConfig } from "../../src/server/config";
import {
  assertQlooCallsGranted,
  databaseLaunchGuard,
  LAUNCH_WAIT_BUDGET_MS,
  observedQuotaWithinReserve,
  QLOO_LAUNCH_SCOPE,
  QLOO_LAUNCH_WINDOW,
  QLOO_QUOTA_SCOPE,
  qlooCallLimit,
  qlooQuotaWindow,
  reconcileQlooCalls,
  reserveQlooCalls,
} from "../../src/server/qloo/limiter";
import { QLOO_ERROR_CODES, QlooError } from "../../src/server/qloo/client";
import { MODEL_BUDGET_SCOPE, reserveModelCall } from "../../src/server/db/budgets";
import { BUDGET_DEFAULTS } from "../../src/server/config";
import type { AppError } from "../../src/server/security/errors";
import { MemoryGateway } from "./support/memory-gateway";

const CONFIG: QlooConfig = { ...QLOO_DEFAULTS };

/** A controllable clock, so pacing is asserted rather than waited out. */
function clock(startIso = "2026-10-04T10:00:00.000Z") {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    /** A `sleep` that advances the clock instead of waiting, as the policy asks. */
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

function gatewayWith(time: ReturnType<typeof clock>): MemoryGateway {
  const gateway = new MemoryGateway();
  gateway.setClock(time.now);
  return gateway;
}

describe("the global launch policy", () => {
  it("uses one non-rolling pacing row, so a window boundary cannot reset the gap", () => {
    expect(Date.parse(QLOO_LAUNCH_WINDOW.end) - Date.parse(QLOO_LAUNCH_WINDOW.start))
      .toBeGreaterThan(100 * 365 * 24 * 60 * 60 * 1000);
  });

  it("spaces consecutive launches by at least the configured gap", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const guard = databaseLaunchGuard(gateway, CONFIG, { now: time.now, sleep: time.sleep });

    const first = await guard.acquire("artist_search");
    await first.release();
    const second = await guard.acquire("references_movie");
    await second.release();
    const third = await guard.acquire("references_videogame");
    await third.release();

    const times = gateway.qlooLaunches.map((launch) => Date.parse(launch.at));
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(CONFIG.launchSpacingMs);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(CONFIG.launchSpacingMs);
  });

  it("never grants more than the configured number of simultaneous leases", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const guard = databaseLaunchGuard(gateway, CONFIG, { now: time.now, sleep: time.sleep });

    // Hold the maximum, then prove the next acquisition is refused for
    // concurrency until one is released.
    const held = [];
    for (let i = 0; i < CONFIG.maxActiveLeases; i += 1) {
      held.push(await guard.acquire(`hold_${i}`));
    }
    const refusals: string[] = [];
    const observing = databaseLaunchGuard(gateway, CONFIG, {
      now: time.now,
      sleep: async () => undefined,
      onReservation: (reservation) => {
        if (!reservation.granted) refusals.push(reservation.reason);
      },
    });
    await expect(observing.acquire("blocked")).rejects.toThrow(
      expect.objectContaining({ code: QLOO_ERROR_CODES.QLOO_LAUNCH_UNAVAILABLE }) as Error,
    );
    expect(refusals).toContain("concurrency");

    for (const lease of held) await lease.release();
    time.advance(CONFIG.launchSpacingMs);
    const after = await guard.acquire("free_again");
    expect(after).toBeDefined();
    await after.release();
  });

  it("holds the cap under interleaved concurrent callers", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    // A guard that never waits, so every refusal surfaces immediately.
    const guard = databaseLaunchGuard(gateway, { ...CONFIG, launchSpacingMs: 0 }, {
      now: time.now,
      sleep: async () => undefined,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => guard.acquire(`racer_${index}`)),
    );
    const granted = results.filter((result) => result.status === "fulfilled");
    expect(granted.length).toBe(CONFIG.maxActiveLeases);
    expect(gateway.qlooLaunches).toHaveLength(CONFIG.maxActiveLeases);
    for (const result of granted) {
      if (result.status === "fulfilled") await result.value.release();
    }
  });

  it("recovers a lease whose request never released, once it expires", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const guard = databaseLaunchGuard(gateway, CONFIG, { now: time.now, sleep: time.sleep });

    // Acquire the maximum and abandon every one of them.
    for (let i = 0; i < CONFIG.maxActiveLeases; i += 1) await guard.acquire(`abandoned_${i}`);

    const blocked = databaseLaunchGuard(gateway, CONFIG, {
      now: time.now,
      sleep: async () => undefined,
    });
    await expect(blocked.acquire("still_blocked")).rejects.toThrow(QlooError);

    // Past the lease lifetime, the sweep reclaims them.
    time.advance(CONFIG.launchLeaseSeconds * 1000 + 1_000);
    const recovered = await guard.acquire("after_expiry");
    expect(recovered).toBeDefined();
    await recovered.release();
  });

  it("releases idempotently, so a double release cannot free someone else's slot", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const guard = databaseLaunchGuard(gateway, CONFIG, { now: time.now, sleep: time.sleep });
    const lease = await guard.acquire("once");
    await lease.release();
    await lease.release();
    const bucket = [...gateway.buckets.values()].find(
      (candidate) => candidate.scope === QLOO_LAUNCH_SCOPE,
    );
    expect(bucket?.active_leases).toEqual([]);
    expect(bucket?.reserved_calls).toBe(0);
  });

  it("gives up honestly rather than launching anyway", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    // A spacing longer than the whole wait budget can never be satisfied.
    const impossible: QlooConfig = { ...CONFIG, launchSpacingMs: LAUNCH_WAIT_BUDGET_MS + 5_000 };
    const guard = databaseLaunchGuard(gateway, impossible, {
      now: time.now,
      sleep: time.sleep,
    });
    const first = await guard.acquire("first");
    await first.release();
    const error = await guard.acquire("second").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(QlooError);
    expect((error as QlooError).code).toBe(QLOO_ERROR_CODES.QLOO_LAUNCH_UNAVAILABLE);
    // One launch happened. The refused one did not become a request.
    expect(gateway.qlooLaunches).toHaveLength(1);
  });

  it("keeps its pacing row out of the model budget's row", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const guard = databaseLaunchGuard(gateway, CONFIG, { now: time.now, sleep: time.sleep });
    const lease = await guard.acquire("artist_search");

    const model = await reserveModelCall(gateway, BUDGET_DEFAULTS, { now: time.now() });
    expect(model.granted).toBe(true);
    if (model.granted) {
      // The model budget sees its own cap, untouched by the Qloo lease.
      expect(model.call_limit).toBe(BUDGET_DEFAULTS.modelDailyCallCap);
      expect(model.reserved_calls).toBe(1);
    }

    const scopes = [...gateway.buckets.values()].map((bucket) => bucket.scope).sort();
    expect(scopes).toEqual([MODEL_BUDGET_SCOPE, QLOO_LAUNCH_SCOPE].sort());
    const launchBucket = [...gateway.buckets.values()].find((b) => b.scope === QLOO_LAUNCH_SCOPE);
    const modelBucket = [...gateway.buckets.values()].find((b) => b.scope === MODEL_BUDGET_SCOPE);
    expect(launchBucket?.last_launch_at).not.toBeNull();
    expect(modelBucket?.last_launch_at).toBeNull();
    await lease.release();
  });
});

describe("the local Qloo quota reserve", () => {
  it("holds back the judging reserve from the configured allowance", () => {
    expect(qlooCallLimit(CONFIG)).toBe(
      CONFIG.monthlyCallAllowance - CONFIG.judgingReserveCalls,
    );
    expect(qlooCallLimit({ ...CONFIG, judgingReserveCalls: 10_000 })).toBe(0);
  });

  it("uses a deterministic rolling window, not a calendar month", () => {
    const a = qlooQuotaWindow(new Date("2026-10-04T10:00:00.000Z"));
    const b = qlooQuotaWindow(new Date("2026-10-04T23:59:59.000Z"));
    expect(a).toEqual(b);
    const span = Date.parse(a.end) - Date.parse(a.start);
    expect(span).toBe(30 * 24 * 60 * 60 * 1000);
    // Not aligned to a month boundary, and not claiming to be.
    expect(a.start.endsWith("-01T00:00:00.000Z")).toBe(false);
  });

  it("reserves the worst case and reconciles what was actually spent", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const reservation = assertQlooCallsGranted(
      await reserveQlooCalls(gateway, CONFIG, { calls: 6, now: time.now() }),
    );
    expect(reservation.reserved_calls).toBe(6);
    await reconcileQlooCalls(gateway, reservation.lease_id, 3);
    const bucket = [...gateway.buckets.values()].find((b) => b.scope === QLOO_QUOTA_SCOPE);
    expect(bucket?.used_calls).toBe(3);
    expect(bucket?.reserved_calls).toBe(0);
  });

  it("refuses honestly once the local allowance is spent", async () => {
    const time = clock();
    const gateway = gatewayWith(time);
    const tiny: QlooConfig = { ...CONFIG, monthlyCallAllowance: 3, judgingReserveCalls: 0 };
    const first = assertQlooCallsGranted(
      await reserveQlooCalls(gateway, tiny, { calls: 3, now: time.now() }),
    );
    await reconcileQlooCalls(gateway, first.lease_id, 3);

    const refused = await reserveQlooCalls(gateway, tiny, { calls: 1, now: time.now() });
    expect(refused.granted).toBe(false);
    const error = (() => {
      try {
        assertQlooCallsGranted(refused);
        return null;
      } catch (cause) {
        return cause as AppError;
      }
    })();
    expect(error?.code).toBe("BUDGET_EXHAUSTED");
    // The creator-facing sentence states the reserve and promises no top-up.
    expect(error?.publicMessage).toMatch(/reserve/i);
    expect(error?.publicMessage).toMatch(/saved example/i);
  });

  it("treats the returned header as the authority, and abstains when it is absent", () => {
    expect(observedQuotaWithinReserve(null, CONFIG)).toBe(false);
    expect(
      observedQuotaWithinReserve(
        {
          month_limit: 10_000,
          month_remaining: null,
          month_reset_seconds: null,
          second_limit: 5,
          observed_at: "2026-10-04T10:00:00.000Z",
        },
        CONFIG,
      ),
    ).toBe(false);
    expect(
      observedQuotaWithinReserve(
        {
          month_limit: 10_000,
          month_remaining: CONFIG.judgingReserveCalls,
          month_reset_seconds: 1,
          second_limit: 5,
          observed_at: "2026-10-04T10:00:00.000Z",
        },
        CONFIG,
      ),
    ).toBe(true);
    expect(
      observedQuotaWithinReserve(
        {
          month_limit: 10_000,
          month_remaining: CONFIG.judgingReserveCalls + 1,
          month_reset_seconds: 1,
          second_limit: 5,
          observed_at: "2026-10-04T10:00:00.000Z",
        },
        CONFIG,
      ),
    ).toBe(false);
  });
});
