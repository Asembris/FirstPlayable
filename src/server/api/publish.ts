/**
 * Publication, revocation, and the public read (specification section 11).
 *
 * ```text
 * POST   /api/projects/:id/publish   preview, or publish what was previewed
 * DELETE /api/publications/:id       owner-only revocation
 * GET    /api/public/:token          whitelisted read-only snapshot
 * ```
 *
 * Three properties carry this surface, and each is a mechanism:
 *
 *   * **Publish what you previewed.** The preview returns the snapshot and its
 *     hash and writes nothing. Publishing requires that hash and refuses unless
 *     it equals the hash of the snapshot the server computes *now*, so a
 *     document that differs in any byte — including the creator's disclosure
 *     choice — cannot be published by accident.
 *   * **One link is one version.** The publication row names a `scene_version_id`
 *     and the snapshot is stored with it, so a link can never come to mean
 *     "whatever is latest". Revising the project does not change what a
 *     published link plays.
 *   * **A read token is not an owner capability.** The public route takes no
 *     session, resolves a hashed 256-bit token, and returns a snapshot that has
 *     no field for a project id, an owner, a brief, a draft, a rejected
 *     proposal, or another version. An unknown token and a revoked one produce
 *     the same answer, so a viewer cannot distinguish "never existed" from
 *     "withdrawn".
 */

import {
  PUBLIC_UNAVAILABLE_MESSAGE,
  type PublicationSummary,
  PublicationSummarySchema,
  type PublicReadResponse,
  PublicSnapshotSchema,
  PublishRequestSchema,
  type PublishResponse,
  type RevokeResponse,
  SHARE_WARNING,
} from "@/domain/publish";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { readVersionRow } from "../db/versions";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
  readJsonBody,
} from "../security/request";
import { readOwnerSecret } from "../security/session";
import { buildPublicSnapshot } from "../publish/snapshot";
import {
  createReadToken,
  hashReadToken,
  isWellFormedReadToken,
  playPathFor,
} from "../publish/token";
import type { RouteDeps } from "./deps";
import { parseProjectId, requireProject, validateBody } from "./shared";

const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/* ------------------------------------------------------- POST .../publish */

export async function handlePublish(
  request: Request,
  deps: RouteDeps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const raw = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input = validateBody(PublishRequestSchema, raw);

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

    // A version awaiting review has not been confirmed by the creator, so it is
    // not publishable. The database refuses it too; this is the readable half.
    if (row.pending_version_id === input.version_id) {
      throw appErrors.refused(
        "That version is still awaiting your review. Confirm it first, then publish it.",
      );
    }

    const version = await readVersionRow(gateway, session, row, input.version_id);
    if (version === null) throw appErrors.notFound();

    const built = buildPublicSnapshot(version, {
      includeProvenance: input.include_provenance,
    });
    if (!built.ok) {
      throw appErrors.refused(
        "That version could not be read back as a publishable document, so nothing was published.",
      );
    }

    if (input.preview) {
      const previewed: PublishResponse = {
        outcome: "previewed",
        snapshot: built.snapshot,
        snapshot_hash: built.hash,
        publication: null,
        play_path: null,
        warning: SHARE_WARNING,
      };
      return json(previewed, requestId);
    }

    if (input.snapshot_hash !== built.hash) {
      throw appErrors.refused(
        "This is not the document that was previewed. Preview it again, then publish it.",
      );
    }

    // Generated here, hashed here, and stored only as a hash. The plaintext is
    // in the response below and nowhere else, ever.
    const token = createReadToken();
    const published = await gateway.publishSceneVersion({
      projectId: id,
      ownerSessionId: session.id,
      expectedRevision: row.revision,
      versionId: input.version_id,
      readTokenHash: hashReadToken(token),
      publicSnapshot: built.snapshot,
    });

    switch (published.outcome) {
      case "not_found":
        throw appErrors.notFound();
      case "not_reviewed":
        throw appErrors.refused(
          "That version is still awaiting your review. Confirm it first, then publish it.",
        );
      case "revision_conflict":
        throw appErrors.rateLimited(
          `Your choices changed while this request was in flight. Reload: the project is now at revision ${published.current_revision}.`,
        );
      default:
        break;
    }

    const summary: PublicationSummary = PublicationSummarySchema.parse({
      id: published.publication.id,
      scene_version_id: published.publication.scene_version_id,
      created_at: published.publication.created_at,
      revoked_at: published.publication.revoked_at,
      provenance_included: input.include_provenance,
    });

    const response: PublishResponse = {
      outcome: "published",
      snapshot: built.snapshot,
      snapshot_hash: built.hash,
      publication: summary,
      play_path: playPathFor(token),
      warning: SHARE_WARNING,
    };
    return json(response, requestId, 201);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/* -------------------------------------------- DELETE /api/publications/:id */

export async function handleRevoke(
  request: Request,
  deps: RouteDeps,
  publicationId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    // A revocation is a mutation, so it goes through the same origin check as
    // every other one. It carries no body.
    assertSameOrigin(request);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    if (!UUID_SHAPE.test(publicationId)) throw appErrors.notFound();

    const revoked = await gateway.revokePublication(publicationId, session.id);
    if (revoked.outcome === "not_found") throw appErrors.notFound();

    const response: RevokeResponse = {
      outcome: revoked.outcome,
      publication: PublicationSummarySchema.parse({
        id: revoked.publication.id,
        scene_version_id: revoked.publication.scene_version_id,
        created_at: revoked.publication.created_at,
        revoked_at: revoked.publication.revoked_at,
        // The listing reads this from the stored snapshot; a revocation does
        // not need to re-read the document to say the link is closed.
        provenance_included: false,
      }),
    };
    return json(response, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

/* ------------------------------------------------- GET /api/public/:token */

/**
 * The public read. No session, no owner, no project.
 *
 * It is never stored by a shared cache. Section 12 allows a revocation window
 * of up to five minutes, but the CDN honours `public, max-age` and kept serving
 * a revoked link for that long, so the answer is `no-store` and revocation
 * takes effect on the next read. Everything else about this route is
 * deliberately boring: one hashed lookup, one contract check, one answer.
 */
export async function handlePublicRead(
  _request: Request,
  deps: RouteDeps,
  token: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    if (!isWellFormedReadToken(token)) return unavailable(requestId);

    const gateway = deps.gateway();
    const read = await gateway.readPublicationByToken(hashReadToken(token));
    if (read.outcome !== "read") return unavailable(requestId);

    // Validated again at load. A stored document that no longer satisfies the
    // contract produces "this playable could not be loaded", never an
    // approximate version (specification section 12).
    const snapshot = PublicSnapshotSchema.safeParse(read.public_snapshot);
    if (!snapshot.success) return unavailable(requestId);

    const response: PublicReadResponse = {
      snapshot: snapshot.data,
      published_at: read.published_at,
    };
    return Response.json(response, {
      status: 200,
      headers: {
        "x-request-id": requestId,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  } catch {
    // Even an internal failure says only this. A public viewer learns nothing
    // about whether a token, a project, or a database exists.
    return unavailable(requestId);
  }
}

function unavailable(requestId: string): Response {
  return Response.json(
    {
      code: "NOT_FOUND",
      message: PUBLIC_UNAVAILABLE_MESSAGE,
      retryable: false,
      last_good_version_id: null,
      request_id: requestId,
    },
    {
      status: 404,
      headers: {
        "x-request-id": requestId,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}

function json(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}
