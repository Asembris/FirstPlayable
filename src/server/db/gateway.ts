/**
 * The narrow data gateway every repository talks to.
 *
 * This interface is itself an ownership boundary. There is deliberately **no**
 * `findProjectById`: the only project read takes an owner session id as well,
 * so a repository physically cannot forget the owner predicate. The Supabase
 * secret key bypasses row-level security, so that predicate — not the
 * database's policies — is what keeps one anonymous creator out of another's
 * project (specification section 12).
 *
 * The three RPC results are parsed with the Zod schemas below before any
 * caller sees them. Provider-side shape compliance is not application
 * validation, and a malformed RPC response must fail loudly rather than be
 * read as a grant.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Row projections. Each one is exactly the column set a phase 2 caller needs.
// ---------------------------------------------------------------------------

export const SessionRowSchema = z.object({
  id: z.uuid(),
  owner_secret_hash: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  expires_at: z.string(),
});

export type SessionRow = z.infer<typeof SessionRowSchema>;

/**
 * Note what is absent: `base_scene`. It is a potentially large JSONB document
 * that no phase 2 route returns, so it is not selected at all.
 */
export const ProjectRowSchema = z.object({
  id: z.uuid(),
  owner_session_id: z.uuid(),
  title: z.string(),
  brief: z.unknown(),
  anchor: z.unknown(),
  revision: z.number().int(),
  active_approvals: z.record(z.string(), z.unknown()),
  base_hash: z.string().nullable(),
  active_version_id: z.uuid().nullable(),
  workflow_state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const PROJECT_COLUMNS =
  "id,owner_session_id,title,brief,anchor,revision,active_approvals,base_hash,active_version_id,workflow_state,created_at,updated_at";

export const SESSION_COLUMNS = "id,owner_secret_hash,created_at,last_seen_at,expires_at";

// ---------------------------------------------------------------------------
// Atomic primitive results.
// ---------------------------------------------------------------------------

export const OPERATION_STATUSES = [
  "reserved",
  "running",
  "succeeded",
  "failed",
  "expired",
] as const;

export const OperationSummarySchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  stage: z.string(),
  status: z.enum(OPERATION_STATUSES),
  input_revision: z.number().int(),
  input_hash: z.string(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  idempotency_key: z.string(),
  lease_expires_at: z.string().nullable(),
  result: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type OperationSummary = z.infer<typeof OperationSummarySchema>;

/**
 * `reserved` is the only outcome that authorises an upstream attempt. Every
 * other outcome means the caller must not call a provider.
 */
export const OperationReservationSchema = z.union([
  z.object({ outcome: z.literal("not_found") }),
  z.object({
    outcome: z.literal("reserved"),
    created: z.boolean(),
    recovered_expired_lease: z.boolean().optional(),
    operation: OperationSummarySchema,
  }),
  z.object({
    outcome: z.literal("settled"),
    created: z.boolean(),
    operation: OperationSummarySchema,
  }),
  z.object({
    outcome: z.literal("lease_held"),
    created: z.boolean(),
    operation: OperationSummarySchema,
  }),
  z.object({
    outcome: z.literal("attempts_exhausted"),
    created: z.boolean(),
    operation: OperationSummarySchema,
  }),
]);

export type OperationReservation = z.infer<typeof OperationReservationSchema>;

export const OperationCompletionSchema = z.union([
  z.object({ outcome: z.literal("not_found") }),
  z.object({ outcome: z.literal("settled"), operation: OperationSummarySchema }),
  z.object({ outcome: z.literal("already_settled"), operation: OperationSummarySchema }),
]);

export type OperationCompletion = z.infer<typeof OperationCompletionSchema>;

export const BudgetReservationSchema = z.union([
  z.object({
    granted: z.literal(true),
    lease_id: z.uuid(),
    call_limit: z.number().int(),
    used_calls: z.number().int(),
    reserved_calls: z.number().int(),
    remaining_calls: z.number().int(),
    lease_expires_at: z.string(),
    window_start: z.string(),
    window_end: z.string(),
  }),
  z.object({
    granted: z.literal(false),
    reason: z.literal("budget_exhausted"),
    call_limit: z.number().int(),
    used_calls: z.number().int(),
    reserved_calls: z.number().int(),
    remaining_calls: z.number().int(),
    window_start: z.string(),
    window_end: z.string(),
  }),
]);

export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export const BudgetReconciliationSchema = z.union([
  z.object({
    applied: z.literal(true),
    call_limit: z.number().int(),
    used_calls: z.number().int(),
    used_tokens: z.number().int(),
    reserved_calls: z.number().int(),
    reserved_tokens: z.number().int(),
    remaining_calls: z.number().int(),
  }),
  z.object({ applied: z.literal(false), reason: z.literal("lease_not_found") }),
]);

export type BudgetReconciliation = z.infer<typeof BudgetReconciliationSchema>;

export const DecisionAppendSchema = z.union([
  z.object({ outcome: z.literal("not_found") }),
  z.object({ outcome: z.literal("revision_conflict"), current_revision: z.number().int() }),
  z.object({
    outcome: z.literal("appended"),
    decision_id: z.uuid(),
    created_at: z.string(),
    revision: z.number().int(),
    active_approvals: z.record(z.string(), z.unknown()),
  }),
]);

export type DecisionAppend = z.infer<typeof DecisionAppendSchema>;

// ---------------------------------------------------------------------------
// Call shapes.
// ---------------------------------------------------------------------------

export type InsertSessionInput = { ownerSecretHash: string; expiresAt: string };

export type InsertProjectInput = {
  ownerSessionId: string;
  title: string;
  brief: unknown;
};

export type ReserveOperationInput = {
  projectId: string;
  ownerSessionId: string;
  stage: string;
  inputRevision: number;
  inputHash: string;
  idempotencyKey: string;
  leaseSeconds: number;
  maxAttempts: number;
};

export type CompleteOperationInput = {
  operationId: string;
  ownerSessionId: string;
  status: "succeeded" | "failed";
  result: unknown;
  error: unknown;
};

export type ReserveBudgetInput = {
  scope: string;
  bucketKey: string;
  windowStart: string;
  windowEnd: string;
  callLimit: number;
  calls: number;
  tokens: number;
  leaseSeconds: number;
};

export type ReconcileBudgetInput = {
  leaseId: string;
  actualCalls: number;
  actualTokens: number;
};

export type AppendDecisionInput = {
  projectId: string;
  ownerSessionId: string;
  expectedRevision: number;
  decisionKind: "accept" | "reject" | "edit" | "replace" | "remove";
  slot: "discovery" | "commitment" | null;
  proposalSnapshot: unknown;
  selectedEvidenceIds: readonly string[];
  creatorText: string | null;
  predecessorId: string | null;
};

/**
 * Every method here is owner-scoped or scope-keyed. Adding a method that reads
 * a project, operation, or publication without an owner session id would
 * reintroduce exactly the hole row-level security cannot close for us.
 */
export interface DataGateway {
  insertSession(input: InsertSessionInput): Promise<SessionRow>;
  /** Resolves only a session that has not expired at `now`. */
  findLiveSessionByHash(ownerSecretHash: string, now: string): Promise<SessionRow | null>;
  touchSession(sessionId: string, lastSeenAt: string, expiresAt: string): Promise<void>;
  /** Owner-requested deletion. Cascades to that owner's projects and operations. */
  deleteSession(sessionId: string): Promise<void>;

  insertProject(input: InsertProjectInput): Promise<ProjectRow>;
  findProjectForOwner(projectId: string, ownerSessionId: string): Promise<ProjectRow | null>;
  countProjectsForOwnerSince(ownerSessionId: string, since: string): Promise<number>;

  reserveOperation(input: ReserveOperationInput): Promise<OperationReservation>;
  completeOperation(input: CompleteOperationInput): Promise<OperationCompletion>;

  reserveModelBudget(input: ReserveBudgetInput): Promise<BudgetReservation>;
  reconcileModelBudget(input: ReconcileBudgetInput): Promise<BudgetReconciliation>;
  /** Cleanup for a finished window, and for the live smoke run's own bucket. */
  deleteBudgetBucket(scope: string, bucketKey: string): Promise<void>;

  appendInfluenceDecision(input: AppendDecisionInput): Promise<DecisionAppend>;
}
