/**
 * Reading the current approvals, and the append-only history behind them
 * (specification section 7).
 *
 * Two invariants this module exists to make structural rather than hoped for:
 *
 *   * **An approval is a project pointer into immutable history.**
 *     `projects.active_approvals` maps a slot to one `influence_decisions`
 *     row id. Reading an approval therefore means reading the decision row
 *     that was frozen at the moment the creator clicked approve — not today's
 *     wording, and not a mutated copy. The decision table rejects `UPDATE`.
 *   * **The default approved count is zero.** There is no code path here that
 *     can produce an approval the pointer does not name. A proposal on screen,
 *     a retrieved reference, and an opened card all resolve to nothing.
 *
 * Everything is owner-scoped: the decision read goes through the gateway
 * method that joins the project's owner session id.
 */

import {
  type ApprovedInfluence,
  ApprovedInfluenceSchema,
  type DecisionKind,
  DecisionSnapshotSchema,
  isApprovingKind,
  type ProposalDraft,
  ProposalDraftSchema,
  type ProposedInterpretation,
  type Slot,
} from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import type { DataGateway, InfluenceDecisionRow, ProjectRow, SessionRow } from "../db/gateway";

/** The decision rows of one project, oldest first. Append-only by construction. */
export async function listDecisions(
  gateway: DataGateway,
  session: SessionRow,
  projectId: string,
): Promise<InfluenceDecisionRow[]> {
  return gateway.listInfluenceDecisions(projectId, session.id);
}

/**
 * Rebuilds one frozen approval from its immutable decision row.
 *
 * Returns null — rather than a partially populated approval — when the stored
 * snapshot does not satisfy the authoritative contract, or when the row is not
 * an approving decision at all. A malformed row must not become an approval
 * that a later compiler would trust.
 */
export function approvalFromDecision(
  decision: InfluenceDecisionRow,
): ApprovedInfluence | null {
  if (!isApprovingKind(decision.decision_kind as DecisionKind)) return null;
  if (decision.slot === null) return null;

  const snapshot = DecisionSnapshotSchema.safeParse(decision.proposal_snapshot);
  if (!snapshot.success) return null;
  const frozen = snapshot.data;
  if (frozen.proposal === null) return null;

  // The creator's final wording lives in its own column; the snapshot keeps a
  // copy so a historical view is self-contained. The column wins.
  const approvedText = decision.creator_text ?? frozen.approved_text;
  const intendedEffect = frozen.intended_effect ?? frozen.proposal.intended_interaction;
  if (approvedText === null || approvedText.length === 0) return null;

  const candidate: ApprovedInfluence = {
    approval_id: decision.id,
    slot: decision.slot,
    reference_id: frozen.proposal.reference_id,
    entity_id: frozen.proposal.entity_id,
    reference_name: frozen.proposal.reference_name,
    domain: frozen.proposal.domain,
    capture_id: frozen.proposal.capture_id,
    selected_evidence_ids:
      decision.selected_evidence_ids.length > 0
        ? [...decision.selected_evidence_ids]
        : [...frozen.proposal.selected_evidence_ids],
    approved_text: approvedText,
    intended_effect: intendedEffect,
    proposed_idea: frozen.proposal.idea,
    proposed_interaction: frozen.proposal.intended_interaction,
    proposed_relevance: frozen.proposal.relevance,
    edited_by_creator: frozen.edited_by_creator,
    source_kind: "qloo",
    project_revision: frozen.project_revision,
    predecessor_id: decision.predecessor_id,
    approved_at: decision.created_at,
  };

  const validated = ApprovedInfluenceSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

/** The slot pointers a project currently holds, in a stable slot order. */
export function activeApprovalIds(row: ProjectRow): { slot: Slot; decisionId: string }[] {
  const pointers: { slot: Slot; decisionId: string }[] = [];
  for (const slot of SLOTS) {
    const value = row.active_approvals[slot];
    if (typeof value === "string" && value.length > 0) {
      pointers.push({ slot, decisionId: value });
    }
  }
  return pointers;
}

/**
 * Resolves the project's current approvals.
 *
 * A pointer that does not resolve to a valid approving decision is dropped
 * rather than reported as an approval. That is the conservative direction: the
 * failure mode is "this influence is not approved", never "something is
 * approved and we are not sure what".
 */
export async function resolveApprovals(
  gateway: DataGateway,
  session: SessionRow,
  row: ProjectRow,
): Promise<ApprovedInfluence[]> {
  const pointers = activeApprovalIds(row);
  if (pointers.length === 0) return [];

  const decisions = await listDecisions(gateway, session, row.id);
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));

  const approvals: ApprovedInfluence[] = [];
  for (const pointer of pointers) {
    const decision = byId.get(pointer.decisionId);
    if (decision === undefined) continue;
    const approval = approvalFromDecision(decision);
    if (approval === null || approval.slot !== pointer.slot) continue;
    approvals.push(approval);
  }
  return approvals;
}

/**
 * The project's current proposal draft, or an empty list.
 *
 * A draft that no longer satisfies the contract yields no proposals, which is
 * the honest outcome: the studio then offers to run the proposal stage again
 * rather than rendering something it cannot validate.
 */
export function proposalsOf(row: ProjectRow): ProposedInterpretation[] {
  const draft = proposalDraftOf(row);
  return draft === null ? [] : [...draft.proposals];
}

export function proposalDraftOf(row: ProjectRow): ProposalDraft | null {
  if (row.proposal_draft === null || row.proposal_draft === undefined) return null;
  const parsed = ProposalDraftSchema.safeParse(row.proposal_draft);
  return parsed.success ? parsed.data : null;
}

/**
 * One historical entry for the provenance drawer: every decision, in order,
 * with whether it is the one currently in force.
 */
export type DecisionHistoryEntry = {
  decision_id: string;
  kind: DecisionKind;
  slot: Slot | null;
  reference_name: string | null;
  decided_at: string;
  is_current: boolean;
};

export function decisionHistory(
  row: ProjectRow,
  decisions: readonly InfluenceDecisionRow[],
): DecisionHistoryEntry[] {
  const current = new Set(activeApprovalIds(row).map((pointer) => pointer.decisionId));
  return decisions.map((decision) => {
    const snapshot = DecisionSnapshotSchema.safeParse(decision.proposal_snapshot);
    return {
      decision_id: decision.id,
      kind: decision.decision_kind as DecisionKind,
      slot: decision.slot,
      reference_name: snapshot.success ? (snapshot.data.proposal?.reference_name ?? null) : null,
      decided_at: decision.created_at,
      is_current: current.has(decision.id),
    };
  });
}
