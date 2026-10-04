/**
 * The read token (specification section 12).
 *
 * A read token is a separate capability from the owner cookie and it carries no
 * owner authority. It is 32 random bytes — 256 bits, well above the required
 * 128 — encoded base64url, and the database stores only its SHA-256 hash, so a
 * database read cannot reconstruct a link. The plaintext exists exactly once, in
 * the response to the publish that created it; this application never stores it,
 * logs it, or returns it again.
 *
 * It is deliberately generated and hashed the same way the owner secret is, and
 * it is deliberately a *different* value: nothing derives a share token from an
 * owner secret or the other way round.
 */

import { createHash, randomBytes } from "node:crypto";
import { READ_TOKEN_BYTES } from "@/domain/publish";

/** 32 bytes base64url is 43 characters, with no padding. */
const TOKEN_LENGTH = 43;
const TOKEN_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

export function createReadToken(): string {
  return randomBytes(READ_TOKEN_BYTES).toString("base64url");
}

export function hashReadToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Shape check before a token is hashed and looked up.
 *
 * A malformed token is rejected here rather than becoming a database query with
 * attacker-chosen text, and it produces the same unavailable answer an unknown
 * or revoked token does.
 */
export function isWellFormedReadToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

/** The public play path for one token. The only place this string is built. */
export function playPathFor(token: string): string {
  return `/play/${token}`;
}
