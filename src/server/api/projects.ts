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
import {
  CreateProjectRequestSchema,
  type ProjectView,
  type ReferencesView,
} from "@/domain/project";
import {
  createProject,
  readProjectForOwner,
  readProjectViewForOwner,
  toProjectView,
} from "../db/projects";
import {
  listVersionSummaries,
  PUBLICATION_LIST_LIMIT,
  readPlayableForProject,
  readPreviousPlayable,
} from "../db/versions";
import { referencesViewFromProject } from "./qloo";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import type { PlayableView, SceneVersionSummary } from "@/domain/compile";
import { type PublicationSummary, PublicationSummarySchema } from "@/domain/publish";
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

    // The studio's retrieved references come back out of the immutable
    // captures the project points at. A reload therefore costs zero upstream
    // calls, which is a control-flow property rather than a claim.
    const project = await readProjectViewForOwner(gateway, session, row);
    const references = await referencesViewFromProject(gateway, project.reference_capture_ids);

    // From phase 4, the studio also gets the version awaiting review (or the
    // active one) as a whole validated scene. That single payload is what lets
    // every subsequent choice and reset run locally through the Phase 1
    // engine, with no further request of any kind.
    const playable = await readPlayableForProject(gateway, session, row);
    // Phase 5 adds the version this one revised, so the previous/current
    // switch and the same-choices replay run locally too, and the project's
    // share links, so the publish panel can show and revoke them.
    const previous = await readPreviousPlayable(gateway, session, row, playable);
    const versions =
      row.active_version_id === null && row.pending_version_id === null
        ? []
        : await listVersionSummaries(gateway, session, row);
    const publications = await listPublications(gateway, session, row.id);

    return json(
      project,
      requestId,
      200,
      references,
      playable,
      previous,
      versions,
      publications,
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/**
 * The owner's share links for one project.
 *
 * It carries no read token: only the token's hash is stored, and the plaintext
 * was returned exactly once, by the publish that created it.
 */
async function listPublications(
  gateway: ReturnType<RouteDeps["gateway"]>,
  session: { id: string },
  projectId: string,
): Promise<PublicationSummary[]> {
  const read = await gateway.readPublicationsForOwner(
    projectId,
    session.id,
    PUBLICATION_LIST_LIMIT,
  );
  if (read.outcome !== "read") return [];
  return read.publications.flatMap((row) => {
    const parsed = PublicationSummarySchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

function json(
  project: ProjectView,
  requestId: string,
  status: number,
  references: ReferencesView | null = null,
  playable: PlayableView | null = null,
  previousPlayable: PlayableView | null = null,
  versions: readonly SceneVersionSummary[] = [],
  publications: readonly PublicationSummary[] = [],
): Response {
  return Response.json(
    {
      project,
      references,
      playable,
      previous_playable: previousPlayable,
      versions,
      publications,
    },
    {
      status,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    },
  );
}
