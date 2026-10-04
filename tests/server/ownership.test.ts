import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProject, readProjectForOwner, toProjectView } from "../../src/server/db/projects";
import { establishOwnerSession } from "../../src/server/db/sessions";
import { AppError, ERROR_CODES } from "../../src/server/security/errors";
import { SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import { MemoryGateway } from "./support/memory-gateway";

const LIMITS = { projectsPerDay: 5 } as const;

async function owner(gateway: MemoryGateway) {
  const { session } = await establishOwnerSession(gateway);
  return session;
}

describe("owner-scoped project access", () => {
  it("lets the owner create and read back its own project", async () => {
    const gateway = new MemoryGateway();
    const session = await owner(gateway);

    const created = await createProject(
      gateway,
      session,
      { brief: SECOND_COPY_BRIEF },
      LIMITS,
    );
    const read = await readProjectForOwner(gateway, session, created.id);

    expect(read?.id).toBe(created.id);
    expect(toProjectView(read!).brief.premise).toBe(SECOND_COPY_BRIEF.premise);
  });

  it("starts a project with no Qloo, approval, base, or version state", async () => {
    const gateway = new MemoryGateway();
    const session = await owner(gateway);
    const created = await createProject(gateway, session, { brief: SECOND_COPY_BRIEF }, LIMITS);
    const view = toProjectView(created);

    expect(view.revision).toBe(1);
    expect(view.workflow_state).toBe("DRAFT");
    expect(view.anchor_confirmed).toBe(false);
    expect(view.active_version_id).toBeNull();
    expect(view.approved_slots).toEqual([]);
  });

  it("refuses a second session the first session's project", async () => {
    const gateway = new MemoryGateway();
    const alice = await owner(gateway);
    const bob = await owner(gateway);

    const project = await createProject(gateway, alice, { brief: SECOND_COPY_BRIEF }, LIMITS);

    expect(await readProjectForOwner(gateway, alice, project.id)).not.toBeNull();
    expect(await readProjectForOwner(gateway, bob, project.id)).toBeNull();
  });

  it("answers identically for a foreign project and a nonexistent project", async () => {
    const gateway = new MemoryGateway();
    const alice = await owner(gateway);
    const bob = await owner(gateway);
    const project = await createProject(gateway, alice, { brief: SECOND_COPY_BRIEF }, LIMITS);

    const foreign = await readProjectForOwner(gateway, bob, project.id);
    const nonexistent = await readProjectForOwner(
      gateway,
      bob,
      "00000000-0000-4000-8000-000000000000",
    );

    expect(foreign).toBe(nonexistent);
    expect(foreign).toBeNull();
  });

  it("survives a fresh repository instance over the same store", async () => {
    const gateway = new MemoryGateway();
    const session = await owner(gateway);
    const project = await createProject(gateway, session, { brief: SECOND_COPY_BRIEF }, LIMITS);

    // The repositories hold no state of their own: a second caller against the
    // same store sees the committed row, which is what a new serverless
    // instance or a redeployment does against the same database.
    const again = await readProjectForOwner(gateway, session, project.id);
    expect(again?.revision).toBe(1);
    expect(again?.title).toBe(project.title);
  });

  it("never returns the owner session id or the clean base scene", async () => {
    const gateway = new MemoryGateway();
    const session = await owner(gateway);
    const project = await createProject(gateway, session, { brief: SECOND_COPY_BRIEF }, LIMITS);
    const view = toProjectView(project);

    // The whole public shape. Provider diagnostics, request fingerprints,
    // quota counters, the owner session id, the clean base scene, and the
    // private affinity values are all absent by construction.
    expect(Object.keys(view).sort()).toEqual([
      "active_version_id",
      "anchor",
      "anchor_confirmed",
      "approvals",
      "approved_slots",
      "brief",
      "created_at",
      "id",
      "proposals",
      "provenance",
      "reference_capture_ids",
      "revision",
      "title",
      "updated_at",
      "workflow_state",
    ]);
    expect(JSON.stringify(view)).not.toContain(session.id);
    expect(JSON.stringify(view)).not.toContain("affinity");
    expect(JSON.stringify(view)).not.toContain("request_fingerprint");
  });

  it("enforces the per-session daily project allowance in the database", async () => {
    const gateway = new MemoryGateway();
    const session = await owner(gateway);

    for (let index = 0; index < LIMITS.projectsPerDay; index += 1) {
      await createProject(gateway, session, { brief: SECOND_COPY_BRIEF }, LIMITS);
    }
    await expect(
      createProject(gateway, session, { brief: SECOND_COPY_BRIEF }, LIMITS),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.code === ERROR_CODES.RATE_LIMITED,
    );

    // Another session is unaffected: the allowance is per owner, not global.
    const other = await owner(gateway);
    await expect(
      createProject(gateway, other, { brief: SECOND_COPY_BRIEF }, LIMITS),
    ).resolves.toBeDefined();
  });

  it("reports a corrupt stored brief as a persistence failure, not as a project", async () => {
    const gateway = new MemoryGateway();
    const session = await owner(gateway);
    const project = await createProject(gateway, session, { brief: SECOND_COPY_BRIEF }, LIMITS);

    const record = gateway.projects.get(project.id);
    expect(record).toBeDefined();
    if (record !== undefined) record.brief = { premise: "too short" };

    const row = await readProjectForOwner(gateway, session, project.id);
    expect(() => toProjectView(row!)).toThrowError(AppError);
  });
});

describe("the gateway contract itself enforces owner scoping", () => {
  const gatewaySource = readFileSync(
    fileURLToPath(new URL("../../src/server/db/gateway.ts", import.meta.url)),
    "utf8",
  );
  const repositorySource = readFileSync(
    fileURLToPath(new URL("../../src/server/db/projects.ts", import.meta.url)),
    "utf8",
  );
  const supabaseSource = readFileSync(
    fileURLToPath(new URL("../../src/server/db/supabase-gateway.ts", import.meta.url)),
    "utf8",
  );

  /** The declared interface body, with comments stripped so prose cannot match. */
  const interfaceBody = (() => {
    const match = /export interface DataGateway \{([\s\S]*?)^\}/m.exec(gatewaySource);
    const body = match?.[1] ?? "";
    return body.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  })();

  /**
   * Every method, and the one category that is deliberately not owner-scoped.
   *
   * A `qloo_captures` row is not owner data: it is a normalized excerpt of a
   * public catalogue response, keyed by a request fingerprint, carrying no
   * project id, session id, creator text, or decision. Sharing it between two
   * creators who confirmed the same artist is what makes a cache hit cost zero
   * upstream calls. Everything that touches a *project* stays owner-scoped.
   */
  const CAPTURE_METHODS = [
    "findLatestQlooCapture",
    "findQlooCaptureByFingerprint",
    "findQlooCapturesByFingerprints",
    "findQlooCapturesByIds",
    "insertQlooCapture",
  ] as const;

  it("declares exactly the owner-scoped or scope-keyed methods phases 2 and 3 need", () => {
    const methods = [...interfaceBody.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]).sort();
    expect(methods).toEqual([
      "appendInfluenceDecision",
      "completeOperation",
      "confirmProjectAnchor",
      "countProjectsForOwnerSince",
      "deleteBudgetBucket",
      "deleteSession",
      ...CAPTURE_METHODS,
      "findLiveSessionByHash",
      "findProjectForOwner",
      "insertProject",
      "insertSession",
      "listInfluenceDecisions",
      "reconcileModelBudget",
      "releaseQlooLaunch",
      "reserveModelBudget",
      "reserveOperation",
      "reserveQlooLaunch",
      "setProjectProposalDraft",
      "setProjectReferences",
      "touchSession",
    ].sort());
  });

  /**
   * Resolves a method's parameter type and requires an owner session id to be
   * reachable from it — either named inline, or declared on the input type.
   * This is what stops a phase 3 write from taking a bare `{ projectId }`.
   */
  it("offers no project read or write that omits an owner session id", () => {
    const projectMethods = [...interfaceBody.matchAll(/^\s{2}(\w*Project\w*)\(([^)]*)\)/gm)];
    expect(projectMethods.length).toBeGreaterThan(4);

    for (const method of projectMethods) {
      const name = method[1] ?? "";
      const parameters = method[2] ?? "";
      if (parameters.includes("ownerSessionId")) continue;

      const typeName = /:\s*(\w+)\s*$/.exec(parameters.trim())?.[1];
      expect(typeName, `${name} must name its input type`).toBeDefined();
      const declaration = new RegExp(
        `export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`,
      ).exec(gatewaySource);
      expect(declaration, `${typeName} must be declared in the gateway`).not.toBeNull();
      expect(
        (declaration?.[1] ?? "").includes("ownerSessionId"),
        `${name} must be owner-scoped through ${typeName}`,
      ).toBe(true);
    }
  });

  it("names the influence-decision reads owner-scoped too", () => {
    const decisionReads = [...interfaceBody.matchAll(/^\s{2}(\w*InfluenceDecision\w*)\(([^)]*)\)/gm)];
    expect(decisionReads.length).toBeGreaterThan(1);
    for (const read of decisionReads) {
      const parameters = read[2] ?? "";
      const typeName = /:\s*(\w+)\s*$/.exec(parameters.trim())?.[1];
      const declaration =
        typeName === undefined
          ? null
          : new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`).exec(gatewaySource);
      expect(
        parameters.includes("ownerSessionId") ||
          (declaration?.[1] ?? "").includes("ownerSessionId"),
        `${read[1]} must be owner-scoped`,
      ).toBe(true);
    }
  });

  it("filters every Supabase project query by owner_session_id", () => {
    const projectQueries = [...supabaseSource.matchAll(/\.from\("projects"\)[\s\S]*?;/g)];
    expect(projectQueries.length).toBeGreaterThan(0);
    for (const query of projectQueries) {
      const isInsert = query[0].includes(".insert(");
      expect(
        isInsert || query[0].includes('owner_session_id'),
        `project query lacks owner scoping:\n${query[0]}`,
      ).toBe(true);
    }
  });

  it("builds no Supabase client outside the one server-only boundary module", () => {
    expect(repositorySource).not.toContain("createClient");
    expect(gatewaySource).not.toContain("@supabase/supabase-js");
    expect(supabaseSource).toContain("@supabase/supabase-js");
  });
});
