/**
 * Owner-scoped project repository.
 *
 * Every function here takes an owner session id and passes it to the gateway.
 * That is not a convention to be remembered: the gateway offers no project
 * read without it. The Supabase secret key bypasses row-level security, so
 * this predicate is the real ownership boundary (specification section 12).
 */

import { BriefSchema } from "@/domain/brief";
import {
  AnchorViewSchema,
  type AnchorView,
  projectTitleFor,
  type ProjectView,
  WorkflowStateSchema,
} from "@/domain/project";
import type { ApprovedInfluence } from "@/domain/influence";
import { ConfirmedAnchorSchema } from "@/domain/qloo";
import { SLOTS } from "@/domain/limits";
import type { CreateProjectRequest } from "@/domain/project";
import { proposalsOf, resolveApprovals } from "../influence/approvals";
import { appErrors } from "../security/errors";
import type { DataGateway, ProjectRow, SessionRow } from "./gateway";

/**
 * Projects the stored row down to the public view.
 *
 * A stored brief that no longer satisfies the authoritative contract is a
 * persistence failure, not something to pass through to the browser: the
 * contract is the same one that validated it on the way in.
 */
/**
 * The public anchor, or null.
 *
 * A stored anchor that no longer satisfies the contract reads as "not
 * confirmed" rather than as a partially trusted anchor, because every
 * downstream retrieval is keyed on its entity id.
 */
function toAnchorView(value: unknown): AnchorView | null {
  if (value === null || value === undefined) return null;
  // Parsed against the full stored contract, then narrowed. The view schema is
  // strict, so it would reject the two server-diagnostic fields the stored
  // anchor legitimately carries; dropping them here is what keeps the request
  // fingerprint and the normalizer version out of every response.
  const parsed = ConfirmedAnchorSchema.safeParse(value);
  if (!parsed.success) return null;
  const {
    search_request_fingerprint: _fingerprint,
    normalizer_version: _normalizer,
    ...view
  } = parsed.data;
  const narrowed = AnchorViewSchema.safeParse(view);
  return narrowed.success ? narrowed.data : null;
}

/**
 * Projects the stored row down to the public view.
 *
 * `approvals` is passed in rather than read here, because resolving a slot
 * pointer to its immutable decision row needs the gateway. Callers that have
 * one use {@link readProjectViewForOwner}; the default of no approvals is the
 * honest answer for a caller that has not looked.
 */
export function toProjectView(
  row: ProjectRow,
  approvals: readonly ApprovedInfluence[] = [],
): ProjectView {
  const brief = BriefSchema.safeParse(row.brief);
  if (!brief.success) {
    throw appErrors.persistenceUnavailable("stored brief no longer satisfies the contract");
  }
  const workflowState = WorkflowStateSchema.safeParse(row.workflow_state);
  if (!workflowState.success) {
    throw appErrors.persistenceUnavailable("stored workflow state is not a known state");
  }
  const approvedSlots = SLOTS.filter((slot) => {
    const value = row.active_approvals[slot];
    return typeof value === "string" && value.length > 0;
  });
  const anchor = toAnchorView(row.anchor);
  return {
    id: row.id,
    title: row.title,
    brief: brief.data,
    revision: row.revision,
    workflow_state: workflowState.data,
    anchor_confirmed: anchor !== null,
    anchor,
    active_version_id: row.active_version_id,
    approved_slots: [...approvedSlots],
    approvals: [...approvals],
    proposals: proposalsOf(row),
    reference_capture_ids: [...row.reference_capture_ids].slice(0, 2),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The project view with its current approvals resolved from immutable history.
 * This is what every phase 3 route returns.
 */
export async function readProjectViewForOwner(
  gateway: DataGateway,
  session: SessionRow,
  row: ProjectRow,
): Promise<ProjectView> {
  const approvals = await resolveApprovals(gateway, session, row);
  return toProjectView(row, approvals);
}

/**
 * Creates one project owned by this session.
 *
 * The new project starts with no Qloo capture, no proposal, no approval, no
 * base scene, and no version: phase 2 does not pretend a later phase has run.
 * The daily allowance is counted in the database rather than in process
 * memory, because a serverless instance's memory is not shared state.
 */
export async function createProject(
  gateway: DataGateway,
  session: SessionRow,
  request: CreateProjectRequest,
  options: { projectsPerDay: number; now?: Date },
): Promise<ProjectRow> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const created = await gateway.countProjectsForOwnerSince(session.id, since);
  if (created >= options.projectsPerDay) {
    throw appErrors.rateLimited(
      `This session has created its ${options.projectsPerDay} projects for today. The saved example still plays.`,
    );
  }
  return gateway.insertProject({
    ownerSessionId: session.id,
    title: projectTitleFor(request.brief),
    brief: request.brief,
  });
}

/**
 * Reads one project, owner-scoped.
 *
 * Returns `null` for both a nonexistent project and another owner's project.
 * The caller turns both into the one `NOT_FOUND` envelope, so a probe learns
 * nothing about whether the id exists.
 */
export async function readProjectForOwner(
  gateway: DataGateway,
  session: SessionRow,
  projectId: string,
): Promise<ProjectRow | null> {
  return gateway.findProjectForOwner(projectId, session.id);
}
