/**
 * `POST /api/session` — establish or resume the anonymous owner cookie.
 *
 * No upstream request, no model call, no Qloo call (specification section 11).
 * It is still a mutating route, so it validates Origin, requires a JSON content
 * type, and caps the body before doing anything else.
 */

import type { SessionResponse } from "@/domain/project";
import {
  establishOwnerSession,
  refreshOwnerActivity,
  resolveOwnerSession,
} from "../db/sessions";
import { errorResponse, newRequestId } from "../security/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  readJsonBody,
  SESSION_BODY_LIMIT_BYTES,
} from "../security/request";
import { ownerCookieHeader, readOwnerSecret } from "../security/session";
import type { RouteDeps } from "./deps";

export async function handleCreateSession(
  request: Request,
  deps: RouteDeps,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    assertSameOrigin(request);
    assertJsonContentType(request);
    // The body carries nothing. Reading it still enforces the cap and the
    // JSON contract, so a malformed or oversized request fails here.
    await readJsonBody(request, SESSION_BODY_LIMIT_BYTES);

    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const presented = readOwnerSecret(request);
    const existing = await resolveOwnerSession(gateway, presented, now);

    if (existing !== null && presented !== null) {
      // Resume. The same secret is re-issued so a long-lived owner's cookie
      // keeps a full window, and the stored expiry is refreshed when stale.
      const expiresAt = await refreshOwnerActivity(gateway, existing, now);
      const body: SessionResponse = { established: false, expires_at: expiresAt };
      return json(body, requestId, ownerCookieHeader(presented, request));
    }

    const { session, secret } = await establishOwnerSession(gateway, now);
    const body: SessionResponse = { established: true, expires_at: session.expires_at };
    return json(body, requestId, ownerCookieHeader(secret, request));
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

function json(body: SessionResponse, requestId: string, setCookie: string): Response {
  return Response.json(body, {
    status: 200,
    headers: {
      "set-cookie": setCookie,
      "x-request-id": requestId,
      "cache-control": "no-store",
    },
  });
}
