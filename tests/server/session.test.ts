import { describe, expect, it } from "vitest";
import {
  deleteOwnerSession,
  establishOwnerSession,
  refreshOwnerActivity,
  requireOwnerSession,
  resolveOwnerSession,
} from "../../src/server/db/sessions";
import { AppError, ERROR_CODES } from "../../src/server/security/errors";
import {
  clearedOwnerCookieHeader,
  createOwnerSecret,
  hashOwnerSecret,
  hashesMatch,
  isWellFormedOwnerSecret,
  OWNER_COOKIE_NAME,
  ownerCookieHeader,
  readOwnerSecret,
  requestIsSecure,
  SESSION_TOUCH_INTERVAL_SECONDS,
  SESSION_TTL_SECONDS,
} from "../../src/server/security/session";
import { MemoryGateway, sha256Hex } from "./support/memory-gateway";

describe("owner secret", () => {
  it("is 256 bits of cryptographic randomness, base64url encoded", () => {
    const secret = createOwnerSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, "base64url").byteLength).toBe(32);
  });

  it("never repeats across a large sample", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) seen.add(createOwnerSecret());
    expect(seen.size).toBe(2_000);
  });

  it("hashes to a stable sha256 hex digest", () => {
    const secret = createOwnerSecret();
    expect(hashOwnerSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOwnerSecret(secret)).toBe(sha256Hex(secret));
    expect(hashOwnerSecret(secret)).not.toContain(secret);
  });

  it("rejects malformed cookie values on shape, before any lookup", () => {
    for (const malformed of [
      "",
      "short",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}!`,
      "../../etc/passwd",
      "' or 1=1 --",
    ]) {
      expect(isWellFormedOwnerSecret(malformed), malformed).toBe(false);
    }
    expect(isWellFormedOwnerSecret(createOwnerSecret())).toBe(true);
  });

  it("compares hashes in constant time without throwing on length mismatch", () => {
    const left = hashOwnerSecret("a");
    expect(hashesMatch(left, left)).toBe(true);
    expect(hashesMatch(left, hashOwnerSecret("b"))).toBe(false);
    expect(hashesMatch(left, "short")).toBe(false);
  });
});

describe("owner cookie", () => {
  const httpsRequest = new Request("https://example.test/api/session", { method: "POST" });
  const httpRequest = new Request("http://127.0.0.1:3100/api/session", { method: "POST" });

  it("is HttpOnly, SameSite=Lax, path-scoped, and finite", () => {
    const header = ownerCookieHeader("secret-value", httpsRequest);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(SESSION_TTL_SECONDS).toBe(60 * 24 * 60 * 60);
  });

  it("carries Secure over https and omits it over plain loopback http", () => {
    expect(ownerCookieHeader("v", httpsRequest)).toContain("; Secure");
    expect(ownerCookieHeader("v", httpRequest)).not.toContain("; Secure");
  });

  it("trusts the forwarded protocol a proxy supplies, with no hard-coded host", () => {
    const behindProxy = new Request("http://internal/api/session", {
      method: "POST",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "preview.example.test" },
    });
    expect(requestIsSecure(behindProxy)).toBe(true);
    expect(ownerCookieHeader("v", behindProxy)).toContain("; Secure");
  });

  it("clears with Max-Age=0 and still refuses script access", () => {
    const header = clearedOwnerCookieHeader(httpsRequest);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });

  it("reads its own value back out of a Cookie header, ignoring neighbours", () => {
    const request = new Request("https://example.test/api/projects", {
      headers: { cookie: `other=1; ${OWNER_COOKIE_NAME}=abc123; third=x` },
    });
    expect(readOwnerSecret(request)).toBe("abc123");
    expect(readOwnerSecret(new Request("https://example.test/"))).toBeNull();
    expect(
      readOwnerSecret(
        new Request("https://example.test/", { headers: { cookie: "unrelated=1" } }),
      ),
    ).toBeNull();
  });
});

describe("owner session repository", () => {
  it("stores only the hash, never the raw secret", async () => {
    const gateway = new MemoryGateway();
    const { session, secret } = await establishOwnerSession(gateway);

    expect(session.owner_secret_hash).toBe(sha256Hex(secret));
    const stored = JSON.stringify([...gateway.sessions.values()]);
    expect(stored).not.toContain(secret);
    expect(Object.keys(session)).not.toContain("owner_secret");
  });

  it("resolves the owner from a valid secret", async () => {
    const gateway = new MemoryGateway();
    const { session, secret } = await establishOwnerSession(gateway);
    const resolved = await resolveOwnerSession(gateway, secret);
    expect(resolved?.id).toBe(session.id);
  });

  it("fails safely for an unknown, malformed, or absent cookie", async () => {
    const gateway = new MemoryGateway();
    await establishOwnerSession(gateway);

    expect(await resolveOwnerSession(gateway, null)).toBeNull();
    expect(await resolveOwnerSession(gateway, "not-a-secret")).toBeNull();
    expect(await resolveOwnerSession(gateway, createOwnerSecret())).toBeNull();
  });

  it("refuses the request when a session is required but absent", async () => {
    const gateway = new MemoryGateway();
    await expect(requireOwnerSession(gateway, null)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppError && error.code === ERROR_CODES.SESSION_REQUIRED,
    );
  });

  it("does not resolve an expired session", async () => {
    const gateway = new MemoryGateway();
    const start = new Date("2026-01-01T00:00:00.000Z");
    gateway.setClock(() => start);
    const { secret } = await establishOwnerSession(gateway, start);

    const justInside = new Date(start.getTime() + (SESSION_TTL_SECONDS - 10) * 1000);
    expect(await resolveOwnerSession(gateway, secret, justInside)).not.toBeNull();

    const past = new Date(start.getTime() + (SESSION_TTL_SECONDS + 10) * 1000);
    expect(await resolveOwnerSession(gateway, secret, past)).toBeNull();
  });

  it("refreshes expiry only once last activity is genuinely stale", async () => {
    const gateway = new MemoryGateway();
    const start = new Date("2026-01-01T00:00:00.000Z");
    gateway.setClock(() => start);
    const { session, secret } = await establishOwnerSession(gateway, start);

    const soon = new Date(start.getTime() + (SESSION_TOUCH_INTERVAL_SECONDS - 60) * 1000);
    await refreshOwnerActivity(gateway, session, soon);
    expect(gateway.sessions.get(session.id)?.expires_at).toBe(session.expires_at);

    const later = new Date(start.getTime() + (SESSION_TOUCH_INTERVAL_SECONDS + 60) * 1000);
    gateway.setClock(() => later);
    await refreshOwnerActivity(gateway, session, later);
    const refreshed = gateway.sessions.get(session.id);
    expect(refreshed).toBeDefined();
    expect(Date.parse(refreshed?.expires_at ?? "")).toBeGreaterThan(
      Date.parse(session.expires_at),
    );
    expect(await resolveOwnerSession(gateway, secret, later)).not.toBeNull();
  });

  it("supports owner-requested deletion, which takes the projects with it", async () => {
    const gateway = new MemoryGateway();
    const { session, secret } = await establishOwnerSession(gateway);
    await gateway.insertProject({
      ownerSessionId: session.id,
      title: "Doomed",
      brief: { placeholder: true },
    });
    expect(gateway.projects.size).toBe(1);

    await deleteOwnerSession(gateway, session);
    expect(gateway.projects.size).toBe(0);
    expect(await resolveOwnerSession(gateway, secret)).toBeNull();
  });

  it("surfaces a database outage as a redacted persistence error", async () => {
    const gateway = new MemoryGateway();
    gateway.failAll();
    await expect(establishOwnerSession(gateway)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppError &&
        error.code === ERROR_CODES.PERSISTENCE_UNAVAILABLE &&
        error.status === 503,
    );
  });
});
