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
  type AppendDecisionInput,
  type BudgetReconciliation,
  BudgetReconciliationSchema,
  type BudgetReservation,
  BudgetReservationSchema,
  type CompleteOperationInput,
  type DataGateway,
  type DecisionAppend,
  DecisionAppendSchema,
  type InsertProjectInput,
  type InsertSessionInput,
  type OperationCompletion,
  OperationCompletionSchema,
  type OperationReservation,
  OperationReservationSchema,
  PROJECT_COLUMNS,
  type ProjectRow,
  ProjectRowSchema,
  type ReconcileBudgetInput,
  type ReserveBudgetInput,
  type ReserveOperationInput,
  SESSION_COLUMNS,
  type SessionRow,
  SessionRowSchema,
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
