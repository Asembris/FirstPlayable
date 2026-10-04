/**
 * The one place in the application that constructs a Supabase client.
 *
 * Server only, secret key only. There is no browser Supabase client anywhere
 * in this repository and no `NEXT_PUBLIC_` Supabase variable: the browser
 * reaches the database exclusively through this application's own owner-scoped
 * routes (specification sections 10 and 12).
 *
 * The client is created lazily by {@link supabaseGateway} on the first request
 * that needs it, so `next build`, the static landing page, and `/example` never
 * require a configured or reachable database.
 *
 * Nothing in this module ever puts a Supabase error object into a thrown value
 * that could reach the browser: every failure becomes an `AppError` whose
 * diagnostic has already been redacted.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ConfigError, supabaseEnv } from "../config";
import { appErrors } from "../security/errors";
import {
  type AnchorConfirmation,
  AnchorConfirmationSchema,
  type AppendDecisionInput,
  type BudgetReconciliation,
  BudgetReconciliationSchema,
  type BudgetReservation,
  BudgetReservationSchema,
  type CompleteOperationInput,
  type ConfirmAnchorInput,
  type DataGateway,
  type DecisionAppend,
  DecisionAppendSchema,
  INFLUENCE_DECISION_COLUMNS,
  type InfluenceDecisionRow,
  InfluenceDecisionRowSchema,
  type InsertProjectInput,
  type InsertQlooCaptureInput,
  type InsertSessionInput,
  type OperationCompletion,
  OperationCompletionSchema,
  type OperationReservation,
  OperationReservationSchema,
  PROJECT_COLUMNS,
  type ProjectReferencesUpdate,
  ProjectReferencesUpdateSchema,
  type ProjectRow,
  ProjectRowSchema,
  type ProposalDraftUpdate,
  ProposalDraftUpdateSchema,
  QLOO_CAPTURE_COLUMNS,
  type QlooCaptureRow,
  QlooCaptureRowSchema,
  type QlooLaunchRelease,
  QlooLaunchReleaseSchema,
  type QlooLaunchReservation,
  QlooLaunchReservationSchema,
  type ReconcileBudgetInput,
  type ReserveBudgetInput,
  type ReserveOperationInput,
  type ReserveQlooLaunchInput,
  SESSION_COLUMNS,
  type SessionRow,
  SessionRowSchema,
  type SetProjectReferencesInput,
  type SetProposalDraftInput,
} from "./gateway";

function createServerClient(): SupabaseClient {
  const env = supabaseEnv();
  return createClient(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-application-name": "firstplayable" } },
  });
}

/** Maps any transport, SQL, or contract failure to a redacted application error. */
function persistenceFailure(operation: string, cause: unknown): never {
  throw appErrors.persistenceUnavailable(`${operation}: ${String(cause)}`);
}

function parseRpc<T>(
  operation: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    persistenceFailure(`${operation} returned an unexpected shape`, parsed.error);
  }
  return parsed.data;
}

class SupabaseGateway implements DataGateway {
  readonly #client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.#client = client;
  }

  async insertSession(input: InsertSessionInput): Promise<SessionRow> {
    const { data, error } = await this.#client
      .from("sessions")
      .insert({ owner_secret_hash: input.ownerSecretHash, expires_at: input.expiresAt })
      .select(SESSION_COLUMNS)
      .single();
    if (error !== null) persistenceFailure("insertSession", error.message);
    return parseRpc("insertSession", SessionRowSchema, data);
  }

  async findLiveSessionByHash(ownerSecretHash: string, now: string): Promise<SessionRow | null> {
    const { data, error } = await this.#client
      .from("sessions")
      .select(SESSION_COLUMNS)
      .eq("owner_secret_hash", ownerSecretHash)
      .gt("expires_at", now)
      .maybeSingle();
    if (error !== null) persistenceFailure("findLiveSessionByHash", error.message);
    if (data === null) return null;
    return parseRpc("findLiveSessionByHash", SessionRowSchema, data);
  }

  async touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    const { error } = await this.#client
      .from("sessions")
      .update({ last_seen_at: lastSeenAt, expires_at: expiresAt })
      .eq("id", sessionId);
    if (error !== null) persistenceFailure("touchSession", error.message);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const { error } = await this.#client.from("sessions").delete().eq("id", sessionId);
    if (error !== null) persistenceFailure("deleteSession", error.message);
  }

  async insertProject(input: InsertProjectInput): Promise<ProjectRow> {
    const { data, error } = await this.#client
      .from("projects")
      .insert({
        owner_session_id: input.ownerSessionId,
        title: input.title,
        brief: input.brief,
      })
      .select(PROJECT_COLUMNS)
      .single();
    if (error !== null) persistenceFailure("insertProject", error.message);
    return parseRpc("insertProject", ProjectRowSchema, data);
  }

  /** Both predicates are mandatory. This is the only project read that exists. */
  async findProjectForOwner(
    projectId: string,
    ownerSessionId: string,
  ): Promise<ProjectRow | null> {
    const { data, error } = await this.#client
      .from("projects")
      .select(PROJECT_COLUMNS)
      .eq("id", projectId)
      .eq("owner_session_id", ownerSessionId)
      .maybeSingle();
    if (error !== null) persistenceFailure("findProjectForOwner", error.message);
    if (data === null) return null;
    return parseRpc("findProjectForOwner", ProjectRowSchema, data);
  }

  async countProjectsForOwnerSince(ownerSessionId: string, since: string): Promise<number> {
    const { count, error } = await this.#client
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("owner_session_id", ownerSessionId)
      .gte("created_at", since);
    if (error !== null) persistenceFailure("countProjectsForOwnerSince", error.message);
    return count ?? 0;
  }

  async reserveOperation(input: ReserveOperationInput): Promise<OperationReservation> {
    const { data, error } = await this.#client.rpc("reserve_operation", {
      p_project_id: input.projectId,
      p_owner_session_id: input.ownerSessionId,
      p_stage: input.stage,
      p_input_revision: input.inputRevision,
      p_input_hash: input.inputHash,
      p_idempotency_key: input.idempotencyKey,
      p_lease_seconds: input.leaseSeconds,
      p_max_attempts: input.maxAttempts,
    });
    if (error !== null) persistenceFailure("reserveOperation", error.message);
    return parseRpc("reserveOperation", OperationReservationSchema, data);
  }

  async completeOperation(input: CompleteOperationInput): Promise<OperationCompletion> {
    const { data, error } = await this.#client.rpc("complete_operation", {
      p_operation_id: input.operationId,
      p_owner_session_id: input.ownerSessionId,
      p_status: input.status,
      p_result: input.result ?? null,
      p_error: input.error ?? null,
    });
    if (error !== null) persistenceFailure("completeOperation", error.message);
    return parseRpc("completeOperation", OperationCompletionSchema, data);
  }

  async reserveModelBudget(input: ReserveBudgetInput): Promise<BudgetReservation> {
    const { data, error } = await this.#client.rpc("reserve_model_budget", {
      p_scope: input.scope,
      p_bucket_key: input.bucketKey,
      p_window_start: input.windowStart,
      p_window_end: input.windowEnd,
      p_call_limit: input.callLimit,
      p_calls: input.calls,
      p_tokens: input.tokens,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error !== null) persistenceFailure("reserveModelBudget", error.message);
    return parseRpc("reserveModelBudget", BudgetReservationSchema, data);
  }

  async reconcileModelBudget(input: ReconcileBudgetInput): Promise<BudgetReconciliation> {
    const { data, error } = await this.#client.rpc("reconcile_model_budget", {
      p_lease_id: input.leaseId,
      p_actual_calls: input.actualCalls,
      p_actual_tokens: input.actualTokens,
    });
    if (error !== null) persistenceFailure("reconcileModelBudget", error.message);
    return parseRpc("reconcileModelBudget", BudgetReconciliationSchema, data);
  }

  async deleteBudgetBucket(scope: string, bucketKey: string): Promise<void> {
    const { error } = await this.#client
      .from("budget_buckets")
      .delete()
      .eq("scope", scope)
      .eq("bucket_key", bucketKey);
    if (error !== null) persistenceFailure("deleteBudgetBucket", error.message);
  }

  async appendInfluenceDecision(input: AppendDecisionInput): Promise<DecisionAppend> {
    const { data, error } = await this.#client.rpc("append_influence_decision", {
      p_project_id: input.projectId,
      p_owner_session_id: input.ownerSessionId,
      p_expected_revision: input.expectedRevision,
      p_decision_kind: input.decisionKind,
      p_slot: input.slot,
      p_proposal_snapshot: input.proposalSnapshot ?? null,
      p_selected_evidence_ids: [...input.selectedEvidenceIds],
      p_creator_text: input.creatorText,
      p_predecessor_id: input.predecessorId,
    });
    if (error !== null) persistenceFailure("appendInfluenceDecision", error.message);
    return parseRpc("appendInfluenceDecision", DecisionAppendSchema, data);
  }

  async listInfluenceDecisions(
    projectId: string,
    ownerSessionId: string,
  ): Promise<InfluenceDecisionRow[]> {
    // The ownership predicate is a join through the project, because
    // influence_decisions carries no owner column of its own.
    const { data: project, error: projectError } = await this.#client
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("owner_session_id", ownerSessionId)
      .maybeSingle();
    if (projectError !== null) persistenceFailure("listInfluenceDecisions", projectError.message);
    if (project === null) return [];

    const { data, error } = await this.#client
      .from("influence_decisions")
      .select(INFLUENCE_DECISION_COLUMNS)
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error !== null) persistenceFailure("listInfluenceDecisions", error.message);
    return (data ?? []).map((row) =>
      parseRpc("listInfluenceDecisions", InfluenceDecisionRowSchema, row),
    );
  }

  // -------------------------------------------------------------------------
  // Qloo captures
  // -------------------------------------------------------------------------

  async findQlooCaptureByFingerprint(fingerprint: string): Promise<QlooCaptureRow | null> {
    const { data, error } = await this.#client
      .from("qloo_captures")
      .select(QLOO_CAPTURE_COLUMNS)
      .eq("request_fingerprint", fingerprint)
      .maybeSingle();
    if (error !== null) persistenceFailure("findQlooCaptureByFingerprint", error.message);
    if (data === null) return null;
    return parseRpc("findQlooCaptureByFingerprint", QlooCaptureRowSchema, data);
  }

  async findQlooCapturesByFingerprints(
    fingerprints: readonly string[],
  ): Promise<QlooCaptureRow[]> {
    if (fingerprints.length === 0) return [];
    const { data, error } = await this.#client
      .from("qloo_captures")
      .select(QLOO_CAPTURE_COLUMNS)
      .in("request_fingerprint", [...fingerprints]);
    if (error !== null) persistenceFailure("findQlooCapturesByFingerprints", error.message);
    return (data ?? []).map((row) =>
      parseRpc("findQlooCapturesByFingerprints", QlooCaptureRowSchema, row),
    );
  }

  async findLatestQlooCapture(
    artistEntityId: string,
    domain: "movie" | "videogame",
  ): Promise<QlooCaptureRow | null> {
    const { data, error } = await this.#client
      .from("qloo_captures")
      .select(QLOO_CAPTURE_COLUMNS)
      .eq("artist_entity_id", artistEntityId)
      .eq("domain", domain)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error !== null) persistenceFailure("findLatestQlooCapture", error.message);
    if (data === null) return null;
    return parseRpc("findLatestQlooCapture", QlooCaptureRowSchema, data);
  }

  async findQlooCapturesByIds(ids: readonly string[]): Promise<QlooCaptureRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.#client
      .from("qloo_captures")
      .select(QLOO_CAPTURE_COLUMNS)
      .in("id", [...ids]);
    if (error !== null) persistenceFailure("findQlooCapturesByIds", error.message);
    return (data ?? []).map((row) =>
      parseRpc("findQlooCapturesByIds", QlooCaptureRowSchema, row),
    );
  }

  /**
   * Immutable insert.
   *
   * `ignoreDuplicates` matters here: the table's own trigger rejects `UPDATE`,
   * so a merging upsert would fail. Two instances that retrieved the same
   * artist concurrently both end up reading the one row that won.
   */
  async insertQlooCapture(input: InsertQlooCaptureInput): Promise<QlooCaptureRow> {
    const { error } = await this.#client.from("qloo_captures").upsert(
      {
        kind: input.kind,
        request_fingerprint: input.requestFingerprint,
        normalized_query: input.normalizedQuery,
        artist_entity_id: input.artistEntityId,
        domain: input.domain,
        results: input.results,
        quota_diagnostics: input.quotaDiagnostics ?? null,
        normalizer_version: input.normalizerVersion,
        cache_expires_at: input.cacheExpiresAt,
      },
      { onConflict: "request_fingerprint", ignoreDuplicates: true },
    );
    if (error !== null) persistenceFailure("insertQlooCapture", error.message);

    const row = await this.findQlooCaptureByFingerprint(input.requestFingerprint);
    if (row === null) persistenceFailure("insertQlooCapture", "the inserted capture was not readable");
    return row;
  }

  // -------------------------------------------------------------------------
  // Qloo launch policy
  // -------------------------------------------------------------------------

  async reserveQlooLaunch(input: ReserveQlooLaunchInput): Promise<QlooLaunchReservation> {
    const { data, error } = await this.#client.rpc("reserve_qloo_launch", {
      p_scope: input.scope,
      p_bucket_key: input.bucketKey,
      p_window_start: input.windowStart,
      p_window_end: input.windowEnd,
      p_max_leases: input.maxLeases,
      p_min_spacing_ms: input.minSpacingMs,
      p_lease_seconds: input.leaseSeconds,
    });
    if (error !== null) persistenceFailure("reserveQlooLaunch", error.message);
    return parseRpc("reserveQlooLaunch", QlooLaunchReservationSchema, data);
  }

  async releaseQlooLaunch(scope: string, leaseId: string): Promise<QlooLaunchRelease> {
    const { data, error } = await this.#client.rpc("release_qloo_launch", {
      p_scope: scope,
      p_lease_id: leaseId,
    });
    if (error !== null) persistenceFailure("releaseQlooLaunch", error.message);
    return parseRpc("releaseQlooLaunch", QlooLaunchReleaseSchema, data);
  }

  // -------------------------------------------------------------------------
  // Project state writes
  // -------------------------------------------------------------------------

  async confirmProjectAnchor(input: ConfirmAnchorInput): Promise<AnchorConfirmation> {
    const { data, error } = await this.#client.rpc("confirm_project_anchor", {
      p_project_id: input.projectId,
      p_owner_session_id: input.ownerSessionId,
      p_expected_revision: input.expectedRevision,
      p_anchor: input.anchor,
      p_rebranch: input.rebranch,
    });
    if (error !== null) persistenceFailure("confirmProjectAnchor", error.message);
    return parseRpc("confirmProjectAnchor", AnchorConfirmationSchema, data);
  }

  async setProjectReferences(
    input: SetProjectReferencesInput,
  ): Promise<ProjectReferencesUpdate> {
    const { data, error } = await this.#client.rpc("set_project_references", {
      p_project_id: input.projectId,
      p_owner_session_id: input.ownerSessionId,
      p_expected_revision: input.expectedRevision,
      p_anchor_entity_id: input.anchorEntityId,
      p_capture_ids: [...input.captureIds],
    });
    if (error !== null) persistenceFailure("setProjectReferences", error.message);
    return parseRpc("setProjectReferences", ProjectReferencesUpdateSchema, data);
  }

  async setProjectProposalDraft(input: SetProposalDraftInput): Promise<ProposalDraftUpdate> {
    const { data, error } = await this.#client.rpc("set_project_proposal_draft", {
      p_project_id: input.projectId,
      p_owner_session_id: input.ownerSessionId,
      p_expected_revision: input.expectedRevision,
      p_anchor_entity_id: input.anchorEntityId,
      p_draft: input.draft ?? null,
    });
    if (error !== null) persistenceFailure("setProjectProposalDraft", error.message);
    return parseRpc("setProjectProposalDraft", ProposalDraftUpdateSchema, data);
  }
}

/**
 * Builds a fresh gateway over a fresh client.
 *
 * A new instance per request is what makes the persistence claim honest: the
 * live smoke command creates a second gateway and reads back a project written
 * through the first, which is the same thing a new serverless instance or a
 * redeployment does.
 */
export function supabaseGateway(): DataGateway {
  try {
    return new SupabaseGateway(createServerClient());
  } catch (cause) {
    if (cause instanceof ConfigError) {
      throw appErrors.persistenceUnavailable(cause.message);
    }
    throw appErrors.persistenceUnavailable(cause);
  }
}
