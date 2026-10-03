/**
 * The anonymous owner session (specification sections 11 and 12).
 *
 * The owner's capability is one opaque cryptographically random secret held in
 * an `HttpOnly` cookie. The database stores only its SHA-256 hash, so a
 * database read cannot reconstruct the capability. There is no account, no
 * password, no email, and no recovery path: losing the cookie loses editing
 * access, which the studio states before a project is created.
 *
 * Deliberately not used as identity: IP address, user agent, `localStorage`,
 * and the project id itself. A project id is an address, never an authorisation.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE_NAME = "fp_owner";

/** 32 bytes, so 256 bits of entropy, encoded base64url without padding. */
export const OWNER_SECRET_BYTES = 32;
const OWNER_SECRET_LENGTH = 43;
const OWNER_SECRET_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${OWNER_SECRET_LENGTH}}$`);

/** 60-day expiry from specification section 11, refreshed by real owner activity. */
export const SESSION_TTL_SECONDS = 60 * 24 * 60 * 60;

/**
 * How stale `last_seen_at` may get before an owner request refreshes it. This
 * keeps a read path from writing to the database on every single request while
 * still refreshing a session that is genuinely in use.
 */
export const SESSION_TOUCH_INTERVAL_SECONDS = 60 * 60;

export function createOwnerSecret(): string {
  return randomBytes(OWNER_SECRET_BYTES).toString("base64url");
}

export function hashOwnerSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Shape check before the secret is hashed and looked up. A malformed cookie is
 * rejected here rather than becoming a database query with attacker-chosen text.
 */
export function isWellFormedOwnerSecret(value: string): boolean {
  return OWNER_SECRET_SHAPE.test(value);
}

/** Constant-time comparison, for the places that compare two hashes directly. */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reads the owner secret out of the request's `Cookie` header.
 *
 * Route handlers take the secret from here rather than from `next/headers`, so
 * the whole request path is an ordinary `Request` and can be exercised in a
 * unit test exactly as the deployed runtime executes it.
 */
export function readOwnerSecret(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== OWNER_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
}

/**
 * Whether this request reached us over TLS.
 *
 * Decided from the request itself — the forwarded protocol behind Vercel's
 * proxy, otherwise the request URL — rather than from `NODE_ENV`. A production
 * build served over plain http on a loopback address must still be able to set
 * a cookie, and a production deployment must always get `Secure`. No hostname
 * is hard-coded anywhere.
 */
export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim().toLowerCase();
    if (first !== undefined && first.length > 0) return first === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function serializeCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${OWNER_COOKIE_NAME}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * The `Set-Cookie` value for an established session. `HttpOnly` is what keeps
 * the secret out of `document.cookie`, and `SameSite=Lax` is what keeps another
 * site from driving a mutation with it.
 */
export function ownerCookieHeader(secret: string, request: Request): string {
  return serializeCookie(secret, SESSION_TTL_SECONDS, requestIsSecure(request));
}

/** Clears a cookie whose secret no longer resolves to a live session. */
export function clearedOwnerCookieHeader(request: Request): string {
  return serializeCookie("", 0, requestIsSecure(request));
}
