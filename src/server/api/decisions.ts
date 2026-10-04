/**
 * `POST /api/projects/:id/decisions` (specification sections 7 and 11).
 *
 * This is the only route in the application that can make something approved,
 * and it only ever does so because the creator said to. Everything upstream —
 * a retrieved reference, a rendered proposal, an opened card — leaves
 * `active_approvals` untouched.
 *
 * The rules this handler enforces, each of them stated in the specification:
 *
 *   * **Default accepted count is zero.** Nothing becomes approved implicitly.
 *   * **At most one approval per slot.** `accept` and `edit` require an empty
 *     slot; filling an occupied one requires the explicit `replace` kind,
 *     which records the displaced approval as its predecessor.
 *   * **Editing changes interpretation, never evidence.** The creator's
 *     wording goes into its own field. The proposal snapshot, and therefore
 *     the Qloo evidence it cites, is written once and never rewritten.
 *   * **Narrowing only.** A creator may cite fewer of the proposal's evidence
 *     items, never more and never another reference's.
 *   * **History is append-only.** Every decision — including a dismissal and a
 *     removal — is one immutable row. The current approval is a project
 *     pointer, so withdrawing one does not delete what was approved before.
 *   * **A stale request cannot land.** The revision compare-and-swap lives in
 *     the database function, not in this handler's head.
 */

import {
  type DecisionsRequest,
  DecisionsRequestSchema,
  type DecisionsResponse,
} from "@/domain/project";
import {
  type DecisionKind,
  type DecisionSnapshot,
  DecisionSnapshotSchema,
  type ProposedInterpretation,
  type Slot,
} from "@/domain/influence";
import { containsLiteralPhrase, isPlainText } from "@/domain/text";
import { activeApprovalIds, proposalDraftOf } from "../influence/approvals";
import { readProjectViewForOwner } from "../db/projects";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import type { DataGateway, DecisionAppend, SessionRow } from "../db/gateway";
import type { Phase3Deps } from "./deps";
import { parseProjectId, requireProject, validateBody } from "./shared";

export async function handleDecisions(
  request: Request,
  deps: Phase3Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input: DecisionsRequest = validateBody(DecisionsRequestSchema, raw);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    const row = await requireProject(gateway, session, id);

    if (row.revision !== input.expected_revision) {
      throw appErrors.rateLimited(
        `Your choices changed while this request was in flight. Reload: the project is now at revision ${row.revision}.`,
      );
    }

    const occupied = new Map(
      activeApprovalIds(row).map((pointer) => [pointer.slot, pointer.decisionId]),
    );
    const brief = (await readProjectViewForOwner(gateway, session, row)).brief;

    // -----------------------------------------------------------------------
    // remove: withdraw the approval a slot currently holds
    // -----------------------------------------------------------------------
    if (input.kind === "remove") {
      const current = occupied.get(input.slot);
      if (current === undefined) {
        throw appErrors.validationFailed(`the ${input.slot} slot holds no approval`);
      }
      const snapshot = removalSnapshot(input.slot, row.revision, now);
      const appended = await gateway.appendInfluenceDecision({
        projectId: id,
        ownerSessionId: session.id,
        expectedRevision: row.revision,
        decisionKind: "remove",
        slot: input.slot,
        proposalSnapshot: snapshot,
        selectedEvidenceIds: [],
        creatorText: null,
        predecessorId: current,
      });
      return respond(appended, "remove", current, gateway, session, id, requestId);
    }

    // -----------------------------------------------------------------------
    // Everything else names a proposal from the project's current draft
    // -----------------------------------------------------------------------
    const draft = proposalDraftOf(row);
    const proposal = draft?.proposals.find(
      (candidate) => candidate.proposal_id === input.proposal_id,
    );
    if (proposal === undefined) {
      throw appErrors.validationFailed(
        "that proposal is not in this project's current proposal set",
      );
    }

    // -----------------------------------------------------------------------
    // reject: dismiss a proposal, without touching any approval
    // -----------------------------------------------------------------------
    if (input.kind === "reject") {
      const snapshot = decisionSnapshot({
        kind: "reject",
        proposal,
        slot: proposal.slot,
        approvedText: null,
        intendedEffect: null,
        editedByCreator: false,
        revision: row.revision,
        now,
      });
      const appended = await gateway.appendInfluenceDecision({
        projectId: id,
        ownerSessionId: session.id,
        expectedRevision: row.revision,
        decisionKind: "reject",
        // Null on purpose: a dismissal must not clear an approval the creator
        // already made for this slot.
        slot: null,
        proposalSnapshot: snapshot,
        selectedEvidenceIds: [],
        creatorText: null,
        predecessorId: null,
      });
      return respond(appended, "reject", null, gateway, session, id, requestId);
    }

    // -----------------------------------------------------------------------
    // accept / edit / replace
    // -----------------------------------------------------------------------
    const slot: Slot = input.slot ?? proposal.slot;
    const current = occupied.get(slot) ?? null;

    if (input.kind === "replace" && current === null) {
      throw appErrors.validationFailed(
        `the ${slot} slot holds no approval, so there is nothing to replace`,
      );
    }
    if (input.kind !== "replace" && current !== null) {
      // The one-approval-per-slot rule, made explicit rather than merged.
      throw appErrors.validationFailed(
        `the ${slot} slot already holds an approval; replacing it is an explicit choice`,
      );
    }

    const evidenceIds = narrowedEvidence(input.selected_evidence_ids, proposal);
    const approvedText = (input.kind === "accept" ? undefined : input.approved_text) ?? proposal.idea;
    const intendedEffect =
      (input.kind === "accept" ? undefined : input.intended_effect) ??
      proposal.intended_interaction;

    assertCreatorText("approved_text", approvedText, brief.forbidden_wording);
    assertCreatorText("intended_effect", intendedEffect, brief.forbidden_wording);

    const editedByCreator =
      approvedText.trim() !== proposal.idea.trim() ||
      intendedEffect.trim() !== proposal.intended_interaction.trim();

    const kind: DecisionKind =
      input.kind === "replace" ? "replace" : editedByCreator ? "edit" : "accept";

    const snapshot = decisionSnapshot({
      kind,
      proposal,
      slot,
      approvedText: approvedText.trim(),
      intendedEffect: intendedEffect.trim(),
      editedByCreator,
      revision: row.revision,
      now,
    });

    const appended = await gateway.appendInfluenceDecision({
      projectId: id,
      ownerSessionId: session.id,
      expectedRevision: row.revision,
      decisionKind: kind,
      slot,
      proposalSnapshot: snapshot,
      selectedEvidenceIds: evidenceIds,
      creatorText: approvedText.trim(),
      predecessorId: current,
    });

    return respond(appended, kind, current, gateway, session, id, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function decisionSnapshot(input: {
  kind: DecisionKind;
  proposal: ProposedInterpretation;
  slot: Slot;
  approvedText: string | null;
  intendedEffect: string | null;
  editedByCreator: boolean;
  revision: number;
  now: Date;
}): DecisionSnapshot {
  return DecisionSnapshotSchema.parse({
    kind: input.kind,
    // Frozen exactly as shown. Editing changes the creator's wording beside
    // this snapshot, never the snapshot or the Qloo evidence inside it.
    proposal: input.proposal,
    proposed_slot: input.proposal.slot,
    approved_text: input.approvedText,
    intended_effect: input.intendedEffect,
    edited_by_creator: input.editedByCreator,
    source_kind: "qloo",
    decided_at: input.now.toISOString(),
    project_revision: input.revision,
  } satisfies DecisionSnapshot);
}

function removalSnapshot(slot: Slot, revision: number, now: Date): DecisionSnapshot {
  return DecisionSnapshotSchema.parse({
    kind: "remove",
    proposal: null,
    proposed_slot: slot,
    approved_text: null,
    intended_effect: null,
    edited_by_creator: false,
    source_kind: "qloo",
    decided_at: now.toISOString(),
    project_revision: revision,
  } satisfies DecisionSnapshot);
}

/**
 * A creator-supplied evidence list may only *narrow* the proposal's own
 * citations. An id outside them is refused rather than dropped, so an approval
 * can never end up citing evidence the proposal did not.
 */
function narrowedEvidence(
  requested: readonly string[] | undefined,
  proposal: ProposedInterpretation,
): string[] {
  if (requested === undefined) return [...proposal.selected_evidence_ids];
  const owned = new Set(proposal.selected_evidence_ids);
  for (const id of requested) {
    if (!owned.has(id)) {
      throw appErrors.validationFailed(
        "an approval may cite fewer of the proposal's evidence items, never others",
      );
    }
  }
  const unique = [...new Set(requested)];
  if (unique.length === 0) {
    throw appErrors.validationFailed("an approval must cite at least one evidence item");
  }
  return unique;
}

/**
 * Bounds on creator wording.
 *
 * The brief's own forbidden wording is enforced, because it is a constraint
 * the creator declared and the scene will inherit. The false-attribution
 * phrase list that constrains *model* output is deliberately not applied
 * here: this text is rendered under "Creator approved", attributed to the
 * creator, so blocking their wording would be the application putting words in
 * their mouth rather than preventing a false claim of its own.
 */
function assertCreatorText(
  field: string,
  value: string,
  forbidden: readonly string[],
): void {
  if (value.trim().length === 0) {
    throw appErrors.validationFailed(`${field} is empty`);
  }
  if (!isPlainText(value)) {
    throw appErrors.validationFailed(`${field} contains control characters`);
  }
  for (const phrase of forbidden) {
    if (containsLiteralPhrase(value, phrase)) {
      throw appErrors.validationFailed(`${field} uses wording this brief forbids`);
    }
  }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

async function respond(
  appended: DecisionAppend,
  kind: DecisionKind,
  replacedApprovalId: string | null,
  gateway: DataGateway,
  session: SessionRow,
  projectId: string,
  requestId: string,
): Promise<Response> {
  switch (appended.outcome) {
    case "not_found":
      throw appErrors.notFound();
    case "revision_conflict":
      throw appErrors.rateLimited(
        `Your choices changed while this request was in flight. Reload: the project is now at revision ${appended.current_revision}.`,
      );
    case "appended":
      break;
  }

  const row = await requireProject(gateway, session, projectId);
  const project = await readProjectViewForOwner(gateway, session, row);

  const response: DecisionsResponse = {
    project,
    decision_id: appended.decision_id,
    kind,
    replaced_approval_id: kind === "replace" ? replacedApprovalId : null,
  };
  return Response.json(response, {
    status: 200,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
