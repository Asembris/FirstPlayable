import { describe, expect, it } from "vitest";
import { SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import { createProject } from "../../src/server/db/projects";
import {
  assertReserved,
  OPERATION_LEASE_SECONDS,
  OPERATION_MAX_ATTEMPTS,
  reserveStage,
  settleStage,
  stageIdempotencyKey,
  type StageIdentity,
} from "../../src/server/db/operations";
import { establishOwnerSession } from "../../src/server/db/sessions";
import { OperationReservationSchema } from "../../src/server/db/gateway";
import { AppError, ERROR_CODES } from "../../src/server/security/errors";
import { MemoryGateway } from "./support/memory-gateway";

async function fixture(now = new Date("2026-03-01T12:00:00.000Z")) {
  const gateway = new MemoryGateway();
  gateway.setClock(() => now);
  const { session } = await establishOwnerSession(gateway, now);
  const project = await createProject(
    gateway,
    session,
    { brief: SECOND_COPY_BRIEF },
    { projectsPerDay: 5, now },
  );
  const identity: StageIdentity = {
    projectId: project.id,
    stage: "proposals",
    inputRevision: project.revision,
    inputHash: "a".repeat(64),
  };
  return { gateway, session, project, identity, now };
}

describe("stage idempotency key", () => {
  it("is derived from the frozen inputs, so a retry replays rather than duplicates", async () => {
    const { identity } = await fixture();
    expect(stageIdempotencyKey(identity)).toBe(stageIdempotencyKey({ ...identity }));
  });

  it("changes when the stage, the revision, or the input hash changes", async () => {
    const { identity } = await fixture();
    const base = stageIdempotencyKey(identity);
    expect(stageIdempotencyKey({ ...identity, stage: "base" })).not.toBe(base);
    expect(stageIdempotencyKey({ ...identity, inputRevision: 2 })).not.toBe(base);
    expect(stageIdempotencyKey({ ...identity, inputHash: "b".repeat(64) })).not.toBe(base);
  });

  it("stays inside the column's length constraint", async () => {
    const { identity } = await fixture();
    const key = stageIdempotencyKey(identity);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe("operation reservation", () => {
  it("reserves once and counts one attempt", async () => {
    const { gateway, session, identity } = await fixture();
    const reservation = await reserveStage(gateway, session, identity);

    expect(OperationReservationSchema.safeParse(reservation).success).toBe(true);
    expect(reservation.outcome).toBe("reserved");
    if (reservation.outcome !== "reserved") return;
    expect(reservation.created).toBe(true);
    expect(reservation.operation.attempts).toBe(1);
    expect(reservation.operation.max_attempts).toBe(OPERATION_MAX_ATTEMPTS);
    expect(gateway.operations.size).toBe(1);
  });

  it("refuses a duplicate reservation while the lease is held", async () => {
    const { gateway, session, identity } = await fixture();
    await reserveStage(gateway, session, identity);
    const duplicate = await reserveStage(gateway, session, identity);

    expect(duplicate.outcome).toBe("lease_held");
    expect(gateway.operations.size).toBe(1);
    expect(() => assertReserved(duplicate)).toThrowError(AppError);
  });

  it("creates at most one effective reservation under a burst of parallel submits", async () => {
    const { gateway, session, identity } = await fixture();

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => reserveStage(gateway, session, identity)),
    );

    const reserved = outcomes.filter((outcome) => outcome.outcome === "reserved");
    expect(reserved).toHaveLength(1);
    expect(gateway.operations.size).toBe(1);
    const only = [...gateway.operations.values()][0];
    expect(only?.attempts).toBe(1);
  });

  it("replays a settled stage's committed result without a new attempt", async () => {
    const { gateway, session, identity } = await fixture();
    const first = await reserveStage(gateway, session, identity);
    if (first.outcome !== "reserved") throw new Error("expected a reservation");

    await settleStage(gateway, session, first.operation.id, {
      status: "succeeded",
      result: { proposals: 2 },
    });

    const replay = await reserveStage(gateway, session, identity);
    expect(replay.outcome).toBe("settled");
    if (replay.outcome !== "settled") return;
    expect(replay.operation.attempts).toBe(1);
    expect(replay.operation.result).toEqual({ proposals: 2 });
  });

  it("recovers an expired lease exactly once, then stops at the ceiling", async () => {
    const start = new Date("2026-03-01T12:00:00.000Z");
    const { gateway, session, identity } = await fixture(start);

    const first = await reserveStage(gateway, session, identity);
    expect(first.outcome).toBe("reserved");

    // The request that held the lease never came back.
    const afterLease = new Date(start.getTime() + (OPERATION_LEASE_SECONDS + 1) * 1000);
    gateway.setClock(() => afterLease);

    const second = await reserveStage(gateway, session, identity);
    expect(second.outcome).toBe("reserved");
    if (second.outcome !== "reserved") return;
    expect(second.operation.attempts).toBe(2);
    expect(second.recovered_expired_lease).toBe(true);

    const afterSecondLease = new Date(afterLease.getTime() + (OPERATION_LEASE_SECONDS + 1) * 1000);
    gateway.setClock(() => afterSecondLease);

    const third = await reserveStage(gateway, session, identity);
    expect(third.outcome).toBe("attempts_exhausted");
    if (third.outcome !== "attempts_exhausted") return;
    expect(third.operation.status).toBe("expired");
    expect(third.operation.attempts).toBe(OPERATION_MAX_ATTEMPTS);

    // Deterministic afterwards: it stays exhausted however often it is retried.
    const fourth = await reserveStage(gateway, session, identity);
    expect(fourth.outcome).toBe("attempts_exhausted");
    expect(gateway.operations.size).toBe(1);
  });

  it("refuses a reservation on another owner's project, and does not say why", async () => {
    const { gateway, identity } = await fixture();
    const { session: intruder } = await establishOwnerSession(gateway);

    const reservation = await reserveStage(gateway, intruder, identity);
    expect(reservation.outcome).toBe("not_found");
    expect(gateway.operations.size).toBe(0);

    const nonexistent = await reserveStage(gateway, intruder, {
      ...identity,
      projectId: "00000000-0000-4000-8000-000000000000",
    });
    expect(nonexistent).toEqual(reservation);

    try {
      assertReserved(reservation);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });

  it("refuses to settle another owner's operation", async () => {
    const { gateway, session, identity } = await fixture();
    const first = await reserveStage(gateway, session, identity);
    if (first.outcome !== "reserved") throw new Error("expected a reservation");
    const { session: intruder } = await establishOwnerSession(gateway);

    const stolen = await settleStage(gateway, intruder, first.operation.id, {
      status: "succeeded",
      result: { tampered: true },
    });
    expect(stolen.outcome).toBe("not_found");

    const mine = await settleStage(gateway, session, first.operation.id, {
      status: "failed",
      error: { code: "MODEL_REFUSED" },
    });
    expect(mine.outcome).toBe("settled");
  });

  it("keeps the first committed outcome when settled twice", async () => {
    const { gateway, session, identity } = await fixture();
    const first = await reserveStage(gateway, session, identity);
    if (first.outcome !== "reserved") throw new Error("expected a reservation");

    await settleStage(gateway, session, first.operation.id, {
      status: "succeeded",
      result: { first: true },
    });
    const again = await settleStage(gateway, session, first.operation.id, {
      status: "failed",
      error: { second: true },
    });

    expect(again.outcome).toBe("already_settled");
    if (again.outcome !== "already_settled") return;
    expect(again.operation.status).toBe("succeeded");
    expect(again.operation.result).toEqual({ first: true });
  });

  it("never exposes the stored error object through the owner-facing summary", async () => {
    const { gateway, session, identity } = await fixture();
    const first = await reserveStage(gateway, session, identity);
    if (first.outcome !== "reserved") throw new Error("expected a reservation");

    const settled = await settleStage(gateway, session, first.operation.id, {
      status: "failed",
      error: { provider_header: "x-request-id: leaky" },
    });
    if (settled.outcome !== "settled") throw new Error("expected a settlement");

    expect(Object.keys(settled.operation)).not.toContain("error");
    expect(JSON.stringify(settled.operation)).not.toContain("leaky");
  });
});
