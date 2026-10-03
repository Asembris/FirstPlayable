/**
 * `POST /api/projects` and `GET /api/projects/:id` (specification section 11).
 *
 * The mutating route validates, in this order and before any database work:
 * Origin, content type, body size, then the authoritative Zod contract. Only
 * then does it require an owner session and persist.
 *
 * The read route is owner-only and answers `NOT_FOUND` for a nonexistent
 * project, another owner's project, and a malformed id alike, so a probe
 * cannot discover that someone else's project exists.
 */

import { z } from "zod";
import { CreateProjectRequestSchema, type ProjectView } from "@/domain/project";
import { createProject, readProjectForOwner, toProjectView } from "../db/projects";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import type { RouteDeps } from "./deps";

const ProjectIdSchema = z.uuid();

export async function handleCreateProject(
  request: Request,
  deps: RouteDeps,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const body = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);

    const parsed = CreateProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Only the field paths travel into the log, never the submitted values.
      throw appErrors.validationFailed(
        parsed.error.issues.map((issue) => issue.path.join(".")).join(","),
      );
    }

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const row = await createProject(gateway, session, parsed.data, {
      projectsPerDay: deps.budget().projectsPerSessionPerDay,
      now,
    });

    return json(toProjectView(row), requestId, 201);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function handleReadProject(
  request: Request,
  deps: RouteDeps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);

    // A malformed id is answered exactly like a project that is not yours.
    if (!ProjectIdSchema.safeParse(projectId).success) throw appErrors.notFound();

    const row = await readProjectForOwner(gateway, session, projectId);
    if (row === null) throw appErrors.notFound();

    return json(toProjectView(row), requestId, 200);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

function json(project: ProjectView, requestId: string, status: number): Response {
  return Response.json(
    { project },
    {
      status,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    },
  );
}
