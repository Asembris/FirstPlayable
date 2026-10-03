/**
 * Owner-session repository: establish, resolve, require, refresh.
 *
 * The raw owner secret exists in exactly two places: the `HttpOnly` cookie and
 * the memory of the one request that created or presented it. Only its hash is
 * persisted, and no function here logs, returns, or embeds the secret in an
 * error (specification sections 11 and 12).
 */

import type { DataGateway, SessionRow } from "./gateway";
import { appErrors } from "../security/errors";
import {
  createOwnerSecret,
  hashOwnerSecret,
  isWellFormedOwnerSecret,
  SESSION_TOUCH_INTERVAL_SECONDS,
  SESSION_TTL_SECONDS,
} from "../security/session";

export type EstablishedSession = {
  session: SessionRow;
  /** Returned so the route can set the cookie. Never persisted, never logged. */
  secret: string;
  created: boolean;
};

function expiryFrom(now: Date): string {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
}

/** Creates a new anonymous owner session and the secret that will own it. */
export async function establishOwnerSession(
  gateway: DataGateway,
  now: Date = new Date(),
): Promise<EstablishedSession> {
  const secret = createOwnerSecret();
  const session = await gateway.insertSession({
    ownerSecretHash: hashOwnerSecret(secret),
    expiresAt: expiryFrom(now),
  });
  return { session, secret, created: true };
}

/**
 * Resolves the owner session a presented secret names, or `null`.
 *
 * A malformed secret is rejected on shape before it becomes a query, and an
 * expired session does not resolve, because the gateway's lookup already
 * requires `expires_at > now`.
 */
export async function resolveOwnerSession(
  gateway: DataGateway,
  secret: string | null,
  now: Date = new Date(),
): Promise<SessionRow | null> {
  if (secret === null || !isWellFormedOwnerSecret(secret)) return null;
  return gateway.findLiveSessionByHash(hashOwnerSecret(secret), now.toISOString());
}

/** Same as {@link resolveOwnerSession} but refuses the request when absent. */
export async function requireOwnerSession(
  gateway: DataGateway,
  secret: string | null,
  now: Date = new Date(),
): Promise<SessionRow> {
  const session = await resolveOwnerSession(gateway, secret, now);
  if (session === null) throw appErrors.sessionRequired();
  return session;
}

/**
 * Refreshes last activity and the 60-day expiry, but only once the stored
 * `last_seen_at` is genuinely stale. An owner opening a project repeatedly
 * does not generate a database write per request.
 *
 * Returns the expiry that is in force afterwards, so a route can report it
 * without a second read.
 */
export async function refreshOwnerActivity(
  gateway: DataGateway,
  session: SessionRow,
  now: Date = new Date(),
): Promise<string> {
  const lastSeen = Date.parse(session.last_seen_at);
  if (Number.isFinite(lastSeen)) {
    const age = (now.getTime() - lastSeen) / 1000;
    if (age < SESSION_TOUCH_INTERVAL_SECONDS) return session.expires_at;
  }
  const expiresAt = expiryFrom(now);
  await gateway.touchSession(session.id, now.toISOString(), expiresAt);
  return expiresAt;
}

/** Owner-requested deletion. Cascades to that owner's projects and operations. */
export async function deleteOwnerSession(
  gateway: DataGateway,
  session: SessionRow,
): Promise<void> {
  await gateway.deleteSession(session.id);
}
