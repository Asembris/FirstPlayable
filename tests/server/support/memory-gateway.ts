/**
 * An in-memory {@link DataGateway} that re-implements the semantics of the
 * committed SQL in `supabase/migrations/`.
 *
 * What this *is* for: exercising the real repositories, the real route
 * handlers, the real session and origin checks, and the real budget accounting
 * without the unit suite needing network access.
 *
 * What this is **not**: evidence that Postgres is atomic. The cross-instance
 * guarantee comes from `select ... for update` in the migration and is verified
 * against the real database by `npm run smoke:supabase`. Each reserve here
 * yields once before entering its critical section, which models the row lock
 * and catches double-counting, but a single-threaded fake cannot prove a race
 * is impossible.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  AppendDecisionInput,
  BudgetReconciliation,
  BudgetReservation,
  CompleteOperationInput,
  DataGateway,
  DecisionAppend,
  InsertProjectInput,
  InsertSessionInput,
  OperationCompletion,
  OperationReservation,
  OperationSummary,
  ProjectRow,
  ReconcileBudgetInput,
  ReserveBudgetInput,
  ReserveOperationInput,
  SessionRow,
} from "../../../src/server/db/gateway";
import { appErrors } from "../../../src/server/security/errors";

type OperationRecord = {
  id: string;
  project_id: string;
  owner_session_id: string;
  stage: string;
  status: OperationSummary["status"];
  input_revision: number;
  input_hash: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  lease_expires_at: string | null;
  result: unknown;
  error: unknown;
  created_at: string;
  updated_at: string;
};

type Lease = { id: string; calls: number; tokens: number; expires_at: string };

type BucketRecord = {
  scope: string;
  bucket_key: string;
  window_start: string;
  window_end: string;
  call_limit: number;
  reserved_calls: number;
  used_calls: number;
  reserved_tokens: number;
  used_tokens: number;
  active_leases: Lease[];
};

type ProjectRecord = ProjectRow & { base_scene: unknown };

export type GatewayMethod = keyof DataGateway;

export class MemoryGateway implements DataGateway {
  readonly sessions = new Map<string, SessionRow>();
  readonly projects = new Map<string, ProjectRecord>();
  readonly operations = new Map<string, OperationRecord>();
  readonly buckets = new Map<string, BucketRecord>();
  readonly decisions: {
    id: string;
    project_id: string;
    decision_kind: string;
    slot: string | null;
    created_at: string;
  }[] = [];

  /** Methods configured to fail, so the database-outage path can be exercised. */
  readonly failing = new Set<GatewayMethod>();

  #clock: () => Date = () => new Date();

  setClock(clock: () => Date): void {
    this.#clock = clock;
  }

  now(): Date {
    return this.#clock();
  }

  failAll(): void {
    const methods: GatewayMethod[] = [
      "insertSession",
      "findLiveSessionByHash",
      "touchSession",
      "deleteSession",
      "insertProject",
      "findProjectForOwner",
      "countProjectsForOwnerSince",
      "reserveOperation",
      "completeOperation",
      "reserveModelBudget",
      "reconcileModelBudget",
      "appendInfluenceDecision",
    ];
    for (const method of methods) this.failing.add(method);
  }

  #guard(method: GatewayMethod): void {
    if (this.failing.has(method)) {
      throw appErrors.persistenceUnavailable(`${method}: simulated outage`);
    }
  }

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  async insertSession(input: InsertSessionInput): Promise<SessionRow> {
    this.#guard("insertSession");
    for (const existing of this.sessions.values()) {
      if (existing.owner_secret_hash === input.ownerSecretHash) {
        throw appErrors.persistenceUnavailable("duplicate owner_secret_hash");
      }
    }
    const nowIso = this.now().toISOString();
    const row: SessionRow = {
      id: randomUUID(),
      owner_secret_hash: input.ownerSecretHash,
      created_at: nowIso,
      last_seen_at: nowIso,
      expires_at: input.expiresAt,
    };
    this.sessions.set(row.id, row);
    return row;
  }

  async findLiveSessionByHash(ownerSecretHash: string, now: string): Promise<SessionRow | null> {
    this.#guard("findLiveSessionByHash");
    for (const row of this.sessions.values()) {
      if (row.owner_secret_hash !== ownerSecretHash) continue;
      return Date.parse(row.expires_at) > Date.parse(now) ? { ...row } : null;
    }
    return null;
  }

  async touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    this.#guard("touchSession");
    const row = this.sessions.get(sessionId);
    if (row === undefined) return;
    this.sessions.set(sessionId, { ...row, last_seen_at: lastSeenAt, expires_at: expiresAt });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.#guard("deleteSession");
    this.sessions.delete(sessionId);
    for (const [id, project] of this.projects) {
      if (project.owner_session_id === sessionId) this.projects.delete(id);
    }
    for (const [id, operation] of this.operations) {
      if (operation.owner_session_id === sessionId) this.operations.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // projects
  // -------------------------------------------------------------------------

  async insertProject(input: InsertProjectInput): Promise<ProjectRow> {
    this.#guard("insertProject");
    if (!this.sessions.has(input.ownerSessionId)) {
      throw appErrors.persistenceUnavailable("owner_session_id violates its foreign key");
    }
    const nowIso = this.now().toISOString();
    const record: ProjectRecord = {
      id: randomUUID(),
      owner_session_id: input.ownerSessionId,
      title: input.title,
      brief: input.brief,
      anchor: null,
      revision: 1,
      active_approvals: {},
      base_scene: null,
      base_hash: null,
      active_version_id: null,
      workflow_state: "DRAFT",
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.projects.set(record.id, record);
    return this.#projectRow(record);
  }

  async findProjectForOwner(
    projectId: string,
    ownerSessionId: string,
  ): Promise<ProjectRow | null> {
    this.#guard("findProjectForOwner");
    const record = this.projects.get(projectId);
    if (record === undefined) return null;
    if (record.owner_session_id !== ownerSessionId) return null;
    return this.#projectRow(record);
  }

  async countProjectsForOwnerSince(ownerSessionId: string, since: string): Promise<number> {
    this.#guard("countProjectsForOwnerSince");
    const floor = Date.parse(since);
    let count = 0;
    for (const record of this.projects.values()) {
      if (record.owner_session_id !== ownerSessionId) continue;
      if (Date.parse(record.created_at) >= floor) count += 1;
    }
    return count;
  }

  /** The column projection the real gateway selects: never `base_scene`. */
  #projectRow(record: ProjectRecord): ProjectRow {
    const { base_scene: _omitted, ...row } = record;
    return { ...row, active_approvals: { ...row.active_approvals } };
  }

  // -------------------------------------------------------------------------
  // operations
  // -------------------------------------------------------------------------

  async reserveOperation(input: ReserveOperationInput): Promise<OperationReservation> {
    this.#guard("reserveOperation");
    if (input.leaseSeconds < 1 || input.leaseSeconds > 3600) {
      throw appErrors.persistenceUnavailable("lease seconds out of range");
    }
    // Models the row lock: yield, then run the decision without interleaving.
    await Promise.resolve();

    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }

    const now = this.now();
    const existing = [...this.operations.values()].find(
      (candidate) => candidate.idempotency_key === input.idempotencyKey,
    );

    if (existing === undefined) {
      const record: OperationRecord = {
        id: randomUUID(),
        project_id: input.projectId,
        owner_session_id: input.ownerSessionId,
        stage: input.stage,
        status: "reserved",
        input_revision: input.inputRevision,
        input_hash: input.inputHash,
        attempts: 1,
        max_attempts: input.maxAttempts,
        idempotency_key: input.idempotencyKey,
        lease_expires_at: new Date(now.getTime() + input.leaseSeconds * 1000).toISOString(),
        result: null,
        error: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      this.operations.set(record.id, record);
      return { outcome: "reserved", created: true, operation: summarize(record) };
    }

    if (
      existing.owner_session_id !== input.ownerSessionId ||
      existing.project_id !== input.projectId
    ) {
      return { outcome: "not_found" };
    }

    if (existing.status === "succeeded" || existing.status === "failed") {
      return { outcome: "settled", created: false, operation: summarize(existing) };
    }

    if (
      existing.lease_expires_at !== null &&
      Date.parse(existing.lease_expires_at) > now.getTime()
    ) {
      return { outcome: "lease_held", created: false, operation: summarize(existing) };
    }

    if (existing.attempts >= existing.max_attempts) {
      existing.status = "expired";
      existing.lease_expires_at = null;
      existing.updated_at = now.toISOString();
      return { outcome: "attempts_exhausted", created: false, operation: summarize(existing) };
    }

    existing.attempts += 1;
    existing.status = "reserved";
    existing.lease_expires_at = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
    existing.updated_at = now.toISOString();
    return {
      outcome: "reserved",
      created: false,
      recovered_expired_lease: true,
      operation: summarize(existing),
    };
  }

  async completeOperation(input: CompleteOperationInput): Promise<OperationCompletion> {
    this.#guard("completeOperation");
    await Promise.resolve();
    const record = this.operations.get(input.operationId);
    if (record === undefined || record.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (record.status === "succeeded" || record.status === "failed") {
      return { outcome: "already_settled", operation: summarize(record) };
    }
    record.status = input.status;
    record.result = input.result ?? null;
    record.error = input.error ?? null;
    record.lease_expires_at = null;
    record.updated_at = this.now().toISOString();
    return { outcome: "settled", operation: summarize(record) };
  }

  // -------------------------------------------------------------------------
  // budget buckets
  // -------------------------------------------------------------------------

  async reserveModelBudget(input: ReserveBudgetInput): Promise<BudgetReservation> {
    this.#guard("reserveModelBudget");
    if (input.calls < 1) throw appErrors.persistenceUnavailable("calls must be positive");
    if (input.leaseSeconds < 1 || input.leaseSeconds > 3600) {
      throw appErrors.persistenceUnavailable("lease seconds out of range");
    }
    await Promise.resolve();

    const key = `${input.scope}|${input.bucketKey}|${input.windowStart}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        scope: input.scope,
        bucket_key: input.bucketKey,
        window_start: input.windowStart,
        window_end: input.windowEnd,
        call_limit: input.callLimit,
        reserved_calls: 0,
        used_calls: 0,
        reserved_tokens: 0,
        used_tokens: 0,
        active_leases: [],
      };
      this.buckets.set(key, bucket);
    }

    const now = this.now().getTime();
    let expiredCalls = 0;
    let expiredTokens = 0;
    const kept: Lease[] = [];
    for (const lease of bucket.active_leases) {
      if (Date.parse(lease.expires_at) > now) {
        kept.push(lease);
      } else {
        expiredCalls += lease.calls;
        expiredTokens += lease.tokens;
      }
    }
    bucket.active_leases = kept;
    bucket.reserved_calls = Math.max(bucket.reserved_calls - expiredCalls, 0);
    bucket.reserved_tokens = Math.max(bucket.reserved_tokens - expiredTokens, 0);
    bucket.call_limit = input.callLimit;

    if (bucket.used_calls + bucket.reserved_calls + input.calls > bucket.call_limit) {
      return {
        granted: false,
        reason: "budget_exhausted",
        call_limit: bucket.call_limit,
        used_calls: bucket.used_calls,
        reserved_calls: bucket.reserved_calls,
        remaining_calls: Math.max(
          bucket.call_limit - bucket.used_calls - bucket.reserved_calls,
          0,
        ),
        window_start: bucket.window_start,
        window_end: bucket.window_end,
      };
    }

    const leaseId = randomUUID();
    const expiresAt = new Date(now + input.leaseSeconds * 1000).toISOString();
    bucket.active_leases.push({
      id: leaseId,
      calls: input.calls,
      tokens: input.tokens,
      expires_at: expiresAt,
    });
    bucket.reserved_calls += input.calls;
    bucket.reserved_tokens += input.tokens;

    return {
      granted: true,
      lease_id: leaseId,
      call_limit: bucket.call_limit,
      used_calls: bucket.used_calls,
      reserved_calls: bucket.reserved_calls,
      remaining_calls: Math.max(bucket.call_limit - bucket.used_calls - bucket.reserved_calls, 0),
      lease_expires_at: expiresAt,
      window_start: bucket.window_start,
      window_end: bucket.window_end,
    };
  }

  async reconcileModelBudget(input: ReconcileBudgetInput): Promise<BudgetReconciliation> {
    this.#guard("reconcileModelBudget");
    if (input.actualCalls < 0 || input.actualTokens < 0) {
      throw appErrors.persistenceUnavailable("reconciled usage cannot be negative");
    }
    await Promise.resolve();

    for (const bucket of this.buckets.values()) {
      const index = bucket.active_leases.findIndex((lease) => lease.id === input.leaseId);
      if (index === -1) continue;
      const lease = bucket.active_leases[index];
      if (lease === undefined) continue;
      bucket.active_leases.splice(index, 1);
      bucket.reserved_calls = Math.max(bucket.reserved_calls - lease.calls, 0);
      bucket.reserved_tokens = Math.max(bucket.reserved_tokens - lease.tokens, 0);
      bucket.used_calls += input.actualCalls;
      bucket.used_tokens += input.actualTokens;
      return {
        applied: true,
        call_limit: bucket.call_limit,
        used_calls: bucket.used_calls,
        used_tokens: bucket.used_tokens,
        reserved_calls: bucket.reserved_calls,
        reserved_tokens: bucket.reserved_tokens,
        remaining_calls: Math.max(
          bucket.call_limit - bucket.used_calls - bucket.reserved_calls,
          0,
        ),
      };
    }
    return { applied: false, reason: "lease_not_found" };
  }

  // -------------------------------------------------------------------------
  // decisions
  // -------------------------------------------------------------------------

  async appendInfluenceDecision(input: AppendDecisionInput): Promise<DecisionAppend> {
    this.#guard("appendInfluenceDecision");
    await Promise.resolve();

    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }

    const nowIso = this.now().toISOString();
    const decisionId = randomUUID();
    this.decisions.push({
      id: decisionId,
      project_id: input.projectId,
      decision_kind: input.decisionKind,
      slot: input.slot,
      created_at: nowIso,
    });

    const approvals = { ...project.active_approvals };
    if (input.slot !== null) {
      if (["accept", "edit", "replace"].includes(input.decisionKind)) {
        approvals[input.slot] = decisionId;
      } else if (["reject", "remove"].includes(input.decisionKind)) {
        delete approvals[input.slot];
      }
    }
    project.active_approvals = approvals;
    project.revision += 1;
    project.updated_at = nowIso;

    return {
      outcome: "appended",
      decision_id: decisionId,
      created_at: nowIso,
      revision: project.revision,
      active_approvals: { ...approvals },
    };
  }
}

function summarize(record: OperationRecord): OperationSummary {
  return {
    id: record.id,
    project_id: record.project_id,
    stage: record.stage,
    status: record.status,
    input_revision: record.input_revision,
    input_hash: record.input_hash,
    attempts: record.attempts,
    max_attempts: record.max_attempts,
    idempotency_key: record.idempotency_key,
    lease_expires_at: record.lease_expires_at,
    result: record.result,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Mirrors the application's own hash so a test can assert what was stored. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
