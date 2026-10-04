/**
 * The three retrieval routes of specification section 11:
 *
 * ```text
 * POST /api/projects/:id/artist-search   cached typed artist search
 * PUT  /api/projects/:id/anchor          confirm one result from that snapshot
 * POST /api/projects/:id/references      the two allowed first hops
 * ```
 *
 * Each one runs the same phase 2 gauntlet before touching anything: Origin,
 * content type, body cap, then the authoritative Zod contract, then the owner
 * session, then the owner-scoped project read. A foreign project and a
 * nonexistent one produce the identical `NOT_FOUND` envelope.
 *
 * None of these is a Qloo proxy. The search route accepts one field — a query
 * string — and the references route accepts none at all beyond a revision and
 * a consent flag. The domain, the entity type, the take, and the URL are
 * compiled into the adapter. A creator cannot reach a fourth Qloo operation
 * through any of them.
 *
 * The anchor route is where identity is actually decided, and it is
 * deliberately paranoid: the creator names a capture and an entity id, and the
 * server copies every other anchor field out of that stored capture. A forged
 * name, description, rank, or hint in the request body is not read, so no
 * request can install an artist this application never retrieved.
 */

import {
  ArtistSearchRequestSchema,
  ConfirmAnchorRequestSchema,
  type DomainRowView,
  type ProjectView,
  type ReferencesRequest,
  ReferencesRequestSchema,
  type ReferencesResponse,
  type ReferencesView,
  type SkipReasonSchema,
} from "@/domain/project";
import {
  type ConfirmedAnchor,
  DISPLAYED_USABLE_PER_DOMAIN,
  QLOO_DOMAINS,
  type QlooDomain,
  QLOO_NORMALIZER_VERSION,
  toPublicCandidate,
} from "@/domain/qloo";
import type { z } from "zod";
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
import {
  readArtistSearchById,
  readArtistSearchCache,
  readCapturesByIds,
  writeArtistSearchCapture,
} from "../qloo/cache";
import {
  databaseLaunchGuard,
  observedQuotaWithinReserve,
  quotaReserveError,
  reconcileQlooCalls,
  reserveQlooCalls,
} from "../qloo/limiter";
import { MAX_ATTEMPTS_PER_CALL, QlooError, resolveArtist } from "../qloo/client";
import { artistSearchFingerprint, normalizeQuery } from "../qloo/normalize";
import {
  anyDomainUsable,
  captureIdsOf,
  type DomainOutcome,
  retrieveReferences,
} from "../qloo/references";
import type { DataGateway } from "../db/gateway";
import type { Phase3Deps } from "./deps";
import { parseProjectId, requireProject, validateBody } from "./shared";

// ---------------------------------------------------------------------------
// POST /api/projects/:id/artist-search
// ---------------------------------------------------------------------------

/**
 * One cached artist search.
 *
 * Returns candidates, never a selection: the response carries every returned
 * artist in the order Qloo returned them, and the project is unchanged. Choosing
 * is a separate, explicit request to the anchor route.
 */
export async function handleArtistSearch(
  request: Request,
  deps: Phase3Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const body = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input = validateBody(ArtistSearchRequestSchema, body);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const row = await requireProject(gateway, session, parseProjectId(projectId));

    const env = deps.qlooEnv();
    const config = deps.qloo();
    const query = input.query.trim();
    const normalizedQuery = normalizeQuery(query);
    const fingerprint = artistSearchFingerprint({ host: env.host, normalizedQuery });

    let snapshot = await readArtistSearchCache(gateway, fingerprint, now);

    if (snapshot === null) {
      // One search, one retry at most. The reservation covers both, because a
      // retry consumes quota just as the first attempt does.
      const reservation = await reserveQlooCalls(gateway, config, {
        calls: MAX_ATTEMPTS_PER_CALL,
        now,
      });
      if (!reservation.granted) {
        throw appErrors.budgetExhausted(
          "This application is holding back its remaining Qloo calls as a reserve. " +
            "Artist search is paused until the window resets. The saved example still plays.",
        );
      }

      let spent = 0;
      try {
        const result = await resolveArtist(query, {
          env,
          launch:
            deps.launchGuard?.(gateway, config) ??
            databaseLaunchGuard(gateway, config, { now: () => now }),
          now: () => now,
          onQuota: (quota) => {
            if (observedQuotaWithinReserve(quota, config)) deps.onReserveReached?.();
          },
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        });
        spent = result.diagnostics.attempts;
        // The search has already happened, so its result is kept. The reserve
        // signal blocks what comes next, not what was just paid for.
        snapshot = await writeArtistSearchCapture(
          gateway,
          result.snapshot,
          result.diagnostics.quota,
          now,
        );
      } catch (cause) {
        if (cause instanceof QlooError) spent = cause.attempts;
        throw cause;
      } finally {
        await reconcileQlooCalls(gateway, reservation.lease_id, spent);
      }
    }

    const project = await readProjectViewForOwner(gateway, session, row);
    return json({ search: snapshot, project }, requestId, 200);
  } catch (error) {
    return errorResponse(toPublicError(error), requestId);
  }
}

// ---------------------------------------------------------------------------
// PUT /api/projects/:id/anchor
// ---------------------------------------------------------------------------

/**
 * Freezes the artist the creator explicitly chose.
 *
 * The one piece of creator input that matters is `entity_id`, and it is only
 * accepted if it appears in the capture the request names. Everything else is
 * copied from that capture's candidate, including the rank at which it was
 * returned, so the provenance line "chosen from result 3 of 5, retrieved on
 * this date" is verifiable rather than asserted.
 */
export async function handleConfirmAnchor(
  request: Request,
  deps: Phase3Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const body = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input = validateBody(ConfirmAnchorRequestSchema, body);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    await requireProject(gateway, session, id);

    const snapshot = await readArtistSearchById(gateway, input.search_capture_id);
    if (snapshot === null) {
      throw appErrors.validationFailed("the named search snapshot does not exist");
    }

    const chosen = snapshot.candidates.find(
      (candidate) => candidate.entity_id === input.entity_id,
    );
    if (chosen === undefined) {
      // The creator can only confirm something this application retrieved.
      throw appErrors.validationFailed(
        "that artist is not one of the results in the named search snapshot",
      );
    }

    const anchor: ConfirmedAnchor = {
      entity_id: chosen.entity_id,
      name: chosen.name,
      short_description: chosen.short_description,
      disambiguation: chosen.disambiguation,
      identity_hints: [...chosen.identity_hints],
      query: snapshot.query,
      normalized_query: snapshot.normalized_query,
      search_capture_id: snapshot.capture_id,
      search_request_fingerprint: snapshot.request_fingerprint,
      original_rank: chosen.original_rank,
      normalizer_version: QLOO_NORMALIZER_VERSION,
      confirmed_at: now.toISOString(),
    };

    const confirmation = await gateway.confirmProjectAnchor({
      projectId: id,
      ownerSessionId: session.id,
      expectedRevision: input.expected_revision,
      anchor,
      rebranch: input.rebranch === true,
    });

    switch (confirmation.outcome) {
      case "not_found":
        throw appErrors.notFound();
      case "revision_conflict":
        throw revisionConflict(confirmation.current_revision);
      case "rebranch_required":
        throw appErrors.rateLimited(
          "Confirming a different artist would discard the influences you approved for " +
            `${confirmation.occupied_slots.join(" and ") || "this project"}. ` +
            "Confirm again to invalidate that work explicitly.",
        );
      case "confirmed":
        break;
    }

    const row = await requireProject(gateway, session, id);
    const project = await readProjectViewForOwner(gateway, session, row);
    return json(
      {
        project,
        invalidated: confirmation.invalidated,
        cleared_slots: confirmation.cleared_slots,
      },
      requestId,
      200,
    );
  } catch (error) {
    return errorResponse(toPublicError(error), requestId);
  }
}

// ---------------------------------------------------------------------------
// POST /api/projects/:id/references
// ---------------------------------------------------------------------------

/**
 * Retrieves, or re-reads, the two first hops for the confirmed anchor.
 *
 * Both domains are attempted in parallel under the global limiter, and each is
 * settled on its own: one failing never destroys the other. When neither
 * domain can support a proposal, `any_usable` is false and the studio shows
 * "No supported influences available for this artist" instead of anything
 * fabricated.
 */
export async function handleReferences(
  request: Request,
  deps: Phase3Deps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    const body = await readJsonBody(request, CREATOR_COMMAND_BODY_LIMIT_BYTES);
    const input: ReferencesRequest = validateBody(ReferencesRequestSchema, body);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    const row = await requireProject(gateway, session, id);

    if (row.revision !== input.expected_revision) throw revisionConflict(row.revision);

    const anchorEntityId = anchorEntityIdOf(row.anchor);
    if (anchorEntityId === null) {
      throw appErrors.validationFailed("confirm an artist before retrieving references");
    }

    const result = await retrieveReferences({
      gateway,
      config: deps.qloo(),
      env: deps.qlooEnv(),
      artistEntityId: anchorEntityId,
      acceptStale: input.accept_stale === true,
      now,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.launchGuard === undefined
        ? {}
        : { launch: deps.launchGuard(gateway, deps.qloo()) }),
    });

    const update = await gateway.setProjectReferences({
      projectId: id,
      ownerSessionId: session.id,
      expectedRevision: input.expected_revision,
      anchorEntityId,
      captureIds: captureIdsOf(result.outcomes),
    });

    switch (update.outcome) {
      case "not_found":
        throw appErrors.notFound();
      case "revision_conflict":
        throw revisionConflict(update.current_revision);
      case "anchor_mismatch":
        // The project confirmed a different artist while this ran. The
        // captures stay in the database; they are simply not attached.
        throw appErrors.rateLimited(
          "The confirmed artist changed while these references were being retrieved. Reload and try again.",
        );
      case "updated":
        break;
    }

    const refreshed = await requireProject(gateway, session, id);
    const project = await readProjectViewForOwner(gateway, session, refreshed);

    const response: ReferencesResponse = {
      project,
      references: toReferencesView(result.outcomes),
      upstream_calls: result.upstream_calls,
    };
    if (result.reserve_reached) deps.onReserveReached?.();
    return json(response, requestId, 200);
  } catch (error) {
    return errorResponse(toPublicError(error), requestId);
  }
}

// ---------------------------------------------------------------------------
// Views and helpers
// ---------------------------------------------------------------------------

type SkipReason = z.infer<typeof SkipReasonSchema>;

/**
 * Builds one domain row.
 *
 * Only the first three usable candidates carry evidence. Every other returned
 * row becomes a compact skipped line that keeps its original rank, so the
 * ranking and its gaps are visible without shipping ten evidence sets to the
 * browser. Affinity is stripped on the way out.
 */
export function toDomainRowView(domain: QlooDomain, outcome: DomainOutcome): DomainRowView {
  if (outcome.status === "unavailable") {
    return {
      domain,
      status: "unavailable",
      cache: null,
      capture_id: null,
      retrieved_at: null,
      displayed: [],
      skipped: [],
      returned_count: 0,
      usable_count: 0,
      stale_captured_at: null,
      failure_code: outcome.code,
    };
  }

  const capture = outcome.capture;
  const usable = capture.candidates.filter((candidate) => candidate.usable);
  const displayed = usable.slice(0, DISPLAYED_USABLE_PER_DOMAIN);
  const displayedIds = new Set(displayed.map((candidate) => candidate.reference_id));

  const skipped = capture.candidates
    .filter((candidate) => !displayedIds.has(candidate.reference_id))
    .map((candidate) => ({
      original_rank: candidate.original_rank,
      name: candidate.name,
      reason: (candidate.usable ? "beyond_display_limit" : "no_usable_context") as SkipReason,
    }));

  return {
    domain,
    status: "ready",
    cache: capture.cache,
    capture_id: capture.capture_id,
    retrieved_at: capture.retrieved_at,
    displayed: displayed.map(toPublicCandidate),
    skipped,
    returned_count: capture.candidates.length,
    usable_count: usable.length,
    stale_captured_at: capture.cache === "stale" ? capture.retrieved_at : null,
    failure_code: null,
  };
}

export function toReferencesView(
  outcomes: Record<QlooDomain, DomainOutcome>,
): ReferencesView {
  return {
    movie: toDomainRowView("movie", outcomes.movie),
    videogame: toDomainRowView("videogame", outcomes.videogame),
    any_usable: anyDomainUsable(outcomes),
  };
}

/**
 * Rebuilds the two domain rows from the captures a project already points at.
 *
 * This is what makes a reload cost nothing: the studio's references come back
 * out of the immutable captures, with no lookup, no TTL check, and no upstream
 * call. A capture a decision depends on is readable here regardless of its
 * cache expiry.
 */
export async function referencesViewFromProject(
  gateway: DataGateway,
  captureIds: readonly string[],
): Promise<ReferencesView | null> {
  if (captureIds.length === 0) return null;
  const captures = await readCapturesByIds(gateway, captureIds);
  if (captures.length === 0) return null;

  const outcomes: Record<QlooDomain, DomainOutcome> = {
    movie: { status: "unavailable", code: "QLOO_EMPTY" },
    videogame: { status: "unavailable", code: "QLOO_EMPTY" },
  };
  for (const capture of captures) {
    outcomes[capture.domain] = { status: "ready", capture };
  }
  return toReferencesView(outcomes);
}

export function anchorEntityIdOf(anchor: unknown): string | null {
  if (typeof anchor !== "object" || anchor === null) return null;
  const value = (anchor as { entity_id?: unknown }).entity_id;
  return typeof value === "string" && value.length > 0 ? value.toUpperCase() : null;
}

function revisionConflict(currentRevision: number): Error {
  return appErrors.rateLimited(
    `Your choices changed while this request was in flight. Reload: the project is now at revision ${currentRevision}.`,
  );
}

/**
 * Maps an adapter failure to the envelope the browser sees.
 *
 * A `QlooError` carries this application's own stable code, never a provider
 * header or body, but it is still mapped rather than returned so the response
 * cannot acquire a field the frozen envelope does not have.
 */
function toPublicError(error: unknown): unknown {
  if (!(error instanceof QlooError)) return error;
  switch (error.code) {
    case "QLOO_UNAUTHORIZED":
    case "QLOO_BAD_REQUEST":
      // A configuration or contract fault on our side, not the creator's.
      return appErrors.persistenceUnavailable(error.code);
    case "QLOO_QUOTA_RESERVED":
      try {
        quotaReserveError();
      } catch (reserve) {
        return reserve;
      }
      return error;
    case "QLOO_LAUNCH_UNAVAILABLE":
      return appErrors.rateLimited(
        "Retrieval is queued behind other requests right now. Try again in a moment.",
      );
    case "QLOO_RATE_LIMITED":
      return appErrors.rateLimited(
        "The reference service asked us to slow down. Try again in a moment.",
      );
    default:
      return appErrors.persistenceUnavailable(error.code);
  }
}

function json(body: unknown, requestId: string, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

/** Re-exported so a route file does not need a second import path. */
export type { ProjectView };
export { QLOO_DOMAINS };
