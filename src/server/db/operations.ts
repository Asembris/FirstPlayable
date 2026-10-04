/**
 * Operation-stage reservation (specification sections 8 and 11).
 *
 * This is the persistence primitive, not a job queue and not a worker. One
 * reservation authorises at most one upstream attempt, and the authority to
 * make it is the `reserved` outcome — nothing else. A duplicate submit, a
 * double-clicked button, a browser retry, and a resumed page all arrive with
 * the same deterministic idempotency key and therefore cannot buy a second
 * provider call.
 *
 * Phase 2 deliberately calls no provider from any route. The primitive exists
 * so phase 4's bounded controller inherits a reservation discipline that was
 * verified before any paid call depended on it.
 */

import { createHash } from "node:crypto";
import { appErrors } from "../security/errors";
import type {
  DataGateway,
  OperationCompletion,
  OperationReservation,
  SessionRow,
} from "./gateway";

/** The stages the schema's check constraint already knows about. */
export const OPERATION_STAGES = [
  "artist_search",
  "references",
  "proposals",
  /** The persisted phase 4 compilation controller row. */
  "compile",
  "base",
  "module_discovery",
  "module_commitment",
  "ending_copy",
  "validate",
  "smoke",
] as const;

export type OperationStage = (typeof OPERATION_STAGES)[number];

/**
 * A lease long enough to outlive the 75-second operation-stage deadline of
 * specification section 8, and short enough that an abandoned request's lease
 * is recoverable in reasonable time.
 */
export const OPERATION_LEASE_SECONDS = 90;

/**
 * Two attempts per stage: one transport retry *or* one structural repair, never
 * both, and never a second hidden budget stacked on top (section 8).
 */
export const OPERATION_MAX_ATTEMPTS = 2;

export type StageIdentity = {
  projectId: string;
  stage: OperationStage;
  inputRevision: number;
  inputHash: string;
};

/**
 * Derived, not random. The same frozen inputs always produce the same key, so
 * a retry is recognised as a replay rather than treated as new work. The
 * project id makes it globally unique, which the schema's unique index requires.
 */
export function stageIdempotencyKey(identity: StageIdentity): string {
  const digest = createHash("sha256")
    .update(`${identity.stage}|${identity.inputRevision}|${identity.inputHash}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${identity.stage}:${identity.projectId}:${identity.inputRevision}:${digest}`;
}

export type ReserveStageOptions = {
  leaseSeconds?: number;
  maxAttempts?: number;
};

/**
 * Reserves one stage for this owner's project.
 *
 * The outcome is returned rather than thrown, because every one of them is a
 * legitimate state the controller must handle: `reserved` may proceed,
 * `settled` replays a committed result, `lease_held` means another request is
 * already working, `attempts_exhausted` stops the operation, and `not_found`
 * is the one answer a foreign or nonexistent project gets.
 */
export async function reserveStage(
  gateway: DataGateway,
  session: SessionRow,
  identity: StageIdentity,
  options: ReserveStageOptions = {},
): Promise<OperationReservation> {
  return gateway.reserveOperation({
    projectId: identity.projectId,
    ownerSessionId: session.id,
    stage: identity.stage,
    inputRevision: identity.inputRevision,
    inputHash: identity.inputHash,
    idempotencyKey: stageIdempotencyKey(identity),
    leaseSeconds: options.leaseSeconds ?? OPERATION_LEASE_SECONDS,
    maxAttempts: options.maxAttempts ?? OPERATION_MAX_ATTEMPTS,
  });
}

/** Records a terminal outcome. Settling an already-settled stage is a no-op. */
export async function settleStage(
  gateway: DataGateway,
  session: SessionRow,
  operationId: string,
  outcome:
    | { status: "succeeded"; result: unknown }
    | { status: "failed"; error: unknown },
): Promise<OperationCompletion> {
  return gateway.completeOperation({
    operationId,
    ownerSessionId: session.id,
    status: outcome.status,
    result: outcome.status === "succeeded" ? outcome.result : null,
    error: outcome.status === "failed" ? outcome.error : null,
  });
}

/**
 * Turns a non-`reserved` outcome into the application error a route returns.
 * A caller that wants to proceed must go through this, so "I could not get the
 * reservation" can never be mistaken for "I may call the provider".
 */
export function assertReserved(reservation: OperationReservation): void {
  switch (reservation.outcome) {
    case "reserved":
      return;
    case "not_found":
      throw appErrors.notFound();
    case "lease_held":
      throw appErrors.rateLimited(
        "This project already has a step in progress. Wait for it to finish.",
      );
    case "settled":
      throw appErrors.rateLimited("This step has already finished for these inputs.");
    case "attempts_exhausted":
      throw appErrors.rateLimited(
        "This step used its attempts. Edit or remove the input and try again.",
      );
  }
}
