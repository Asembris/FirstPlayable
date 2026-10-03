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
  projectTitleFor,
  type ProjectView,
  WorkflowStateSchema,
} from "@/domain/project";
import { SLOTS } from "@/domain/limits";
import type { CreateProjectRequest } from "@/domain/project";
import { appErrors } from "../security/errors";
import type { DataGateway, ProjectRow, SessionRow } from "./gateway";

/**
 * Projects the stored row down to the public view.
 *
 * A stored brief that no longer satisfies the authoritative contract is a
 * persistence failure, not something to pass through to the browser: the
 * contract is the same one that validated it on the way in.
 */
export function toProjectView(row: ProjectRow): ProjectView {
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
  return {
    id: row.id,
    title: row.title,
    brief: brief.data,
    revision: row.revision,
    workflow_state: workflowState.data,
    anchor_confirmed: row.anchor !== null && row.anchor !== undefined,
    active_version_id: row.active_version_id,
    approved_slots: [...approvedSlots],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
