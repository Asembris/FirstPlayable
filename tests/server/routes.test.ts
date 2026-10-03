import { describe, expect, it } from "vitest";
import { SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import { BUDGET_DEFAULTS } from "../../src/server/config";
import { handleCreateProject, handleReadProject } from "../../src/server/api/projects";
import { handleCreateSession } from "../../src/server/api/session";
import type { RouteDeps } from "../../src/server/api/deps";
import { ERROR_CODES, type ErrorEnvelope } from "../../src/server/security/errors";
import {
  CREATOR_COMMAND_BODY_LIMIT_BYTES,
} from "../../src/server/security/request";
import { OWNER_COOKIE_NAME } from "../../src/server/security/session";
import { MemoryGateway } from "./support/memory-gateway";

const ORIGIN = "https://studio.example.test";

function deps(gateway: MemoryGateway, now?: () => Date): RouteDeps {
  return {
    gateway: () => gateway,
    budget: () => BUDGET_DEFAULTS,
    ...(now === undefined ? {} : { now }),
  };
}

type RequestOverrides = {
  origin?: string | null;
  contentType?: string | null;
  cookie?: string | null;
  body?: string;
};

function mutation(path: string, overrides: RequestOverrides = {}): Request {
  const headers = new Headers();
  const origin = overrides.origin === undefined ? ORIGIN : overrides.origin;
  if (origin !== null) headers.set("origin", origin);
  const contentType =
    overrides.contentType === undefined ? "application/json" : overrides.contentType;
  if (contentType !== null) headers.set("content-type", contentType);
  if (overrides.cookie !== null && overrides.cookie !== undefined) {
    headers.set("cookie", overrides.cookie);
  }
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: overrides.body ?? "{}",
  });
}

function read(path: string, cookie: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).not.toBeNull();
  const value = header?.split(";")[0] ?? "";
  expect(value.startsWith(`${OWNER_COOKIE_NAME}=`)).toBe(true);
  return value;
}

async function envelope(response: Response): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope;
}

/** Establishes one owner and returns its cookie header value. */
async function owner(gateway: MemoryGateway): Promise<string> {
  const response = await handleCreateSession(mutation("/api/session"), deps(gateway));
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

describe("POST /api/session", () => {
  it("establishes an HttpOnly owner cookie and returns a finite expiry", async () => {
    const gateway = new MemoryGateway();
    const response = await handleCreateSession(mutation("/api/session"), deps(gateway));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("; Secure");

    const body = (await response.json()) as { established: boolean; expires_at: string };
    expect(body.established).toBe(true);
    expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());
    expect(gateway.sessions.size).toBe(1);
  });

  it("never returns the stored hash or anything but the two declared fields", async () => {
    const gateway = new MemoryGateway();
    const response = await handleCreateSession(mutation("/api/session"), deps(gateway));
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["established", "expires_at"]);
    const stored = [...gateway.sessions.values()][0];
    expect(JSON.stringify(body)).not.toContain(stored?.owner_secret_hash ?? "impossible");
  });

  it("resumes an existing session instead of creating a second one", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const again = await handleCreateSession(
      mutation("/api/session", { cookie }),
      deps(gateway),
    );
    const body = (await again.json()) as { established: boolean };

    expect(body.established).toBe(false);
    expect(gateway.sessions.size).toBe(1);
  });

  it("replaces an unknown cookie with a fresh session rather than failing", async () => {
    const gateway = new MemoryGateway();
    const response = await handleCreateSession(
      mutation("/api/session", { cookie: `${OWNER_COOKIE_NAME}=${"a".repeat(43)}` }),
      deps(gateway),
    );
    const body = (await response.json()) as { established: boolean };
    expect(body.established).toBe(true);
  });

  it("reports a database outage as a redacted retryable envelope", async () => {
    const gateway = new MemoryGateway();
    gateway.failAll();
    const response = await handleCreateSession(mutation("/api/session"), deps(gateway));
    const body = await envelope(response);

    expect(response.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.PERSISTENCE_UNAVAILABLE);
    expect(body.retryable).toBe(true);
    expect(body.last_good_version_id).toBeNull();
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/simulated outage|insertSession/);
  });
});

describe("mutation security on POST /api/projects", () => {
  it("accepts a valid same-origin mutation", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const response = await handleCreateProject(
      mutation("/api/projects", { cookie, body: JSON.stringify({ brief: SECOND_COPY_BRIEF }) }),
      deps(gateway),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { project: { id: string; revision: number } };
    expect(body.project.revision).toBe(1);
    expect(gateway.projects.size).toBe(1);
  });

  it("rejects a mutation with no Origin header", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const response = await handleCreateProject(
      mutation("/api/projects", {
        origin: null,
        cookie,
        body: JSON.stringify({ brief: SECOND_COPY_BRIEF }),
      }),
      deps(gateway),
    );

    expect(response.status).toBe(403);
    expect((await envelope(response)).code).toBe(ERROR_CODES.ORIGIN_REQUIRED);
    expect(gateway.projects.size).toBe(0);
  });

  it("rejects a mutation from a foreign Origin", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    for (const foreign of [
      "https://attacker.example",
      "http://studio.example.test",
      "https://studio.example.test.attacker.example",
      "null",
    ]) {
      const response = await handleCreateProject(
        mutation("/api/projects", {
          origin: foreign,
          cookie,
          body: JSON.stringify({ brief: SECOND_COPY_BRIEF }),
        }),
        deps(gateway),
      );
      expect(response.status, foreign).toBe(403);
      expect((await envelope(response)).code, foreign).toBe(ERROR_CODES.ORIGIN_MISMATCH);
    }
    expect(gateway.projects.size).toBe(0);
  });

  it("accepts the forwarded host a proxy supplies, with no hard-coded hostname", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const request = new Request("http://internal-ip/api/projects", {
      method: "POST",
      headers: {
        origin: "https://firstplayable-preview.vercel.app",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "firstplayable-preview.vercel.app",
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ brief: SECOND_COPY_BRIEF }),
    });

    const response = await handleCreateProject(request, deps(gateway));
    expect(response.status).toBe(201);
  });

  it("rejects a wrong or missing content type", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await handleCreateProject(
        mutation("/api/projects", {
          contentType,
          cookie,
          body: JSON.stringify({ brief: SECOND_COPY_BRIEF }),
        }),
        deps(gateway),
      );
      expect(response.status, String(contentType)).toBe(415);
      expect((await envelope(response)).code).toBe(ERROR_CODES.CONTENT_TYPE_UNSUPPORTED);
    }
    expect(gateway.projects.size).toBe(0);
  });

  it("rejects an oversized body before any database work", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const padded = JSON.stringify({
      brief: SECOND_COPY_BRIEF,
      padding: "x".repeat(CREATOR_COMMAND_BODY_LIMIT_BYTES),
    });
    expect(padded.length).toBeGreaterThan(CREATOR_COMMAND_BODY_LIMIT_BYTES);

    const response = await handleCreateProject(
      mutation("/api/projects", { cookie, body: padded }),
      deps(gateway),
    );

    expect(response.status).toBe(413);
    expect((await envelope(response)).code).toBe(ERROR_CODES.BODY_TOO_LARGE);
    expect(gateway.projects.size).toBe(0);
  });

  it("enforces the cap even when Content-Length lies about the size", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const request = new Request(`${ORIGIN}/api/projects`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "content-length": "12",
        cookie,
      },
      body: "x".repeat(CREATOR_COMMAND_BODY_LIMIT_BYTES + 1024),
    });

    const response = await handleCreateProject(request, deps(gateway));
    expect(response.status).toBe(413);
    expect(gateway.projects.size).toBe(0);
  });

  it("rejects malformed JSON", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    const response = await handleCreateProject(
      mutation("/api/projects", { cookie, body: '{"brief": {' }),
      deps(gateway),
    );

    expect(response.status).toBe(400);
    expect((await envelope(response)).code).toBe(ERROR_CODES.BODY_MALFORMED);
  });

  it("rejects a body that parses but fails the authoritative brief contract", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);

    for (const body of [
      {},
      { brief: {} },
      { brief: { ...SECOND_COPY_BRIEF, premise: "too short" } },
      { brief: { ...SECOND_COPY_BRIEF, tone: "sinister" } },
      { brief: { ...SECOND_COPY_BRIEF, unexpected: true } },
      // A creator cannot smuggle server-assigned state in through the payload.
      { brief: SECOND_COPY_BRIEF, revision: 99 },
      { brief: SECOND_COPY_BRIEF, workflow_state: "READY" },
      { brief: SECOND_COPY_BRIEF, owner_session_id: "someone-else" },
    ]) {
      const response = await handleCreateProject(
        mutation("/api/projects", { cookie, body: JSON.stringify(body) }),
        deps(gateway),
      );
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect((await envelope(response)).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    }
    expect(gateway.projects.size).toBe(0);
  });

  it("requires an owner session", async () => {
    const gateway = new MemoryGateway();

    const response = await handleCreateProject(
      mutation("/api/projects", { body: JSON.stringify({ brief: SECOND_COPY_BRIEF }) }),
      deps(gateway),
    );

    expect(response.status).toBe(401);
    expect((await envelope(response)).code).toBe(ERROR_CODES.SESSION_REQUIRED);
    expect(gateway.projects.size).toBe(0);
  });

  it("returns a redacted envelope and no provider detail when the database fails", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);
    gateway.failAll();

    const response = await handleCreateProject(
      mutation("/api/projects", { cookie, body: JSON.stringify({ brief: SECOND_COPY_BRIEF }) }),
      deps(gateway),
    );
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(text).toContain(ERROR_CODES.PERSISTENCE_UNAVAILABLE);
    expect(text).toContain("saved example");
    expect(text).not.toMatch(/supabase|postgres|select |insert |sqlstate|at Object\./i);
  });
});

describe("GET /api/projects/:id", () => {
  it("returns the owner's persisted brief across repeated reads", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);
    const created = await handleCreateProject(
      mutation("/api/projects", { cookie, body: JSON.stringify({ brief: SECOND_COPY_BRIEF }) }),
      deps(gateway),
    );
    const { project } = (await created.json()) as { project: { id: string } };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await handleReadProject(
        read(`/api/projects/${project.id}`, cookie),
        deps(gateway),
        project.id,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        project: { brief: { premise: string; room: { name: string } }; revision: number };
      };
      expect(body.project.brief.premise).toBe(SECOND_COPY_BRIEF.premise);
      expect(body.project.brief.room.name).toBe(SECOND_COPY_BRIEF.room.name);
      expect(body.project.revision).toBe(1);
    }
  });

  it("refuses a second owner and a nonexistent id with the identical response", async () => {
    const gateway = new MemoryGateway();
    const alice = await owner(gateway);
    const bob = await owner(gateway);
    const created = await handleCreateProject(
      mutation("/api/projects", {
        cookie: alice,
        body: JSON.stringify({ brief: SECOND_COPY_BRIEF }),
      }),
      deps(gateway),
    );
    const { project } = (await created.json()) as { project: { id: string } };

    const foreign = await handleReadProject(
      read(`/api/projects/${project.id}`, bob),
      deps(gateway),
      project.id,
    );
    const absent = await handleReadProject(
      read("/api/projects/00000000-0000-4000-8000-000000000000", bob),
      deps(gateway),
      "00000000-0000-4000-8000-000000000000",
    );
    const malformed = await handleReadProject(
      read("/api/projects/not-a-uuid", bob),
      deps(gateway),
      "not-a-uuid",
    );

    const bodies = await Promise.all([foreign, absent, malformed].map(envelope));
    expect([foreign.status, absent.status, malformed.status]).toEqual([404, 404, 404]);
    for (const body of bodies) {
      expect(body.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(body.message).toBe(bodies[0]?.message);
      expect(body.retryable).toBe(false);
    }
    // The three responses differ only by request id.
    const shapes = bodies.map((body) => ({ ...body, request_id: "-" }));
    expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
  });

  it("never includes the owner session id, the base scene, or a provider diagnostic", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);
    const created = await handleCreateProject(
      mutation("/api/projects", { cookie, body: JSON.stringify({ brief: SECOND_COPY_BRIEF }) }),
      deps(gateway),
    );
    const { project } = (await created.json()) as { project: { id: string } };
    const sessionId = [...gateway.sessions.values()][0]?.id ?? "impossible";

    const response = await handleReadProject(
      read(`/api/projects/${project.id}`, cookie),
      deps(gateway),
      project.id,
    );
    const text = await response.text();

    expect(text).not.toContain(sessionId);
    expect(text).not.toMatch(/owner_session_id|owner_secret_hash|base_scene|quota_diagnostics/);
  });

  it("is not cached, and carries a request id", async () => {
    const gateway = new MemoryGateway();
    const cookie = await owner(gateway);
    const created = await handleCreateProject(
      mutation("/api/projects", { cookie, body: JSON.stringify({ brief: SECOND_COPY_BRIEF }) }),
      deps(gateway),
    );
    const { project } = (await created.json()) as { project: { id: string } };

    const response = await handleReadProject(
      read(`/api/projects/${project.id}`, cookie),
      deps(gateway),
      project.id,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
