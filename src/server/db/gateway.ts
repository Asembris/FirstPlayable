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
 * that no phase 2 or phase 3 route returns, so it is not selected at all.
 *
 * Phase 3 adds `reference_capture_ids` and `proposal_draft`, both of which the
 * studio genuinely needs in order to re-render a creator's retrieved
 * references and current proposals after a reload.
 */
export const ProjectRowSchema = z.object({
  id: z.uuid(),
  owner_session_id: z.uuid(),
  title: z.string(),
  brief: z.unknown(),
  anchor: z.unknown(),
  revision: z.number().int(),
  reference_capture_ids: z.array(z.uuid()),
  active_approvals: z.record(z.string(), z.unknown()),
  proposal_draft: z.unknown(),
  base_hash: z.string().nullable(),
  active_version_id: z.uuid().nullable(),
  workflow_state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProjectRow = z.infer<typeof ProjectRowSchema>;

export const PROJECT_COLUMNS =
  "id,owner_session_id,title,brief,anchor,revision,reference_capture_ids,active_approvals,proposal_draft,base_hash,active_version_id,workflow_state,created_at,updated_at";

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
// Phase 3: Qloo captures, the launch policy, and project state writes.
// ---------------------------------------------------------------------------

/**
 * One immutable capture row. The contents never change after insert — the
 * phase 2 trigger rejects `UPDATE` on this table — so an expired cache lookup
 * is not deletion of evidence a decision depends on.
 */
export const QlooCaptureRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["search", "movies", "videogames"]),
  request_fingerprint: z.string(),
  normalized_query: z.string().nullable(),
  artist_entity_id: z.string().nullable(),
  domain: z.enum(["movie", "videogame"]).nullable(),
  results: z.unknown(),
  quota_diagnostics: z.unknown(),
  normalizer_version: z.string(),
  captured_at: z.string(),
  cache_expires_at: z.string(),
});

export type QlooCaptureRow = z.infer<typeof QlooCaptureRowSchema>;

export const QLOO_CAPTURE_COLUMNS =
  "id,kind,request_fingerprint,normalized_query,artist_entity_id,domain,results,quota_diagnostics,normalizer_version,captured_at,cache_expires_at";

/** One immutable decision row, as the provenance drawer and approvals read it. */
export const InfluenceDecisionRowSchema = z.object({
  id: z.uuid(),
  project_id: z.uuid(),
  decision_kind: z.enum(["accept", "reject", "edit", "replace", "remove"]),
  slot: z.enum(["discovery", "commitment"]).nullable(),
  proposal_snapshot: z.unknown(),
  selected_evidence_ids: z.array(z.string()),
  creator_text: z.string().nullable(),
  predecessor_id: z.uuid().nullable(),
  created_at: z.string(),
});

export type InfluenceDecisionRow = z.infer<typeof InfluenceDecisionRowSchema>;

export const INFLUENCE_DECISION_COLUMNS =
  "id,project_id,decision_kind,slot,proposal_snapshot,selected_evidence_ids,creator_text,predecessor_id,created_at";

/**
 * The global Qloo launch decision. A refusal is a normal outcome carrying the
 * exact wait the policy requires, not an error.
 */
export const QlooLaunchReservationSchema = z.union([
  z.object({
    granted: z.literal(true),
    lease_id: z.uuid(),
    active_leases: z.number().int(),
    max_leases: z.number().int(),
    lease_expires_at: z.string(),
    launched_at: z.string(),
  }),
  z.object({
    granted: z.literal(false),
    reason: z.enum(["concurrency", "spacing"]),
    active_leases: z.number().int(),
    max_leases: z.number().int(),
    retry_after_ms: z.number().int().nonnegative(),
  }),
]);

export type QlooLaunchReservation = z.infer<typeof QlooLaunchReservationSchema>;

export const QlooLaunchReleaseSchema = z.union([
  z.object({ released: z.literal(true), active_leases: z.number().int() }),
  z.object({ released: z.literal(false), reason: z.literal("lease_not_found") }),
]);

export type QlooLaunchRelease = z.infer<typeof QlooLaunchReleaseSchema>;

export const AnchorConfirmationSchema = z.union([
  z.object({ outcome: z.literal("not_found") }),
  z.object({ outcome: z.literal("revision_conflict"), current_revision: z.number().int() }),
  z.object({
    outcome: z.literal("rebranch_required"),
    current_revision: z.number().int(),
    previous_entity_id: z.string(),
    occupied_slots: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal("confirmed"),
    revision: z.number().int(),
    anchor_entity_id: z.string(),
    invalidated: z.boolean(),
    cleared_slots: z.array(z.string()),
  }),
]);

export type AnchorConfirmation = z.infer<typeof AnchorConfirmationSchema>;

export const ProjectReferencesUpdateSchema = z.union([
  z.object({ outcome: z.literal("not_found") }),
  z.object({ outcome: z.literal("revision_conflict"), current_revision: z.number().int() }),
  z.object({ outcome: z.literal("anchor_mismatch") }),
  z.object({
    outcome: z.literal("updated"),
    revision: z.number().int(),
    capture_ids: z.array(z.uuid()),
  }),
]);

export type ProjectReferencesUpdate = z.infer<typeof ProjectReferencesUpdateSchema>;

export const ProposalDraftUpdateSchema = z.union([
  z.object({ outcome: z.literal("not_found") }),
  z.object({ outcome: z.literal("revision_conflict"), current_revision: z.number().int() }),
  z.object({ outcome: z.literal("anchor_mismatch") }),
  z.object({ outcome: z.literal("updated"), revision: z.number().int() }),
]);

export type ProposalDraftUpdate = z.infer<typeof ProposalDraftUpdateSchema>;

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

export type InsertQlooCaptureInput = {
  kind: "search" | "movies" | "videogames";
  requestFingerprint: string;
  normalizedQuery: string | null;
  artistEntityId: string | null;
  domain: "movie" | "videogame" | null;
  results: unknown;
  quotaDiagnostics: unknown;
  normalizerVersion: string;
  cacheExpiresAt: string;
};

export type ReserveQlooLaunchInput = {
  scope: string;
  bucketKey: string;
  windowStart: string;
  windowEnd: string;
  maxLeases: number;
  minSpacingMs: number;
  leaseSeconds: number;
};

export type ConfirmAnchorInput = {
  projectId: string;
  ownerSessionId: string;
  expectedRevision: number;
  anchor: unknown;
  /** True only when the creator explicitly accepted invalidating existing work. */
  rebranch: boolean;
};

export type SetProjectReferencesInput = {
  projectId: string;
  ownerSessionId: string;
  expectedRevision: number;
  anchorEntityId: string;
  captureIds: readonly string[];
};

export type SetProposalDraftInput = {
  projectId: string;
  ownerSessionId: string;
  expectedRevision: number;
  anchorEntityId: string;
  draft: unknown;
};

/**
 * Every method here is owner-scoped or scope-keyed. Adding a method that reads
 * a project, operation, or publication without an owner session id would
 * reintroduce exactly the hole row-level security cannot close for us.
 *
 * The two capture reads are the deliberate exception, and they are safe for a
 * specific reason: a `qloo_captures` row is *not* owner data. It is a
 * normalized excerpt of a public catalogue response, keyed by a request
 * fingerprint nobody can forge into someone else's private state, and it
 * carries no project id, session id, creator text, or decision. Sharing a
 * capture between two creators who confirmed the same artist is exactly what
 * makes "a cache hit costs zero upstream calls" true.
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
  /** Append-only history for one project, oldest first. Owner-scoped. */
  listInfluenceDecisions(
    projectId: string,
    ownerSessionId: string,
  ): Promise<InfluenceDecisionRow[]>;

  /** Exact cache lookup by request fingerprint. */
  findQlooCaptureByFingerprint(fingerprint: string): Promise<QlooCaptureRow | null>;
  /** Several fingerprints in one round trip, for the two parallel first hops. */
  findQlooCapturesByFingerprints(
    fingerprints: readonly string[],
  ): Promise<QlooCaptureRow[]>;
  /** The newest capture for one exact artist and domain, for a stale fallback. */
  findLatestQlooCapture(
    artistEntityId: string,
    domain: "movie" | "videogame",
  ): Promise<QlooCaptureRow | null>;
  /** Captures a frozen decision still points at, read by id regardless of TTL. */
  findQlooCapturesByIds(ids: readonly string[]): Promise<QlooCaptureRow[]>;
  /** Immutable insert. A concurrent writer's row for the same key is returned. */
  insertQlooCapture(input: InsertQlooCaptureInput): Promise<QlooCaptureRow>;

  /** The global launch policy. `granted: false` is a normal, waitable outcome. */
  reserveQlooLaunch(input: ReserveQlooLaunchInput): Promise<QlooLaunchReservation>;
  releaseQlooLaunch(scope: string, leaseId: string): Promise<QlooLaunchRelease>;

  confirmProjectAnchor(input: ConfirmAnchorInput): Promise<AnchorConfirmation>;
  setProjectReferences(input: SetProjectReferencesInput): Promise<ProjectReferencesUpdate>;
  setProjectProposalDraft(input: SetProposalDraftInput): Promise<ProposalDraftUpdate>;
}
