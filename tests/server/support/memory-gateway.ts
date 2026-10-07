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
  AnchorConfirmation,
  CommitSceneVersionInput,
  CompilationStateRow,
  CompilationStateUpdate,
  CompileLease,
  OperationPark,
  SceneVersionCommit,
  SceneVersionRead,
  SceneVersionRow,
  SetCompilationStateInput,
  VersionActivation,
  VersionDecisionInput,
  AppendDecisionInput,
  BudgetReconciliation,
  BudgetReservation,
  CompleteOperationInput,
  ConfirmAnchorInput,
  DataGateway,
  DecisionAppend,
  InfluenceDecisionRow,
  InsertProjectInput,
  InsertQlooCaptureInput,
  InsertSessionInput,
  OperationCompletion,
  OperationReservation,
  OperationSummary,
  ProjectReferencesUpdate,
  ProjectRow,
  ProposalDraftUpdate,
  QlooCaptureRow,
  QlooLaunchRelease,
  QlooLaunchReservation,
  ReconcileBudgetInput,
  ReserveBudgetInput,
  ReserveOperationInput,
  ReserveQlooLaunchInput,
  SessionRow,
  SetProjectReferencesInput,
  SetProposalDraftInput,
  EndingCopyOverridesUpdate,
  PublicationCommit,
  PublicationList,
  PublicationRead,
  PublicationRevoke,
  PublishVersionInput,
  SetEndingCopyOverridesInput,
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
  /** Only the Qloo launch scope writes this, exactly as in the migration. */
  last_launch_at: string | null;
};

type ProjectRecord = ProjectRow & {
  base_scene: unknown;
  compiled_modules: Record<string, unknown>;
};

/** One immutable version row. Contents never change after insert. */
type VersionRecord = SceneVersionRow & { project_id: string };

type DecisionRecord = InfluenceDecisionRow;

/** One publication row. Only the token's hash is ever stored, exactly as in SQL. */
type PublicationRecord = {
  id: string;
  owner_session_id: string;
  project_id: string;
  scene_version_id: string;
  read_token_hash: string;
  public_snapshot: unknown;
  created_at: string;
  revoked_at: string | null;
};

export type GatewayMethod = keyof DataGateway;

export class MemoryGateway implements DataGateway {
  readonly sessions = new Map<string, SessionRow>();
  readonly projects = new Map<string, ProjectRecord>();
  readonly operations = new Map<string, OperationRecord>();
  readonly buckets = new Map<string, BucketRecord>();
  readonly decisions: DecisionRecord[] = [];
  /** All immutable captures, keyed by row ID, including expired history. */
  readonly captures = new Map<string, QlooCaptureRow>();
  readonly versions: VersionRecord[] = [];
  readonly publications: PublicationRecord[] = [];

  /** Every granted Qloo launch, in order, so a test can assert the pacing. */
  readonly qlooLaunches: { label: string; at: string; leaseId: string }[] = [];

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
      "deleteBudgetBucket",
      "appendInfluenceDecision",
      "listInfluenceDecisions",
      "findQlooCaptureByFingerprint",
      "findQlooCapturesByFingerprints",
      "findLatestQlooCapture",
      "findQlooCapturesByIds",
      "insertQlooCapture",
      "reserveQlooLaunch",
      "releaseQlooLaunch",
      "confirmProjectAnchor",
      "setProjectReferences",
      "setProjectProposalDraft",
      "findProjectCompilationState",
      "findOperationForOwner",
      "findLatestOperation",
      "leaseCompileOperation",
      "parkOperation",
      "setProjectCompilationState",
      "commitSceneVersion",
      "activateSceneVersion",
      "declineSceneVersion",
      "readSceneVersions",
      "setProjectEndingCopyOverrides",
      "publishSceneVersion",
      "revokePublication",
      "readPublicationByToken",
      "readPublicationsForOwner",
      "countOperationsForOwnerSince",
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
      reference_capture_ids: [],
      active_approvals: {},
      proposal_draft: null,
      ending_copy_overrides: [],
      base_scene: null,
      compiled_modules: {},
      base_hash: null,
      active_version_id: null,
      pending_version_id: null,
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

  /**
   * The column projection the real gateway selects: never `base_scene` and
   * never `compiled_modules`.
   */
  #projectRow(record: ProjectRecord): ProjectRow {
    const { base_scene: _base, compiled_modules: _modules, ...row } = record;
    return {
      ...row,
      reference_capture_ids: [...row.reference_capture_ids],
      active_approvals: { ...row.active_approvals },
      ending_copy_overrides: [...row.ending_copy_overrides],
    };
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
        last_launch_at: null,
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

  async deleteBudgetBucket(scope: string, bucketKey: string): Promise<void> {
    this.#guard("deleteBudgetBucket");
    for (const [key, bucket] of this.buckets) {
      if (bucket.scope === scope && bucket.bucket_key === bucketKey) this.buckets.delete(key);
    }
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
      proposal_snapshot: input.proposalSnapshot ?? null,
      selected_evidence_ids: [...input.selectedEvidenceIds],
      creator_text: input.creatorText,
      predecessor_id: input.predecessorId,
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

  async listInfluenceDecisions(
    projectId: string,
    ownerSessionId: string,
  ): Promise<InfluenceDecisionRow[]> {
    this.#guard("listInfluenceDecisions");
    const project = this.projects.get(projectId);
    if (project === undefined || project.owner_session_id !== ownerSessionId) return [];
    return this.decisions
      .filter((decision) => decision.project_id === projectId)
      .map((decision) => ({
        ...decision,
        selected_evidence_ids: [...decision.selected_evidence_ids],
      }));
  }

  // -------------------------------------------------------------------------
  // Qloo captures
  // -------------------------------------------------------------------------

  async findQlooCaptureByFingerprint(fingerprint: string, freshAt?: string): Promise<QlooCaptureRow | null> {
    this.#guard("findQlooCaptureByFingerprint");
    const rows = this.#newestCaptures([fingerprint], freshAt);
    return rows[0] ?? null;
  }

  #newestCaptures(fingerprints: readonly string[], freshAt?: string): QlooCaptureRow[] {
    const wanted = new Set(fingerprints);
    const rows = [...this.captures.values()]
      .filter((row) => wanted.has(row.request_fingerprint) &&
        (freshAt === undefined || Date.parse(row.cache_expires_at) > Date.parse(freshAt)))
      .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || b.id.localeCompare(a.id));
    const newest = new Map<string, QlooCaptureRow>();
    for (const row of rows) {
      if (!newest.has(row.request_fingerprint)) newest.set(row.request_fingerprint, structuredClone(row));
    }
    return [...newest.values()];
  }

  async findQlooCapturesByFingerprints(
    fingerprints: readonly string[],
    freshAt?: string,
  ): Promise<QlooCaptureRow[]> {
    this.#guard("findQlooCapturesByFingerprints");
    return this.#newestCaptures(fingerprints, freshAt);
  }

  async findLatestQlooCapture(
    artistEntityId: string,
    domain: "movie" | "videogame",
  ): Promise<QlooCaptureRow | null> {
    this.#guard("findLatestQlooCapture");
    const matching = [...this.captures.values()]
      .filter((row) => row.artist_entity_id === artistEntityId && row.domain === domain)
      .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at) || b.id.localeCompare(a.id));
    const first = matching[0];
    return first === undefined ? null : { ...first };
  }

  async findQlooCapturesByIds(ids: readonly string[]): Promise<QlooCaptureRow[]> {
    this.#guard("findQlooCapturesByIds");
    const wanted = new Set(ids);
    return [...this.captures.values()]
      .filter((row) => wanted.has(row.id))
      .map((row) => ({ ...row }));
  }

  /** Every successful upstream retrieval gets its own immutable row. */
  async insertQlooCapture(input: InsertQlooCaptureInput): Promise<QlooCaptureRow> {
    this.#guard("insertQlooCapture");
    await Promise.resolve();
    const capturedAt = input.capturedAt ?? this.now().toISOString();
    if (Date.parse(input.cacheExpiresAt) <= Date.parse(capturedAt)) {
      throw appErrors.persistenceUnavailable("cache_expires_at must be after captured_at");
    }
    const row: QlooCaptureRow = {
      id: randomUUID(),
      kind: input.kind,
      request_fingerprint: input.requestFingerprint,
      normalized_query: input.normalizedQuery,
      artist_entity_id: input.artistEntityId,
      domain: input.domain,
      results: input.results,
      quota_diagnostics: input.quotaDiagnostics ?? null,
      normalizer_version: input.normalizerVersion,
      captured_at: capturedAt,
      cache_expires_at: input.cacheExpiresAt,
    };
    this.captures.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  // -------------------------------------------------------------------------
  // Qloo launch policy
  // -------------------------------------------------------------------------

  /**
   * Re-implements `reserve_qloo_launch`. The yield before the critical section
   * models the row lock: two interleaved callers cannot both be granted a
   * lease beyond the cap, which is the behaviour a test needs to observe.
   */
  async reserveQlooLaunch(input: ReserveQlooLaunchInput): Promise<QlooLaunchReservation> {
    this.#guard("reserveQlooLaunch");
    if (input.maxLeases < 1 || input.maxLeases > 8) {
      throw appErrors.persistenceUnavailable("max leases out of range");
    }
    if (input.minSpacingMs < 0 || input.minSpacingMs > 60_000) {
      throw appErrors.persistenceUnavailable("spacing out of range");
    }
    if (input.leaseSeconds < 1 || input.leaseSeconds > 600) {
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
        call_limit: input.maxLeases,
        reserved_calls: 0,
        used_calls: 0,
        reserved_tokens: 0,
        used_tokens: 0,
        active_leases: [],
        last_launch_at: null,
      };
      this.buckets.set(key, bucket);
    }

    const now = this.now().getTime();
    const kept = bucket.active_leases.filter((lease) => Date.parse(lease.expires_at) > now);
    bucket.active_leases = kept;
    bucket.reserved_calls = kept.length;
    bucket.call_limit = input.maxLeases;

    if (kept.length >= input.maxLeases) {
      const nextFree = Math.min(...kept.map((lease) => Date.parse(lease.expires_at)));
      return {
        granted: false,
        reason: "concurrency",
        active_leases: kept.length,
        max_leases: input.maxLeases,
        retry_after_ms: Math.max(1, Math.min(5_000, Math.ceil(nextFree - now))),
      };
    }

    if (bucket.last_launch_at !== null) {
      const since = now - Date.parse(bucket.last_launch_at);
      if (since < input.minSpacingMs) {
        return {
          granted: false,
          reason: "spacing",
          active_leases: kept.length,
          max_leases: input.maxLeases,
          retry_after_ms: Math.max(1, Math.ceil(input.minSpacingMs - since)),
        };
      }
    }

    const leaseId = randomUUID();
    const expiresAt = new Date(now + input.leaseSeconds * 1000).toISOString();
    bucket.active_leases.push({ id: leaseId, calls: 1, tokens: 0, expires_at: expiresAt });
    bucket.reserved_calls = bucket.active_leases.length;
    bucket.last_launch_at = new Date(now).toISOString();
    this.qlooLaunches.push({
      label: input.bucketKey,
      at: bucket.last_launch_at,
      leaseId,
    });

    return {
      granted: true,
      lease_id: leaseId,
      active_leases: bucket.active_leases.length,
      max_leases: input.maxLeases,
      lease_expires_at: expiresAt,
      launched_at: bucket.last_launch_at,
    };
  }

  async releaseQlooLaunch(scope: string, leaseId: string): Promise<QlooLaunchRelease> {
    this.#guard("releaseQlooLaunch");
    await Promise.resolve();
    for (const bucket of this.buckets.values()) {
      if (bucket.scope !== scope) continue;
      const index = bucket.active_leases.findIndex((lease) => lease.id === leaseId);
      if (index === -1) continue;
      bucket.active_leases.splice(index, 1);
      bucket.reserved_calls = bucket.active_leases.length;
      return { released: true, active_leases: bucket.active_leases.length };
    }
    return { released: false, reason: "lease_not_found" };
  }

  // -------------------------------------------------------------------------
  // Project state writes
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Phase 4: compilation state, leases, versions, and activation
  // -------------------------------------------------------------------------

  async findProjectCompilationState(
    projectId: string,
    ownerSessionId: string,
  ): Promise<CompilationStateRow | null> {
    this.#guard("findProjectCompilationState");
    await Promise.resolve();
    const project = this.projects.get(projectId);
    if (project === undefined || project.owner_session_id !== ownerSessionId) return null;
    return {
      base_scene: project.base_scene,
      base_hash: project.base_hash,
      compiled_modules: { ...project.compiled_modules },
    };
  }

  async findOperationForOwner(
    operationId: string,
    ownerSessionId: string,
  ): Promise<OperationSummary | null> {
    this.#guard("findOperationForOwner");
    await Promise.resolve();
    const record = this.operations.get(operationId);
    if (record === undefined || record.owner_session_id !== ownerSessionId) return null;
    return summarize(record);
  }

  async findLatestOperation(
    projectId: string,
    ownerSessionId: string,
    stage: string,
  ): Promise<OperationSummary | null> {
    this.#guard("findLatestOperation");
    await Promise.resolve();
    const matching = [...this.operations.values()]
      .filter(
        (record) =>
          record.project_id === projectId &&
          record.owner_session_id === ownerSessionId &&
          record.stage === stage,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const newest = matching[0];
    return newest === undefined ? null : summarize(newest);
  }

  /** Mirrors `lease_compile_operation`: a mutex that spends no attempt. */
  async leaseCompileOperation(
    operationId: string,
    ownerSessionId: string,
    leaseSeconds: number,
  ): Promise<CompileLease> {
    this.#guard("leaseCompileOperation");
    if (leaseSeconds < 1 || leaseSeconds > 3600) {
      throw appErrors.persistenceUnavailable("lease seconds out of range");
    }
    await Promise.resolve();
    const record = this.operations.get(operationId);
    if (record === undefined || record.owner_session_id !== ownerSessionId) {
      return { outcome: "not_found" };
    }
    // The SQL restricts this to the controller row, so a model stage cannot
    // acquire a lease without spending an attempt.
    if (record.stage !== "compile") return { outcome: "not_found" };
    if (record.status === "succeeded" || record.status === "failed") {
      return { outcome: "settled", operation: summarize(record) };
    }
    const nowMs = this.now().getTime();
    if (record.lease_expires_at !== null && Date.parse(record.lease_expires_at) > nowMs) {
      return { outcome: "lease_held", operation: summarize(record) };
    }
    record.status = "running";
    record.lease_expires_at = new Date(nowMs + leaseSeconds * 1000).toISOString();
    record.updated_at = this.now().toISOString();
    return { outcome: "leased", operation: summarize(record) };
  }

  /** Mirrors `park_operation`: release the lease, keep the attempt ceiling. */
  async parkOperation(
    operationId: string,
    ownerSessionId: string,
    result: unknown,
  ): Promise<OperationPark> {
    this.#guard("parkOperation");
    await Promise.resolve();
    const record = this.operations.get(operationId);
    if (record === undefined || record.owner_session_id !== ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (record.status === "succeeded" || record.status === "failed") {
      return { outcome: "already_settled", operation: summarize(record) };
    }
    record.status = "reserved";
    if (result !== null && result !== undefined) record.result = result;
    record.lease_expires_at = this.now().toISOString();
    record.updated_at = this.now().toISOString();
    return { outcome: "parked", operation: summarize(record) };
  }

  async setProjectCompilationState(
    input: SetCompilationStateInput,
  ): Promise<CompilationStateUpdate> {
    this.#guard("setProjectCompilationState");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    if (input.baseScene !== null && input.baseScene !== undefined) {
      project.base_scene = input.baseScene;
    }
    if (input.baseHash !== null) project.base_hash = input.baseHash;
    if (input.compiledModules !== null && input.compiledModules !== undefined) {
      project.compiled_modules = input.compiledModules as Record<string, unknown>;
    }
    if (input.workflowState !== null) project.workflow_state = input.workflowState;
    project.updated_at = this.now().toISOString();
    // The revision is deliberately unchanged: a compilation is derived from a
    // revision, not a creator edit to one.
    return {
      outcome: "updated",
      revision: project.revision,
      base_hash: project.base_hash,
      workflow_state: project.workflow_state,
    };
  }

  /** Mirrors `commit_scene_version`, including its compare-and-swap triple. */
  async commitSceneVersion(input: CommitSceneVersionInput): Promise<SceneVersionCommit> {
    this.#guard("commitSceneVersion");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    const sameApprovals =
      JSON.stringify(sortedKeys(project.active_approvals)) ===
      JSON.stringify(sortedKeys(input.expectedApprovals));
    if (
      project.revision !== input.expectedRevision ||
      (project.base_hash ?? "") !== (input.expectedBaseHash ?? "") ||
      !sameApprovals
    ) {
      return { outcome: "stale_input", current_revision: project.revision };
    }
    // The table's own check constraint refuses an unvalidated summary.
    const summary = input.validationSummary as { ok?: unknown } | null;
    if (
      summary === null ||
      typeof summary !== "object" ||
      summary.ok !== true ||
      !("subsets" in summary) ||
      !("witnesses" in summary)
    ) {
      throw appErrors.persistenceUnavailable(
        "scene_versions_validation_passed: only a validated version is a version",
      );
    }
    const createdAt = this.now().toISOString();
    const record: VersionRecord = {
      id: randomUUID(),
      project_id: input.projectId,
      parent_version_id: input.parentVersionId,
      input_hash: input.inputHash,
      base_hash: input.baseHash,
      module_hashes: { ...input.moduleHashes },
      validation_summary: input.validationSummary,
      revision_diff: input.revisionDiff ?? null,
      input_snapshot: input.inputSnapshot,
      approval_snapshot: input.approvalSnapshot,
      model_identifier: input.modelIdentifier,
      prompt_identifier: input.promptIdentifier,
      schema_identifier: input.schemaIdentifier,
      compiler_identifier: input.compilerIdentifier,
      validator_identifier: input.validatorIdentifier,
      operation_id: input.operationId,
      created_at: createdAt,
      scene: input.scene,
    };
    this.versions.push(record);
    // Reviewable, not current: `active_version_id` is untouched. The compiled
    // module artifacts stay, so a slot whose approval did not move keeps its
    // module and a later compilation recompiles only the slot that changed.
    project.pending_version_id = record.id;
    project.workflow_state = "REVIEW_PLAYABLE";
    project.updated_at = createdAt;
    return {
      outcome: "committed",
      version_id: record.id,
      created_at: createdAt,
      revision: project.revision,
    };
  }

  async activateSceneVersion(input: VersionDecisionInput): Promise<VersionActivation> {
    this.#guard("activateSceneVersion");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    const version = this.versions.find(
      (candidate) => candidate.id === input.versionId && candidate.project_id === input.projectId,
    );
    if (version === undefined) return { outcome: "not_found" };

    if (project.active_version_id === input.versionId) {
      return {
        outcome: "already_active",
        active_version_id: project.active_version_id,
        pending_version_id: project.pending_version_id,
        workflow_state: project.workflow_state,
      };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    if (project.pending_version_id !== input.versionId) return { outcome: "not_pending" };

    const frozenApprovals: Record<string, unknown> = {};
    for (const entry of (version.approval_snapshot ?? []) as { slot?: string; approval_id?: string }[]) {
      if (typeof entry.slot === "string" && typeof entry.approval_id === "string") {
        frozenApprovals[entry.slot] = entry.approval_id;
      }
    }
    const snapshot = (version.input_snapshot ?? {}) as { project_revision?: unknown };
    const sameRevision = String(snapshot.project_revision ?? "") === String(project.revision);
    const sameApprovals =
      JSON.stringify(sortedKeys(frozenApprovals)) ===
      JSON.stringify(sortedKeys(project.active_approvals));
    if (
      !sameRevision ||
      (version.base_hash ?? "") !== (project.base_hash ?? "") ||
      !sameApprovals
    ) {
      return { outcome: "stale_input", current_revision: project.revision };
    }

    project.active_version_id = input.versionId;
    project.pending_version_id = null;
    project.workflow_state = "READY";
    project.updated_at = this.now().toISOString();
    return {
      outcome: "activated",
      active_version_id: project.active_version_id,
      pending_version_id: null,
      workflow_state: project.workflow_state,
    };
  }

  async declineSceneVersion(input: VersionDecisionInput): Promise<VersionActivation> {
    this.#guard("declineSceneVersion");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    if (project.pending_version_id !== input.versionId) return { outcome: "not_pending" };
    // The declined version row is untouched; the previous active one stays active.
    project.pending_version_id = null;
    project.workflow_state = project.active_version_id === null ? "AWAITING_APPROVAL" : "READY";
    project.updated_at = this.now().toISOString();
    return {
      outcome: "declined",
      active_version_id: project.active_version_id,
      pending_version_id: null,
      workflow_state: project.workflow_state,
    };
  }

  async readSceneVersions(
    projectId: string,
    ownerSessionId: string,
    versionId: string | null,
    limit: number,
  ): Promise<SceneVersionRead> {
    this.#guard("readSceneVersions");
    if (limit < 1 || limit > 50) {
      throw appErrors.persistenceUnavailable("limit out of range");
    }
    await Promise.resolve();
    const project = this.projects.get(projectId);
    if (project === undefined || project.owner_session_id !== ownerSessionId) {
      return { outcome: "not_found" };
    }
    const rows = this.versions
      .filter(
        (candidate) =>
          candidate.project_id === projectId &&
          (versionId === null || candidate.id === versionId),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      // The scene travels only when one version is named.
      .map((candidate) => ({ ...candidate, scene: versionId === null ? null : candidate.scene }));
    return { outcome: "read", versions: rows };
  }

  // -------------------------------------------------------------------------
  // Phase 5: ending-copy overrides, publication, and the public read
  // -------------------------------------------------------------------------

  /** Mirrors `set_project_ending_copy_overrides`, counter advance included. */
  async setProjectEndingCopyOverrides(
    input: SetEndingCopyOverridesInput,
  ): Promise<EndingCopyOverridesUpdate> {
    this.#guard("setProjectEndingCopyOverrides");
    await Promise.resolve();
    if (input.overrides.length > 3) {
      throw appErrors.persistenceUnavailable(
        "projects_ending_copy_overrides_bounded: at most three overrides",
      );
    }
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    project.ending_copy_overrides = [...input.overrides];
    project.revision += 1;
    project.updated_at = this.now().toISOString();
    return { outcome: "updated", revision: project.revision };
  }

  /** Mirrors `publish_scene_version`, including its refusal to publish a review. */
  async publishSceneVersion(input: PublishVersionInput): Promise<PublicationCommit> {
    this.#guard("publishSceneVersion");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    const version = this.versions.find(
      (candidate) =>
        candidate.id === input.versionId && candidate.project_id === input.projectId,
    );
    if (version === undefined) return { outcome: "not_found" };
    if (project.pending_version_id === input.versionId) return { outcome: "not_reviewed" };
    if (
      this.publications.some(
        (candidate) => candidate.read_token_hash === input.readTokenHash,
      )
    ) {
      throw appErrors.persistenceUnavailable("publications_read_token_hash_key");
    }
    const record: PublicationRecord = {
      id: randomUUID(),
      owner_session_id: input.ownerSessionId,
      project_id: input.projectId,
      scene_version_id: input.versionId,
      read_token_hash: input.readTokenHash,
      public_snapshot: input.publicSnapshot,
      created_at: this.now().toISOString(),
      revoked_at: null,
    };
    this.publications.push(record);
    return {
      outcome: "published",
      publication: {
        id: record.id,
        scene_version_id: record.scene_version_id,
        created_at: record.created_at,
        revoked_at: null,
      },
    };
  }

  async revokePublication(
    publicationId: string,
    ownerSessionId: string,
  ): Promise<PublicationRevoke> {
    this.#guard("revokePublication");
    await Promise.resolve();
    const record = this.publications.find(
      (candidate) =>
        candidate.id === publicationId && candidate.owner_session_id === ownerSessionId,
    );
    if (record === undefined) return { outcome: "not_found" };
    if (record.revoked_at !== null) {
      return {
        outcome: "already_revoked",
        publication: {
          id: record.id,
          scene_version_id: record.scene_version_id,
          created_at: record.created_at,
          revoked_at: record.revoked_at,
        },
      };
    }
    record.revoked_at = this.now().toISOString();
    return {
      outcome: "revoked",
      publication: {
        id: record.id,
        scene_version_id: record.scene_version_id,
        created_at: record.created_at,
        revoked_at: record.revoked_at,
      },
    };
  }

  /** The one read with no owner predicate. Unknown and revoked are the same. */
  async readPublicationByToken(readTokenHash: string): Promise<PublicationRead> {
    this.#guard("readPublicationByToken");
    await Promise.resolve();
    const record = this.publications.find(
      (candidate) => candidate.read_token_hash === readTokenHash,
    );
    if (record === undefined || record.revoked_at !== null) {
      return { outcome: "unavailable" };
    }
    return {
      outcome: "read",
      published_at: record.created_at,
      public_snapshot: record.public_snapshot,
    };
  }

  async readPublicationsForOwner(
    projectId: string,
    ownerSessionId: string,
    limit: number,
  ): Promise<PublicationList> {
    this.#guard("readPublicationsForOwner");
    if (limit < 1 || limit > 50) {
      throw appErrors.persistenceUnavailable("limit out of range");
    }
    await Promise.resolve();
    const project = this.projects.get(projectId);
    if (project === undefined || project.owner_session_id !== ownerSessionId) {
      return { outcome: "not_found" };
    }
    const publications = this.publications
      .filter(
        (candidate) =>
          candidate.project_id === projectId &&
          candidate.owner_session_id === ownerSessionId,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((candidate) => ({
        id: candidate.id,
        scene_version_id: candidate.scene_version_id,
        created_at: candidate.created_at,
        revoked_at: candidate.revoked_at,
        provenance_included:
          typeof candidate.public_snapshot === "object" &&
          candidate.public_snapshot !== null &&
          (candidate.public_snapshot as { provenance_included?: unknown })
            .provenance_included === true,
      }));
    return { outcome: "read", publications };
  }

  async countOperationsForOwnerSince(
    ownerSessionId: string,
    stages: readonly string[],
    since: string,
  ): Promise<number> {
    this.#guard("countOperationsForOwnerSince");
    await Promise.resolve();
    if (stages.length === 0) return 0;
    const floor = Date.parse(since);
    let count = 0;
    for (const operation of this.operations.values()) {
      if (operation.owner_session_id !== ownerSessionId) continue;
      if (!stages.includes(operation.stage)) continue;
      if (Date.parse(operation.created_at) >= floor) count += 1;
    }
    return count;
  }

  async confirmProjectAnchor(input: ConfirmAnchorInput): Promise<AnchorConfirmation> {
    this.#guard("confirmProjectAnchor");
    await Promise.resolve();

    const anchor = input.anchor;
    if (typeof anchor !== "object" || anchor === null) {
      throw appErrors.persistenceUnavailable("an anchor object is required");
    }
    const nextEntity = (anchor as { entity_id?: unknown }).entity_id;
    if (typeof nextEntity !== "string" || nextEntity.length === 0) {
      throw appErrors.persistenceUnavailable("the anchor must name a confirmed entity id");
    }

    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }

    const previousEntity =
      typeof project.anchor === "object" && project.anchor !== null
        ? ((project.anchor as { entity_id?: unknown }).entity_id ?? null)
        : null;
    const occupiedSlots = Object.keys(project.active_approvals);
    const hasCulturalWork =
      project.reference_capture_ids.length > 0 ||
      occupiedSlots.length > 0 ||
      project.proposal_draft !== null;

    const changing = typeof previousEntity === "string" && previousEntity !== nextEntity;

    if (changing && hasCulturalWork && !input.rebranch) {
      return {
        outcome: "rebranch_required",
        current_revision: project.revision,
        previous_entity_id: previousEntity,
        occupied_slots: occupiedSlots,
      };
    }

    const cleared: string[] = [];
    if (changing && hasCulturalWork) {
      const nowIso = this.now().toISOString();
      for (const slot of occupiedSlots) {
        this.decisions.push({
          id: randomUUID(),
          project_id: input.projectId,
          decision_kind: "remove",
          slot: slot as "discovery" | "commitment",
          proposal_snapshot: {
            kind: "remove",
            reason: "anchor_rebranch",
            previous_entity_id: previousEntity,
            next_entity_id: nextEntity,
            decided_at: nowIso,
            project_revision: project.revision,
          },
          selected_evidence_ids: [],
          creator_text: null,
          predecessor_id: String(project.active_approvals[slot]),
          created_at: nowIso,
        });
        cleared.push(slot);
      }
      project.active_approvals = {};
      project.reference_capture_ids = [];
      project.proposal_draft = null;
    }

    project.anchor = anchor;
    project.workflow_state = "ANCHOR_CONFIRMED";
    project.revision += 1;
    project.updated_at = this.now().toISOString();

    return {
      outcome: "confirmed",
      revision: project.revision,
      anchor_entity_id: nextEntity,
      invalidated: cleared.length > 0,
      cleared_slots: cleared,
    };
  }

  async setProjectReferences(
    input: SetProjectReferencesInput,
  ): Promise<ProjectReferencesUpdate> {
    this.#guard("setProjectReferences");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    if (anchorEntityOf(project) !== input.anchorEntityId) {
      return { outcome: "anchor_mismatch" };
    }
    project.reference_capture_ids = [...input.captureIds];
    project.proposal_draft = null;
    project.workflow_state = "REFERENCES_READY";
    project.updated_at = this.now().toISOString();
    return {
      outcome: "updated",
      revision: project.revision,
      capture_ids: [...project.reference_capture_ids],
    };
  }

  async setProjectProposalDraft(input: SetProposalDraftInput): Promise<ProposalDraftUpdate> {
    this.#guard("setProjectProposalDraft");
    await Promise.resolve();
    const project = this.projects.get(input.projectId);
    if (project === undefined || project.owner_session_id !== input.ownerSessionId) {
      return { outcome: "not_found" };
    }
    if (project.revision !== input.expectedRevision) {
      return { outcome: "revision_conflict", current_revision: project.revision };
    }
    if (anchorEntityOf(project) !== input.anchorEntityId) {
      return { outcome: "anchor_mismatch" };
    }
    project.proposal_draft = input.draft ?? null;
    project.workflow_state = "PROPOSALS_READY";
    project.updated_at = this.now().toISOString();
    return { outcome: "updated", revision: project.revision };
  }
}

/** Stable key/value pairs, so two approval maps compare by content. */
function sortedKeys(value: Record<string, unknown>): [string, unknown][] {
  return Object.keys(value)
    .sort()
    .map((key) => [key, value[key]] as [string, unknown]);
}

function anchorEntityOf(project: ProjectRecord): string {
  if (typeof project.anchor !== "object" || project.anchor === null) return "";
  const value = (project.anchor as { entity_id?: unknown }).entity_id;
  return typeof value === "string" ? value : "";
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
