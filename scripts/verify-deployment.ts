/**
 * The explicit, opt-in deployed verification.
 *
 *   RUN_DEPLOY_VERIFY=1 DEPLOY_URL=https://… npm run verify:deployment
 *
 * It verifies the deployed *application*, not the build log. Two halves:
 *
 *   1. An HTTP matrix against the real routes: session establishment, project
 *      persistence, cross-session denial, and every mutation-security refusal.
 *   2. Two genuinely isolated browser contexts: one creates a project through
 *      the studio form and reloads it; the other, with its own empty cookie
 *      jar, is refused. While that happens every request the browser makes is
 *      recorded, so a direct Supabase or OpenAI call would be caught, and the
 *      rendered HTML is scanned for credential shapes.
 *
 * From phase 5 it also revises one fresh two-influence scene end to end —
 * edit, replace, ending wording, remove — checks every stored diff against the
 * engine's own recomputation, publishes a version, plays it from a browser with
 * no session, revokes it, and plays the exported file from disk offline.
 *
 * A preview deployment sits behind Vercel Authentication. Set
 * `VERCEL_AUTOMATION_BYPASS_SECRET` to the project's existing automation bypass
 * secret to verify one; it is sent to the target origin only and never printed.
 *
 * It is never part of `npm test`, `npm run test:e2e`, or `npm run build`.
 * It prints no credential: cookie values are only ever passed back as headers.
 */

import { chromium, type Browser, type BrowserContext } from "@playwright/test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CompilationStatus } from "../src/domain/compile";
import type { RevisionDiffView } from "../src/domain/revision";
import type { Scene } from "../src/domain/scene";
import { mechanicalSignature } from "../src/engine/diff";
import { sha256Hex } from "../src/engine/hash";
import { revisionDiffView } from "../src/server/revision/diff";

const GUARD = "RUN_DEPLOY_VERIFY";

/**
 * A preview deployment sits behind Vercel Authentication. When this variable
 * holds the project's existing automation-bypass secret, every request to the
 * target origin — and only that origin — carries it as a header. It is the
 * same variable name the Vercel CLI reads, it is never printed, and production
 * needs none of it.
 */
const BYPASS_ENV = "VERCEL_AUTOMATION_BYPASS_SECRET";
const BYPASS_HEADER = "x-vercel-protection-bypass";
/**
 * A preview also injects the Vercel toolbar, a script from vercel.live that
 * production never serves. Asking Vercel to skip it keeps the same-origin
 * checks about this application rather than about the preview's toolbar.
 */
const SKIP_TOOLBAR_HEADER = "x-vercel-skip-toolbar";

function bypassSecret(): string | null {
  const value = process.env[BYPASS_ENV];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

/** Adds the bypass header to this script's own requests to the target origin. */
function installFetchBypass(base: string): void {
  const secret = bypassSecret();
  if (secret === null) return;
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(base)) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(BYPASS_HEADER, secret);
    headers.set(SKIP_TOOLBAR_HEADER, "1");
    return inner(input, { ...init, headers });
  }) as typeof fetch;
}

/** A browser context whose requests to the target origin carry the bypass. */
async function deploymentContext(browser: Browser, base: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  const secret = bypassSecret();
  if (secret !== null) {
    await context.route(`${base}/**`, (route) =>
      route.continue({
        headers: { ...route.request().headers(), [BYPASS_HEADER]: secret, [SKIP_TOOLBAR_HEADER]: "1" },
      }),
    );
  }
  return context;
}

type Check = { label: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(label: string, ok: boolean, detail: string): void {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

/** Credential shapes. Used to scan rendered HTML and client bundles. */
const CREDENTIAL_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{8,}/ },
  { name: "supabase publishable key", pattern: /sb_publishable_[A-Za-z0-9_-]{8,}/ },
  { name: "supabase access token", pattern: /sbp_[0-9a-f]{40,}/ },
  { name: "openai project key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "openai legacy key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "supabase host", pattern: /[a-z0-9]+\.supabase\.co/ },
  { name: "openai host", pattern: /api\.openai\.com/ },
];

const BRIEF = {
  title: "Deployed persistence probe",
  premise:
    "The station is closing and one sealed letter is still behind the counter. The visitor who left it wants it back before the last train leaves tonight.",
  player_role: "Station attendant",
  room: { id: "room", name: "Lost-property counter", description: "The station is closing." },
  character: { id: "npc", name: "Nia", description: undefined, role: "Visitor asking for her letter" },
  object: { id: "object", name: "Sealed letter", description: "One envelope, left earlier today." },
  tone: "tense",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

function brief(): Record<string, unknown> {
  return {
    title: BRIEF.title,
    premise: BRIEF.premise,
    player_role: BRIEF.player_role,
    room: BRIEF.room,
    character: { id: BRIEF.character.id, name: BRIEF.character.name, role: BRIEF.character.role },
    object: BRIEF.object,
    tone: BRIEF.tone,
    cultural_anchor_query: BRIEF.cultural_anchor_query,
    forbidden_wording: BRIEF.forbidden_wording,
  };
}

function cookieValue(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  if (header === null) return null;
  const first = header.split(";")[0] ?? "";
  return first.startsWith("fp_owner=") && first.length > "fp_owner=".length ? first : null;
}

async function httpMatrix(base: string): Promise<{ projectId: string | null; cookie: string | null }> {
  console.log("  HTTP matrix");

  const sessionResponse = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  const cookieA = cookieValue(sessionResponse);
  const sessionBody = (await sessionResponse.json()) as { established?: boolean };
  record(
    "POST /api/session establishes an HttpOnly owner cookie",
    sessionResponse.status === 200 && cookieA !== null && sessionBody.established === true,
    `status ${sessionResponse.status}, HttpOnly ${String(
      (sessionResponse.headers.get("set-cookie") ?? "").includes("HttpOnly"),
    )}, Secure ${String((sessionResponse.headers.get("set-cookie") ?? "").includes("Secure"))}`,
  );
  if (cookieA === null) return { projectId: null, cookie: null };

  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie: cookieA },
    body: JSON.stringify({ brief: brief() }),
  });
  const createdBody = (await created.json()) as { project?: { id: string; revision: number } };
  const projectId = createdBody.project?.id ?? null;
  record(
    "POST /api/projects persists a frozen brief",
    created.status === 201 && projectId !== null,
    `status ${created.status}, revision ${createdBody.project?.revision ?? "none"}`,
  );
  if (projectId === null) return { projectId: null, cookie: cookieA };

  const readBack = await fetch(`${base}/api/projects/${projectId}`, {
    headers: { cookie: cookieA },
  });
  const readBody = (await readBack.json()) as {
    project?: { brief: { premise: string }; revision: number };
  };
  record(
    "GET /api/projects/:id returns the owner's persisted brief",
    readBack.status === 200 && readBody.project?.brief.premise === BRIEF.premise,
    `status ${readBack.status}, premise matches ${String(
      readBody.project?.brief.premise === BRIEF.premise,
    )}`,
  );

  const sessionB = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  const cookieB = cookieValue(sessionB);
  const foreign = await fetch(`${base}/api/projects/${projectId}`, {
    headers: { cookie: cookieB ?? "" },
  });
  const foreignBody = await foreign.text();
  const absent = await fetch(`${base}/api/projects/00000000-0000-4000-8000-000000000000`, {
    headers: { cookie: cookieB ?? "" },
  });
  const absentBody = await absent.text();
  const strip = (text: string): string => text.replace(/"request_id":"[^"]+"/, '"request_id":"-"');
  record(
    "a second owner session is refused",
    foreign.status === 404,
    `status ${foreign.status}`,
  );
  record(
    "foreign and nonexistent are byte-identical apart from the request id",
    strip(foreignBody) === strip(absentBody) && absent.status === 404,
    `both ${foreign.status}, same envelope ${String(strip(foreignBody) === strip(absentBody))}`,
  );

  const anonymous = await fetch(`${base}/api/projects/${projectId}`);
  record(
    "no owner session reads nothing",
    anonymous.status === 401,
    `status ${anonymous.status}`,
  );

  const noOrigin = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieA },
    body: JSON.stringify({ brief: brief() }),
  });
  record("a mutation with no Origin is refused", noOrigin.status === 403, `status ${noOrigin.status}`);

  const foreignOrigin = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "content-type": "application/json",
      cookie: cookieA,
    },
    body: JSON.stringify({ brief: brief() }),
  });
  record(
    "a mutation from a foreign Origin is refused",
    foreignOrigin.status === 403,
    `status ${foreignOrigin.status}`,
  );

  const wrongType = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { origin: base, "content-type": "text/plain", cookie: cookieA },
    body: JSON.stringify({ brief: brief() }),
  });
  record(
    "a mutation with the wrong content type is refused",
    wrongType.status === 415,
    `status ${wrongType.status}`,
  );

  const oversized = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie: cookieA },
    body: JSON.stringify({ brief: brief(), padding: "x".repeat(32 * 1024) }),
  });
  record(
    "an oversized body is refused",
    oversized.status === 413,
    `status ${oversized.status}`,
  );

  const malformed = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie: cookieA },
    body: '{"brief": {',
  });
  record("a malformed body is refused", malformed.status === 400, `status ${malformed.status}`);

  const invalid = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", cookie: cookieA },
    body: JSON.stringify({ brief: { ...brief(), premise: "too short" } }),
  });
  record(
    "a body that fails the brief contract is refused",
    invalid.status === 422,
    `status ${invalid.status}`,
  );

  const refusalBodies = [
    foreignBody,
    await noOrigin.text(),
    await wrongType.text(),
    await malformed.text(),
    await invalid.text(),
  ].join(" ");
  const leaked = CREDENTIAL_SHAPES.filter((shape) => shape.pattern.test(refusalBodies));
  record(
    "no refusal response carries a credential, a host, SQL, or a stack trace",
    leaked.length === 0 && !/select |insert |sqlstate|at Object\.|supabase/i.test(refusalBodies),
    leaked.length === 0 ? "clean" : leaked.map((shape) => shape.name).join(", "),
  );

  return { projectId, cookie: cookieA };
}

type BrowserRun = { requests: string[]; html: string };

async function inContext(
  context: BrowserContext,
  base: string,
  run: (page: Awaited<ReturnType<BrowserContext["newPage"]>>) => Promise<void>,
): Promise<BrowserRun> {
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await run(page);
  const html = await page.content();
  await page.close();
  void base;
  return { requests, html };
}

/**
 * The Vercel preview toolbar's loader. Vercel's build adds it to a client chunk
 * and activates it on preview deployments only; production never requests it,
 * and neither the request header nor anything in this repository turns it off.
 * It is exempted only on a protected preview (the bypass is in use), and only
 * this exact path — every other foreign request still fails the check.
 */
const PREVIEW_TOOLBAR_PREFIX = "https://vercel.live/_next-live/feedback/";
let previewToolbarExempted = 0;

function foreignRequests(requests: readonly string[], base: string): string[] {
  return requests.filter((url) => {
    if (url.startsWith(base) || url.startsWith("data:") || url.startsWith("blob:")) return false;
    if (bypassSecret() !== null && url.startsWith(PREVIEW_TOOLBAR_PREFIX)) {
      previewToolbarExempted += 1;
      return false;
    }
    return true;
  });
}

async function browserChecks(base: string): Promise<void> {
  console.log("");
  console.log("  Two isolated browser contexts");

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ownerContext = await deploymentContext(browser, base);
    let projectUrl: string | null = null;
    let projectId: string | null = null;

    // The project is created through the studio form, so the premise that must
    // survive a reload is the one the form submitted, not this script's.
    // A holder object, because the assignments happen inside a callback.
    const captured: { premise: string | null } = { premise: null };

    const creation = await inContext(ownerContext, base, async (page) => {
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.getByRole("link", { name: "Create your scene" }).click();
      await page.getByTestId("session-ready").waitFor({ timeout: 30_000 });
      captured.premise = await page.locator("#premise").inputValue();
      await page.getByRole("button", { name: "Save this brief" }).click();
      await page.getByTestId("project-premise").waitFor({ timeout: 30_000 });
      projectUrl = page.url();
      projectId = await page.getByTestId("project-id").innerText();
      const rendered = await page.getByTestId("project-premise").innerText();
      if (rendered.trim() !== (captured.premise ?? "").trim()) captured.premise = null;
    });

    record(
      "the studio establishes a session and persists a project through the form",
      projectUrl !== null && projectId !== null,
      projectId === null ? "no project id rendered" : `project ${String(projectId).slice(0, 8)}…`,
    );

    record(
      "the browser made no request to Supabase, OpenAI, or any other origin",
      foreignRequests(creation.requests, base).length === 0,
      foreignRequests(creation.requests, base).join(", ") || "same-origin only",
    );

    const leakedInHtml = CREDENTIAL_SHAPES.filter((shape) => shape.pattern.test(creation.html));
    record(
      "the rendered page carries no credential and no provider host",
      leakedInHtml.length === 0,
      leakedInHtml.length === 0 ? "clean" : leakedInHtml.map((shape) => shape.name).join(", "),
    );

    if (projectUrl !== null && captured.premise !== null) {
      const reloaded: { premise: string | null; id: string | null } = { premise: null, id: null };
      await inContext(ownerContext, base, async (page) => {
        await page.goto(projectUrl ?? base, { waitUntil: "load" });
        await page.getByTestId("project-premise").waitFor({ timeout: 30_000 });
        reloaded.premise = await page.getByTestId("project-premise").innerText();
        reloaded.id = await page.getByTestId("project-id").innerText();
      });
      record(
        "a reload in the same browser retrieves the persisted project",
        reloaded.id === projectId &&
          (reloaded.premise ?? "").trim() === (captured.premise ?? "").trim(),
        `same project id after a full page load, premise identical (${
          (reloaded.premise ?? "").length
        } characters)`,
      );

      // A second context with its own empty cookie jar.
      const strangerContext = await deploymentContext(browser, base);
      const stranger = await inContext(strangerContext, base, async (page) => {
        await page.goto(projectUrl ?? base, { waitUntil: "load" });
        await page
          .getByTestId("project-unavailable")
          .or(page.getByTestId("error-panel"))
          .waitFor({ timeout: 30_000 });
      });
      record(
        "a separate clean browser context cannot read that private project",
        !stranger.html.includes((captured.premise ?? "").slice(0, 60)),
        "the premise is absent and the page says the project is not available here",
      );
      await strangerContext.close();
    } else {
      record(
        "a reload in the same browser retrieves the persisted project",
        false,
        "the studio form did not reach a persisted project page",
      );
    }

    // The saved example, on the deployment, with no database or model call.
    const playContext = await deploymentContext(browser, base);
    const played = await inContext(playContext, base, async (page) => {
      await page.goto(`${base}/example`, { waitUntil: "networkidle" });
      await page.getByTestId("choice-core.inspect").click();
      await page.getByTestId("choice-core.ask_context").click();
      await page.getByTestId("choice-discovery.ask_identity").click();
      await page.getByTestId("choice-core.withhold").click();
      await page.getByTestId("ending").waitFor({ timeout: 15_000 });
    });
    const apiDuringPlay = played.requests.filter((url) => new URL(url).pathname.startsWith("/api/"));
    record(
      "the deployed saved example plays with no API, database, or model call",
      apiDuringPlay.length === 0 && played.html.includes("Saved example"),
      apiDuringPlay.length === 0 ? "zero /api requests" : apiDuringPlay.join(", "),
    );
    await playContext.close();
    await ownerContext.close();

    if (projectId !== null) {
      console.log(`        persisted project id: ${projectId}`);
    }
  } finally {
    await browser?.close();
  }
}

async function clientBundleScan(base: string): Promise<void> {
  console.log("");
  console.log("  Client bundle");
  const page = await fetch(`${base}/studio`);
  const html = await page.text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map(
    (match) => match[1] ?? "",
  );
  record(
    "the studio page references client chunks to scan",
    scripts.length > 0,
    `${scripts.length} chunk(s)`,
  );

  const findings: string[] = [];
  for (const script of scripts.slice(0, 40)) {
    const response = await fetch(`${base}${script}`);
    const text = await response.text();
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.pattern.test(text)) findings.push(`${script}: ${shape.name}`);
    }
  }
  record(
    "no client chunk contains a credential shape or a provider host",
    findings.length === 0,
    findings.length === 0 ? "clean" : findings.join(", "),
  );
}

/**
 * The deployed phase 3 workflow, driven over HTTP against the real routes.
 *
 * It establishes its own session and project so it is independent of the
 * matrix above, then walks the whole chain: artist search, explicit anchor
 * confirmation, both first hops, one bounded proposal call, and one explicit
 * approval. Afterwards it re-reads the project, repeats the retrieval to show
 * the cache costs nothing, and checks that a second anonymous owner is refused
 * at every phase 3 route.
 *
 * It spends one real model call on the deployed instance. The Qloo retrieval
 * normally spends none, because the captures are shared through the database.
 */
async function phase3Flow(base: string): Promise<void> {
  console.log("");
  console.log("  phase 3 workflow");

  const post = async (path: string, cookie: string, body: unknown, method = "POST") =>
    fetch(`${base}${path}`, {
      method,
      headers: { origin: base, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  const session = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  const cookie = cookieValue(session);
  if (cookie === null) {
    record("phase 3 workflow could establish a session", false, "no cookie");
    return;
  }

  const created = await post("/api/projects", cookie, { brief: brief() });
  const createdBody = (await created.json()) as { project?: { id: string; revision: number } };
  const projectId = createdBody.project?.id;
  if (projectId === undefined) {
    record("phase 3 workflow could create a project", false, `status ${created.status}`);
    return;
  }

  // 1. Artist search.
  const searchResponse = await post(`/api/projects/${projectId}/artist-search`, cookie, {
    query: "Radiohead",
  });
  const searchText = await searchResponse.text();
  const search = JSON.parse(searchText) as {
    search?: {
      capture_id: string | null;
      cache: string;
      candidates: { entity_id: string; name: string; original_rank: number }[];
    };
    project?: { revision: number; anchor_confirmed: boolean };
  };
  record(
    "POST artist-search returns real Qloo candidates",
    searchResponse.status === 200 && (search.search?.candidates.length ?? 0) > 0,
    `status ${searchResponse.status}, ${search.search?.candidates.length ?? 0} candidates, cache ${
      search.search?.cache ?? "none"
    }`,
  );
  record(
    "searching confirms nothing by itself",
    search.project?.anchor_confirmed === false,
    `anchor_confirmed ${String(search.project?.anchor_confirmed)}`,
  );
  record(
    "no affinity or credential shape reaches the browser from artist-search",
    !searchText.includes("affinity") &&
      !CREDENTIAL_SHAPES.some((shape) => shape.pattern.test(searchText)),
    `${searchText.length} bytes scanned`,
  );

  const chosen = search.search?.candidates.find(
    (candidate) => candidate.name.toLowerCase() === "radiohead",
  );
  record(
    "the canonical artist is confirmable by exact name",
    chosen !== undefined,
    chosen === undefined ? "absent" : `${chosen.name} at rank ${chosen.original_rank}`,
  );
  const captureId = search.search?.capture_id ?? null;
  if (chosen === undefined || captureId === null) return;

  // 2. Explicit confirmation. A forged entity id is refused first.
  const forged = await post(
    `/api/projects/${projectId}/anchor`,
    cookie,
    {
      expected_revision: search.project?.revision ?? 1,
      search_capture_id: captureId,
      entity_id: "11111111-2222-4333-8444-555555555555",
    },
    "PUT",
  );
  record(
    "an artist that was not in the snapshot cannot be confirmed",
    forged.status === 422,
    `status ${forged.status}`,
  );

  const anchorResponse = await post(
    `/api/projects/${projectId}/anchor`,
    cookie,
    {
      expected_revision: search.project?.revision ?? 1,
      search_capture_id: captureId,
      entity_id: chosen.entity_id,
    },
    "PUT",
  );
  const anchored = (await anchorResponse.json()) as {
    project?: {
      revision: number;
      anchor?: { name: string; original_rank: number } | null;
      approved_slots: string[];
    };
  };
  record(
    "PUT anchor freezes the explicitly confirmed artist",
    anchorResponse.status === 200 && anchored.project?.anchor?.name === chosen.name,
    `status ${anchorResponse.status}, ${anchored.project?.anchor?.name ?? "none"} at rank ${
      anchored.project?.anchor?.original_rank ?? "unknown"
    }`,
  );
  record(
    "confirming approves nothing",
    (anchored.project?.approved_slots.length ?? 1) === 0,
    `${anchored.project?.approved_slots.length ?? "unknown"} approved`,
  );

  // 3. Both first hops.
  const referencesResponse = await post(`/api/projects/${projectId}/references`, cookie, {
    expected_revision: anchored.project?.revision ?? 2,
  });
  const referencesText = await referencesResponse.text();
  const references = JSON.parse(referencesText) as {
    project?: { revision: number; reference_capture_ids: string[]; workflow_state: string };
    references?: {
      any_usable: boolean;
      movie: { status: string; cache: string | null; usable_count: number; displayed: { name: string }[] };
      videogame: { status: string; cache: string | null; usable_count: number; displayed: { name: string }[] };
    };
    upstream_calls?: number;
  };
  record(
    "POST references returns both domain rows",
    referencesResponse.status === 200 && references.references?.any_usable === true,
    `status ${referencesResponse.status}, upstream calls ${references.upstream_calls ?? "unknown"}` +
      `, movie ${references.references?.movie.usable_count ?? "?"} usable (${
        references.references?.movie.cache ?? "none"
      })` +
      `, videogame ${references.references?.videogame.usable_count ?? "?"} usable (${
        references.references?.videogame.cache ?? "none"
      })`,
  );
  record(
    "the deployed rows show the real first-hop titles",
    (references.references?.movie.displayed.length ?? 0) > 0 &&
      (references.references?.videogame.displayed.length ?? 0) > 0,
    `movies: ${(references.references?.movie.displayed ?? []).map((row) => row.name).join(", ")}` +
      ` · games: ${(references.references?.videogame.displayed ?? []).map((row) => row.name).join(", ")}`,
  );
  record(
    "no affinity, fingerprint, or credential shape reaches the browser from references",
    !referencesText.includes("affinity") &&
      !referencesText.includes("request_fingerprint") &&
      !CREDENTIAL_SHAPES.some((shape) => shape.pattern.test(referencesText)),
    `${referencesText.length} bytes scanned`,
  );

  // 4. One bounded proposal call.
  const proposalsResponse = await post(`/api/projects/${projectId}/proposals`, cookie, {
    expected_revision: references.project?.revision ?? 2,
  });
  const proposals = (await proposalsResponse.json()) as {
    project?: {
      revision: number;
      approved_slots: string[];
      proposals: {
        proposal_id: string;
        slot: string;
        reference_name: string;
        selected_evidence_ids: string[];
      }[];
    };
    model_calls?: number;
    repaired?: boolean;
  };
  record(
    "POST proposals returns a bounded draft from one model call",
    proposalsResponse.status === 200 && (proposals.project?.proposals.length ?? 0) > 0,
    `status ${proposalsResponse.status}, ${
      proposals.project?.proposals.length ?? 0
    } proposals, ${proposals.model_calls ?? "unknown"} model call(s), repaired ${String(
      proposals.repaired,
    )}`,
  );
  record(
    "the default approved count is still zero",
    (proposals.project?.approved_slots.length ?? 1) === 0,
    `${proposals.project?.approved_slots.length ?? "unknown"} approved`,
  );

  const proposal = proposals.project?.proposals[0];
  if (proposal === undefined) return;

  // 5. One explicit approval.
  const decisionResponse = await post(`/api/projects/${projectId}/decisions`, cookie, {
    expected_revision: proposals.project?.revision ?? 2,
    kind: "accept",
    proposal_id: proposal.proposal_id,
  });
  const decided = (await decisionResponse.json()) as {
    project?: {
      revision: number;
      approved_slots: string[];
      approvals: {
        approval_id: string;
        approved_text: string;
        source_kind: string;
        edited_by_creator: boolean;
      }[];
      provenance: Record<string, unknown>[];
    };
    decision_id?: string;
  };
  record(
    "POST decisions approves exactly one influence",
    decisionResponse.status === 200 && (decided.project?.approvals.length ?? 0) === 1,
    `status ${decisionResponse.status}, slots ${
      decided.project?.approved_slots.join(",") ?? "none"
    }, approval ${decided.project?.approvals[0]?.approval_id ?? "none"}`,
  );
  const chain = decided.project?.provenance[0];
  record(
    "the provenance chain exposes three layers and no fourth",
    chain !== undefined &&
      Object.keys(chain).sort().join(",") === "approval_id,approved,proposed,retrieved,slot",
    chain === undefined ? "no chain" : Object.keys(chain).sort().join(","),
  );

  // 6. A reload keeps it, and a repeat retrieval costs nothing.
  const reread = await fetch(`${base}/api/projects/${projectId}`, { headers: { cookie } });
  const rereadBody = (await reread.json()) as {
    project?: { approvals: { approval_id: string }[]; revision: number };
    references?: { movie: { displayed: unknown[] } } | null;
  };
  record(
    "the approval survives a reload of the deployed project",
    reread.status === 200 &&
      rereadBody.project?.approvals[0]?.approval_id === decided.project?.approvals[0]?.approval_id,
    `status ${reread.status}, ${rereadBody.project?.approvals.length ?? 0} approval(s)`,
  );
  record(
    "the reload rebuilt the reference rows from the stored captures",
    (rereadBody.references?.movie.displayed.length ?? 0) > 0,
    `${rereadBody.references?.movie.displayed.length ?? 0} movie cards`,
  );

  const repeat = await post(`/api/projects/${projectId}/references`, cookie, {
    expected_revision: rereadBody.project?.revision ?? 3,
  });
  const repeatBody = (await repeat.json()) as { upstream_calls?: number };
  record(
    "repeating the retrieval on this project makes no upstream Qloo call",
    repeat.status === 200 && repeatBody.upstream_calls === 0,
    `status ${repeat.status}, upstream calls ${repeatBody.upstream_calls ?? "unknown"}`,
  );

  // 7. A second anonymous owner is refused at every phase 3 route.
  const otherSession = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  const otherCookie = cookieValue(otherSession) ?? "";
  const foreignRoutes: { path: string; body: unknown; method?: string }[] = [
    { path: `/api/projects/${projectId}/artist-search`, body: { query: "Radiohead" } },
    {
      path: `/api/projects/${projectId}/anchor`,
      body: {
        expected_revision: 1,
        search_capture_id: captureId,
        entity_id: chosen.entity_id,
      },
      method: "PUT",
    },
    { path: `/api/projects/${projectId}/references`, body: { expected_revision: 1 } },
    { path: `/api/projects/${projectId}/proposals`, body: { expected_revision: 1 } },
    {
      path: `/api/projects/${projectId}/decisions`,
      body: { expected_revision: 1, kind: "accept", proposal_id: proposal.proposal_id },
    },
  ];
  const refusals: string[] = [];
  for (const route of foreignRoutes) {
    const response = await post(route.path, otherCookie, route.body, route.method ?? "POST");
    const text = await response.text();
    const name = route.path.split("/").pop() ?? route.path;
    refusals.push(`${name}:${response.status}`);
    if (response.status !== 404 || text.includes("Radiohead") || text.includes(BRIEF.premise)) {
      record(`a second owner is refused at ${name}`, false, `status ${response.status}`);
      return;
    }
  }
  record(
    "a second anonymous owner is refused at every phase 3 route, identically",
    true,
    refusals.join(" · "),
  );
}

/**
 * The deployed phase 3 workflow, driven through the real browser UI against
 * the real services.
 *
 * This is the phase 3 exit criterion in its strongest form: one browser, one
 * fresh brief, a real artist search, an explicit confirmation click, real
 * first-hop references, one real bounded proposal call, one Approve click, and
 * the provenance drawer opened on the result. Every request the browser makes
 * is recorded, so a direct Qloo, OpenAI, or Supabase call would be caught.
 *
 * It spends one more real model call on the deployed instance.
 */
async function phase3BrowserFlow(base: string): Promise<void> {
  console.log("");
  console.log("  Deployed phase 3 workflow in a real browser");

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await deploymentContext(browser, base);
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(`${base}/studio`, { waitUntil: "load" });
    await page.getByTestId("session-ready").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Save this brief" }).click();
    await page.getByTestId("project-premise").waitFor({ timeout: 30_000 });
    const projectId = await page.getByTestId("project-id").innerText();

    // 1. Artist search, which must not confirm anything.
    await page.getByTestId("artist-query").fill("Radiohead");
    await page.getByTestId("artist-search-submit").click();
    await page.getByTestId("artist-results").waitFor({ timeout: 30_000 });
    const optionCount = await page.getByRole("radio").count();
    const confirmDisabled = await page.getByTestId("anchor-confirm").isDisabled();
    record(
      "the deployed studio lists real artist results and preselects none",
      optionCount > 1 && confirmDisabled,
      `${optionCount} options, confirm disabled ${String(confirmDisabled)}`,
    );

    // 2. Explicit confirmation.
    await page.getByTestId("artist-option-1").check();
    await page.getByTestId("anchor-confirm").click();
    await page.getByTestId("anchor-confirmed").waitFor({ timeout: 30_000 });
    const anchorName = await page.getByTestId("anchor-name").innerText();
    record(
      "clicking confirm freezes the artist the creator chose",
      anchorName.trim() === "Radiohead",
      anchorName.trim(),
    );

    // 3. Real first hops.
    await page.getByTestId("retrieve-references").click();
    await page.getByTestId("domain-row-movie").waitFor({ timeout: 60_000 });
    await page.getByTestId("domain-row-videogame").waitFor({ timeout: 60_000 });
    const movieCards = await page.getByTestId("domain-row-movie").locator(".card").count();
    const gameCards = await page.getByTestId("domain-row-videogame").locator(".card").count();
    record(
      "both deployed domain rows render real reference cards",
      movieCards > 0 && gameCards > 0,
      `${movieCards} movie card(s), ${gameCards} videogame card(s)`,
    );

    const rowsText = await page.locator("main").innerText();
    record(
      "the deployed cards show retrieved context and no quality score",
      rowsText.includes("Qloo describes") &&
        !/\baffinity\b/i.test(rowsText) &&
        !/\bconfidence\b/i.test(rowsText) &&
        !/\b\d{1,3}\s?%/.test(rowsText) &&
        !/Qloo (recommends|proves|says|knows|generated)/i.test(rowsText),
      "wording checked",
    );

    // 4. One real bounded proposal call.
    await page.getByTestId("run-proposals").click();
    await page
      .locator('[data-testid^="approve-ref."]')
      .first()
      .waitFor({ timeout: 90_000 });
    const noApprovalsBefore = await page.getByTestId("no-approvals").count();
    record(
      "the deployed proposals approve nothing by default",
      noApprovalsBefore === 1,
      `no-approvals panel present: ${String(noApprovalsBefore === 1)}`,
    );

    // 5. One explicit approval.
    await page.locator('[data-testid^="approve-ref."]').first().click();
    await page.getByTestId("approved-chips").waitFor({ timeout: 30_000 });
    const chipText = await page.getByTestId("approved-chips").innerText();
    record(
      "clicking Approve freezes exactly one influence",
      (await page.getByTestId("approved-chips").locator("li").count()) === 1,
      chipText.replace(/\s+/g, " ").trim(),
    );

    // 6. The provenance drawer, with its three layers.
    await page.getByTestId("approved-chips").locator("button").first().click();
    const drawer = page.locator('[data-testid^="provenance-"]').first();
    await drawer.waitFor({ timeout: 30_000 });
    const labels = await drawer.locator(".drawer__label").allInnerTexts();
    const layers = labels.map((label) => label.split("\n")[0]?.trim().toLowerCase());
    const drawerText = await drawer.innerText();
    record(
      "the deployed provenance drawer shows retrieval, interpretation and decision",
      layers.length === 3 &&
        layers[0] === "qloo retrieved" &&
        layers[1] === "firstplayable proposed" &&
        layers[2] === "creator approved",
      layers.join(" → "),
    );
    record(
      "and claims no scene change, because no scene has been compiled",
      !/scene changed/i.test(drawerText) && drawerText.includes("Retrieved for Radiohead"),
      "checked",
    );

    // 7. The approval survives a full page load.
    await page.reload({ waitUntil: "load" });
    await page.getByTestId("approved-chips").waitFor({ timeout: 30_000 });
    record(
      "the deployed approval survives a full page reload",
      (await page.getByTestId("approved-chips").locator("li").count()) === 1,
      `project ${projectId.slice(0, 8)}…`,
    );

    // 8. Nothing left the origin.
    const foreign = foreignRequests(requests, base);
    record(
      "the whole deployed workflow made only same-origin requests",
      foreign.length === 0,
      foreign.join(", ") || `${requests.length} requests, all same-origin`,
    );
    const upstream = requests.filter((url) =>
      /qloo\.com|api\.openai\.com|supabase\.(co|in)/i.test(url),
    );
    record(
      "the browser never reached Qloo, OpenAI, or Supabase directly",
      upstream.length === 0,
      upstream.join(", ") || "none",
    );

    const html = await page.content();
    const leaked = CREDENTIAL_SHAPES.filter((shape) => shape.pattern.test(html));
    record(
      "the rendered phase 3 page carries no credential and no provider host",
      leaked.length === 0,
      leaked.map((shape) => shape.name).join(", ") || "clean",
    );

    await page.close();
    await context.close();
  } catch (error) {
    record(
      "the deployed phase 3 browser workflow completed",
      false,
      error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown",
    );
  } finally {
    await browser?.close();
  }
}

/**
 * What the phase 4 browser flow created, so a later run against a freshly
 * deployed server can prove the same owner still gets the same version.
 */
type DeployedVersion = {
  projectId: string;
  versionId: string;
  createdAt: string;
  sceneHash: string;
  cookie: string;
};

let deployedPhase4: DeployedVersion | null = null;

/**
 * The deployed phase 4 compilation, driven through the real browser UI against
 * the real services.
 *
 * This is the phase 4 exit criterion in its strongest form, and the only place
 * the whole chain runs end to end on the deployed instance: one fresh brief, a
 * real artist search, an explicit confirmation, real first-hop references, one
 * real bounded proposal call, one Approve click, one **Build the playable
 * scene** click, the stage list advancing truthfully, the pending validated
 * scene played locally to an ending and reset, the fourth provenance layer read
 * off the stored witness, and one explicit activation that survives a reload.
 * A second browser with its own empty cookie jar is then refused.
 *
 * Every request the browser makes is recorded, and the recording is restarted
 * once the scene is on screen, so "a complete playthrough and a reset make zero
 * requests" is measured rather than asserted.
 *
 * It spends three real model calls on the deployed instance: one proposal, one
 * base, one module. Validation, review, and activation spend none.
 */
async function phase4BrowserFlow(base: string): Promise<void> {
  console.log("");
  console.log("  Deployed phase 4 compilation in a real browser");

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await deploymentContext(browser, base);
    const page = await context.newPage();
    let requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    // ------------------------------------------------- the phase 3 prerequisite
    await page.goto(`${base}/studio`, { waitUntil: "load" });
    await page.getByTestId("session-ready").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Save this brief" }).click();
    await page.getByTestId("project-premise").waitFor({ timeout: 30_000 });
    const projectId = (await page.getByTestId("project-id").innerText()).trim();

    record(
      "the deployed build is refused until an interaction is approved",
      (await page.getByTestId("compile-needs-approval").count()) === 1 &&
        (await page.getByTestId("compile-start").count()) === 0,
      "the panel asks for an approval before offering a build",
    );

    await page.getByTestId("artist-query").fill("Radiohead");
    await page.getByTestId("artist-search-submit").click();
    await page.getByTestId("artist-results").waitFor({ timeout: 30_000 });
    await page.getByTestId("artist-option-1").check();
    await page.getByTestId("anchor-confirm").click();
    await page.getByTestId("anchor-confirmed").waitFor({ timeout: 30_000 });
    await page.getByTestId("retrieve-references").click();
    await page.getByTestId("domain-row-movie").waitFor({ timeout: 60_000 });
    await page.getByTestId("run-proposals").click();
    await page.locator('[data-testid^="approve-ref."]').first().waitFor({ timeout: 120_000 });
    await page.locator('[data-testid^="approve-ref."]').first().click();
    await page.getByTestId("approved-chips").waitFor({ timeout: 30_000 });
    record(
      "the deployed phase 3 prerequisite is one real stored approval",
      (await page.getByTestId("approved-chips").locator("li").count()) === 1,
      `project ${projectId.slice(0, 8)}…`,
    );

    // ------------------------------------------------------------- the build
    await page.getByTestId("compile-start").click();
    await page.getByTestId("compile-stages").waitFor({ timeout: 30_000 });
    await page.getByTestId("pending-review").waitFor({ timeout: 300_000 });

    const stageText = await page.getByTestId("compile-stages").innerText();
    record(
      "every deployed stage reached committed, in the locked wording",
      /Writing encounter/.test(stageText) &&
        /Building (Discovery|Commitment)/.test(stageText) &&
        /Checking choices/.test(stageText) &&
        (stageText.match(/committed/g) ?? []).length >= 3,
      stageText.replace(/\s+/g, " ").trim().slice(0, 220),
    );
    record(
      "no deployed stage exceeded its declared attempt ceiling",
      !/attempts?:? 3/.test(stageText),
      "no stage shows a third attempt",
    );

    const modelCallText = await page.getByTestId("compile-model-calls").innerText();
    const reportedCalls = Number(/(\d+)/.exec(modelCallText)?.[1] ?? "-1");
    const stateText = (await page.getByTestId("compile-state").innerText())
      .replace(/\s+/g, " ")
      .trim();
    record(
      "the deployed compilation reports a real, bounded provider-call count",
      reportedCalls >= 2 && reportedCalls <= 4,
      `${modelCallText.replace(/\s+/g, " ").trim()} · ${stateText}`,
    );

    const pendingVersionId = (await page.getByTestId("pending-version-id").innerText()).trim();
    record(
      "a deployed pending validated scene appears, and nothing is active yet",
      pendingVersionId.length > 0 && (await page.getByTestId("active-playable").count()) === 0,
      `pending ${pendingVersionId.slice(0, 8)}…`,
    );

    // ------------------------------------------- the fourth provenance layer
    const sceneChanged = page.locator('[data-testid^="scene-changed-"]');
    const witness = page.locator('[data-testid^="witness-"]');
    const changedCount = await sceneChanged.count();
    const witnessText = (await witness.allInnerTexts()).join(" ");
    record(
      "the fourth provenance layer appears, once per validated module",
      (await page.getByTestId("where-this-appears").count()) === 1 &&
        changedCount >= 1 &&
        (await witness.count()) === changedCount,
      `${changedCount} "Scene changed" line(s)`,
    );
    record(
      "and reads as a deterministic engine observation, claiming nothing more",
      witnessText.length > 20 &&
        !/qloo|better|original|creative|\bllm\b|proves|unique|superior/i.test(witnessText),
      witnessText.replace(/\s+/g, " ").trim().slice(0, 200),
    );

    // --------------------------------------- the pending scene plays, locally
    await page.getByTestId("pending-choices").waitFor({ timeout: 30_000 });
    // Everything recorded from here is attributable to gameplay alone.
    requests = [];

    let ended = false;
    for (let step = 0; step < 14 && !ended; step += 1) {
      const enabled = page.locator('[data-testid^="pending-choice-"]:not([disabled])');
      if ((await enabled.count()) === 0) break;
      await enabled.first().click();
      ended = (await page.getByTestId("pending-ending").count()) === 1;
    }
    record(
      "the deployed pending scene plays through the real browser engine to an ending",
      ended,
      ended ? "an ending was reached by clicking choices" : "no ending reached",
    );

    await page.getByTestId("pending-reset").first().click();
    await page.getByTestId("pending-choices").waitFor({ timeout: 10_000 });
    record(
      "a complete deployed playthrough and a reset make zero requests of any kind",
      requests.length === 0,
      requests.length === 0
        ? "0 requests caused by choices, the ending, or the reset"
        : requests.join(", "),
    );

    // ------------------------------------------------------ explicit activation
    record(
      "nothing becomes current until the creator confirms",
      (await page.getByTestId("activate-version").count()) === 1 &&
        (await page.getByTestId("decline-version").count()) === 1 &&
        (await page.getByTestId("active-playable").count()) === 0,
      "both review decisions offered, nothing current",
    );

    await page.getByTestId("activate-version").click();
    await page.getByTestId("active-playable").waitFor({ timeout: 60_000 });
    const activeId = (await page.getByTestId("active-version-id").innerText()).trim();
    record(
      "clicking confirm makes exactly the reviewed version current",
      activeId === pendingVersionId && (await page.getByTestId("pending-review").count()) === 0,
      `${activeId.slice(0, 8)}… is active`,
    );

    await page.reload({ waitUntil: "load" });
    await page.getByTestId("active-playable").waitFor({ timeout: 60_000 });
    record(
      "the deployed active version survives a full page reload and still plays",
      (await page.getByTestId("active-version-id").innerText()).trim() === pendingVersionId &&
        (await page.getByTestId("active-choices").count()) === 1,
      (await page.getByTestId("version-list").innerText()).replace(/\s+/g, " ").trim().slice(0, 140),
    );

    // ------------------------------- phase 5 controls on an activated version
    // Before phase 5 this asserted the opposite. Revision, publication, and
    // export are offered only once a version has been confirmed current.
    const offered = await Promise.all(
      ["revision-panel", "publish-panel", "export-download"].map(
        async (id) => [id, await page.getByTestId(id).count()] as const,
      ),
    );
    record(
      "the activated version offers revision, publication, and offline export",
      offered.every(([, count]) => count === 1),
      offered.map(([id, count]) => `${id}:${count}`).join(" "),
    );

    // ------------------------------------------------------------ isolation
    const foreign = foreignRequests(requests, base);
    record(
      "the deployed phase 4 workflow made only same-origin requests",
      foreign.length === 0,
      foreign.join(", ") || "all same-origin",
    );
    const upstream = requests.filter((url) =>
      /qloo\.com|api\.openai\.com|supabase\.(co|in)/i.test(url),
    );
    record(
      "the browser never reached Qloo, OpenAI, or Supabase directly during a build",
      upstream.length === 0,
      upstream.join(", ") || "none",
    );
    const html = await page.content();
    const leaked = CREDENTIAL_SHAPES.filter((shape) => shape.pattern.test(html));
    record(
      "the rendered compiled scene carries no credential and no provider host",
      leaked.length === 0,
      leaked.map((shape) => shape.name).join(", ") || "clean",
    );

    // The owner cookie, kept as a header value only so a later run can prove
    // the same owner still reaches the same version from a fresh server.
    const cookies = await context.cookies();
    const owner = cookies.find((entry) => entry.name === "fp_owner");

    // The version's own identity, read through the application's API with the
    // browser's cookie rather than out of the page.
    const state = await fetch(`${base}/api/projects/${projectId}`, {
      headers: owner === undefined ? {} : { cookie: `fp_owner=${owner.value}` },
    });
    const stateBody = (await state.json()) as {
      playable?: { version_id: string; created_at: string; scene: unknown };
      project?: { active_version_id: string | null };
    };
    deployedPhase4 =
      owner === undefined || stateBody.playable === undefined
        ? null
        : {
            projectId,
            versionId: stateBody.playable.version_id,
            createdAt: stateBody.playable.created_at,
            sceneHash: sha256Hex(JSON.stringify(stateBody.playable.scene)),
            cookie: `fp_owner=${owner.value}`,
          };
    record(
      "the activated version is readable through the API by its owner",
      stateBody.project?.active_version_id === pendingVersionId,
      `active_version_id matches the confirmed version`,
    );

    await page.close();
    await context.close();

    // A genuinely separate browser, with its own empty cookie jar.
    const stranger = await deploymentContext(browser, base);
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(`${base}/studio/${projectId}`, { waitUntil: "load" });
    await strangerPage.getByTestId("project-unavailable").waitFor({ timeout: 30_000 });
    const strangerHtml = await strangerPage.content();
    record(
      "a second deployed browser is refused and cannot build, advance, or activate",
      (await strangerPage.getByTestId("compile-start").count()) === 0 &&
        (await strangerPage.getByTestId("activate-version").count()) === 0 &&
        !strangerHtml.includes(pendingVersionId),
      "the project is not available in a browser that does not own it",
    );
    await stranger.close();
  } catch (error) {
    record(
      "the deployed phase 4 browser workflow completed",
      false,
      error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "unknown",
    );
  } finally {
    await browser?.close();
  }
}

/**
 * The same owner, the same version, a genuinely fresh server.
 *
 * Phase 4 is the first phase with immutable version rows, so "the scene is
 * persisted" has to mean more than "it is still in this process". Run with
 * `DEPLOY_VERIFY_VERSION` naming a version created by an earlier run against a
 * previous deployment, this re-reads it through the new one and compares the
 * version id, its creation time, and a hash of the scene itself.
 */
async function freshServerPersistence(base: string): Promise<void> {
  const carried = process.env["DEPLOY_VERIFY_VERSION"];
  const target =
    carried === undefined || carried.trim().length === 0
      ? deployedPhase4
      : (JSON.parse(carried) as DeployedVersion);
  if (target === null || target === undefined) {
    record(
      "a compiled version was available to re-read from this server",
      false,
      "no version was created in this run and none was carried in",
    );
    return;
  }

  console.log("");
  console.log("  Fresh-server persistence");

  const response = await fetch(`${base}/api/projects/${target.projectId}`, {
    headers: { cookie: target.cookie },
  });
  const body = (await response.json()) as {
    playable?: { version_id: string; created_at: string; scene: unknown; state: string };
    project?: { active_version_id: string | null };
  };
  record(
    "the same owner cookie retrieves the same active version from this server",
    response.status === 200 &&
      body.project?.active_version_id === target.versionId &&
      body.playable?.version_id === target.versionId,
    `status ${response.status}, version ${body.playable?.version_id?.slice(0, 8) ?? "none"}…`,
  );
  record(
    "with the same creation time and the same scene, byte for byte",
    body.playable?.created_at === target.createdAt &&
      sha256Hex(JSON.stringify(body.playable?.scene)) === target.sceneHash,
    `created_at ${body.playable?.created_at ?? "none"}`,
  );
  record(
    "and it is still the active version rather than a pending review",
    body.playable?.state === "active",
    body.playable?.state ?? "none",
  );

  /*
   * A fresh anonymous session must still be refused, and the two refusals are
   * different on purpose.
   *
   * No cookie at all is `401`: the caller has no owner session, so there is
   * nothing to check ownership against. An *established* session that does not
   * own the project is `404`, the same answer a project that does not exist
   * gets, so a stranger learns nothing about whether it is there. This check
   * used to send no cookie while asserting `404`, which asserted the wrong one
   * of the two; the HTTP matrix above covers the cookie-less case.
   */
  const noSession = await fetch(`${base}/api/projects/${target.projectId}`);
  const noSessionText = await noSession.text();
  record(
    "no owner session is still refused, and learns nothing",
    noSession.status === 401 && !noSessionText.includes(target.versionId),
    `status ${noSession.status}`,
  );

  const strangerSession = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  const strangerCookie = cookieValue(strangerSession);
  const stranger = await fetch(`${base}/api/projects/${target.projectId}`, {
    headers: { cookie: strangerCookie ?? "" },
  });
  const strangerText = await stranger.text();
  record(
    "a fresh anonymous session is still denied the same project",
    strangerSession.status === 200 &&
      stranger.status === 404 &&
      !strangerText.includes(target.versionId),
    `session ${strangerSession.status}, read ${stranger.status}`,
  );

  console.log("");
  console.log("  To re-verify this exact version against a later deployment, set");
  console.log("  DEPLOY_VERIFY_VERSION to the object this run recorded. It carries an");
  console.log("  owner cookie, so keep it out of any file that git tracks.");
}

/* ---------------------------------------------------------------- phase 5 */

const PHASE5_BRIEF = {
  title: "The Unsigned Receipt",
  premise:
    "At a repair-shop counter just before closing, Orla asks for the radio she left for mending last month. You are the clerk on the late shift. Decide what to ask, whether to promise it back, and whether to hand it over.",
  player_role: "Repair-shop clerk",
  room: {
    id: "shop",
    name: "Repair-shop counter",
    description: "The blinds are half down. One mended radio waits on the shelf.",
  },
  character: { id: "orla", name: "Orla", role: "Customer asking for her radio" },
  object: {
    id: "radio",
    name: "Mended radio",
    description: "A valve radio, mended last week, with its receipt still unsigned.",
  },
  tone: "intimate",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

/** Keys a public snapshot may carry, and nothing else (src/domain/publish.ts). */
const PUBLIC_SNAPSHOT_KEYS = [
  "active_slots",
  "created_at",
  "identifiers",
  "provenance",
  "provenance_included",
  "scene",
  "schema",
  "title",
  "version_id",
].sort();

type P5Project = {
  id: string;
  revision: number;
  active_version_id: string | null;
  pending_version_id: string | null;
  approved_slots: string[];
  approvals: { approval_id: string; slot: string; reference_id: string; approved_text: string }[];
  proposals: {
    proposal_id: string;
    slot: string;
    reference_id: string;
    idea: string;
    intended_interaction: string;
    capture_id: string | null;
    entity_id: string;
  }[];
};
type P5Playable = {
  version_id: string;
  state: string;
  scene: Scene;
  diff: RevisionDiffView | null;
};
type P5State = {
  project: P5Project;
  playable: P5Playable | null;
  previous_playable: P5Playable | null;
  versions: {
    id: string;
    parent_version_id: string | null;
    state: string;
    base_hash: string;
    module_hashes: Partial<Record<string, string>>;
    active_slots: string[];
    revision_label: string | null;
  }[];
  publications: { id: string; scene_version_id: string; revoked_at: string | null }[];
};
type P5Revision = {
  outcome: string;
  project: P5Project;
  pending_version_id: string | null;
  diff: RevisionDiffView | null;
  preview: { ending_id: string; current_text: string; proposed_text: string; preview_hash: string } | null;
  model_calls: number;
};

async function p5Call<T>(
  base: string,
  path: string,
  cookie: string | null,
  body?: unknown,
  method = "POST",
): Promise<{ status: number; body: T; text: string }> {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers["cookie"] = cookie;
  if (method !== "GET") {
    headers["origin"] = base;
    if (body !== undefined) headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed as T, text };
}

async function p5Session(base: string): Promise<string | null> {
  const response = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: "{}",
  });
  return cookieValue(response);
}

/**
 * Builds and advances one compilation until it has no next stage. Returns the
 * provider calls the controller itself reported, summed across the advances.
 */
async function p5Compile(
  base: string,
  cookie: string,
  projectId: string,
  revision: number,
): Promise<{ state: string; versionId: string | null; providerCalls: number; maxAttempts: number }> {
  const started = await p5Call<{ status: CompilationStatus }>(
    base,
    `/api/projects/${projectId}/compile`,
    cookie,
    { expected_revision: revision },
  );
  if (started.status >= 300) throw new Error(`compile ${started.status}: ${started.text.slice(0, 200)}`);
  let status = started.body.status;
  let providerCalls = 0;
  for (let index = 0; index < 12 && status.next_stage !== null; index += 1) {
    const advanced = await p5Call<{ status: CompilationStatus; model_calls: number }>(
      base,
      `/api/operations/${status.operation_id}/advance`,
      cookie,
      {},
    );
    if (advanced.status >= 300) {
      throw new Error(`advance ${advanced.status}: ${advanced.text.slice(0, 200)}`);
    }
    status = advanced.body.status;
    providerCalls += advanced.body.model_calls;
    if (status.state === "FAILED") break;
  }
  return {
    state: status.state,
    versionId: status.version_id,
    providerCalls,
    maxAttempts: Math.max(0, ...status.stages.map((stage) => stage.attempts)),
  };
}

async function p5Read(base: string, cookie: string, projectId: string): Promise<P5State> {
  const read = await p5Call<P5State>(base, `/api/projects/${projectId}`, cookie, undefined, "GET");
  if (read.status !== 200) throw new Error(`read ${read.status}`);
  return read.body;
}

async function p5Activate(
  base: string,
  cookie: string,
  projectId: string,
  revision: number,
  versionId: string,
): Promise<number> {
  const activated = await p5Call(base, `/api/projects/${projectId}/activate`, cookie, {
    expected_revision: revision,
    version_id: versionId,
  });
  return activated.status;
}

/** JSON with object keys sorted, because Postgres `jsonb` does not keep key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

/**
 * The engine's own recomputation of a stored diff, from exactly the inputs the
 * server had: the two stored scenes, and no id yet for the version being
 * inserted — the row a diff is stored on is its own "after" version.
 */
function sameDiff(stored: RevisionDiffView, before: P5Playable, after: P5Playable): boolean {
  const recomputed = revisionDiffView({
    before: { versionId: before.version_id, scene: before.scene },
    after: { versionId: null, scene: after.scene },
    changedBy: stored.changed_by,
  });
  return recomputed !== null && canonical(recomputed) === canonical(stored);
}

/**
 * The deployed Phase 5 loop: revise one idea, compare, publish, revoke, export.
 *
 * It drives the real routes over HTTP so every count is the server's own:
 * provider calls come from each response, hashes from each stored version, and
 * each diff is recomputed here from the two stored scenes through the same
 * engine and compared byte for byte with the one the server stored. Then a
 * genuinely separate browser plays the public link, and a third plays the
 * exported file from disk with the network blocked.
 *
 * It spends real model calls: one proposal draft, one two-slot compilation,
 * one recompilation per edit or replace, and one ending-wording preview.
 */
async function phase5Flow(base: string): Promise<void> {
  console.log("");
  console.log("  Deployed phase 5 revision, publication, and export");

  try {
    const cookie = await p5Session(base);
    if (cookie === null) {
      record("phase 5 could establish a session", false, "no cookie");
      return;
    }

    // ------------------------------------------- two real approved influences
    const created = await p5Call<{ project: P5Project }>(base, "/api/projects", cookie, {
      brief: PHASE5_BRIEF,
    });
    const projectId = created.body?.project?.id;
    if (created.status !== 201 || projectId === undefined) {
      record("phase 5 could create a project", false, `status ${created.status}`);
      return;
    }
    const searched = await p5Call<{
      search: { capture_id: string | null; candidates: { entity_id: string; name: string }[] };
      project: P5Project;
    }>(base, `/api/projects/${projectId}/artist-search`, cookie, { query: "Radiohead" });
    const candidate = searched.body.search.candidates.find(
      (entry) => entry.name.toLowerCase() === "radiohead",
    );
    if (candidate === undefined) {
      record("phase 5 could confirm the canonical artist", false, `status ${searched.status}`);
      return;
    }
    const anchored = await p5Call<{ project: P5Project }>(
      base,
      `/api/projects/${projectId}/anchor`,
      cookie,
      {
        expected_revision: searched.body.project.revision,
        search_capture_id: searched.body.search.capture_id,
        entity_id: candidate.entity_id,
      },
      "PUT",
    );
    const retrieved = await p5Call<{ project: P5Project }>(
      base,
      `/api/projects/${projectId}/references`,
      cookie,
      { expected_revision: anchored.body.project.revision },
    );
    const proposed = await p5Call<{ project: P5Project; model_calls: number }>(
      base,
      `/api/projects/${projectId}/proposals`,
      cookie,
      { expected_revision: retrieved.body.project.revision },
    );
    if (proposed.status !== 200) {
      record("phase 5 received a proposal draft", false, `status ${proposed.status}`);
      return;
    }
    const draft = proposed.body.project.proposals;
    const pick = (slot: string) => draft.find((entry) => entry.slot === slot);
    const firstDiscovery = pick("discovery");
    const firstCommitment = pick("commitment");
    if (firstDiscovery === undefined || firstCommitment === undefined) {
      record(
        "the draft offers a proposal for each slot",
        false,
        draft.map((entry) => entry.slot).join(",") || "empty",
      );
      return;
    }
    let revision = proposed.body.project.revision;
    for (const chosen of [firstDiscovery, firstCommitment]) {
      const decided = await p5Call<{ project: P5Project }>(
        base,
        `/api/projects/${projectId}/decisions`,
        cookie,
        { expected_revision: revision, kind: "accept", proposal_id: chosen.proposal_id },
      );
      revision = decided.body.project.revision;
    }

    const first = await p5Compile(base, cookie, projectId, revision);
    let state = await p5Read(base, cookie, projectId);
    record(
      "a fresh two-influence scene compiles on the deployment",
      first.state !== "FAILED" && first.versionId !== null &&
        state.project.pending_version_id === first.versionId,
      `${first.providerCalls} provider calls, state ${first.state}`,
    );
    if (first.versionId === null) return;
    await p5Activate(base, cookie, projectId, state.project.revision, first.versionId);
    state = await p5Read(base, cookie, projectId);
    const v1 = state.playable;
    const v1Summary = state.versions.find((entry) => entry.id === first.versionId);
    if (v1 === null || v1Summary === undefined) {
      record("the first version became active", false, "no active playable");
      return;
    }
    const v1Sorted = [...v1Summary.active_slots].sort().join("+");
    record(
      "the first version is active with both influences",
      state.project.active_version_id === first.versionId && v1Sorted === "commitment+discovery",
      v1Sorted,
    );

    // ----------------------------------------------- edit one interpretation
    const editText =
      "Reading the receipt aloud reveals a second signature, and she will not take the radio until that name is said.";
    const edited = await p5Call<P5Revision>(base, `/api/projects/${projectId}/revisions`, cookie, {
      expected_revision: state.project.revision,
      kind: "edit",
      slot: "discovery",
      approved_text: editText,
      intended_effect: "Asking about the signature opens a question the clerk can then put to her.",
    });
    record(
      "an arbitrary interpretation edit records one approval and makes no provider call",
      edited.status === 200 &&
        edited.body.outcome === "requires_compilation" &&
        edited.body.model_calls === 0 &&
        state.project.active_version_id === edited.body.project.active_version_id,
      `${edited.status} ${edited.body?.outcome ?? edited.text.slice(0, 120)}, calls ${edited.body?.model_calls}`,
    );
    const second = await p5Compile(base, cookie, projectId, edited.body.project.revision);
    state = await p5Read(base, cookie, projectId);
    const v2Summary = state.versions.find((entry) => entry.id === second.versionId);
    record(
      "the edit recompiles only its own slot, with exactly one provider call",
      second.state !== "FAILED" && second.providerCalls === 1,
      `${second.providerCalls} provider call(s), state ${second.state}, max attempts ${second.maxAttempts}`,
    );
    record(
      "the base and the other slot's module hashes are identical; the edited slot's is not",
      v2Summary !== undefined &&
        v2Summary.base_hash === v1Summary.base_hash &&
        v2Summary.module_hashes["commitment"] === v1Summary.module_hashes["commitment"] &&
        v2Summary.module_hashes["discovery"] !== v1Summary.module_hashes["discovery"],
      v2Summary === undefined
        ? "no second version"
        : `base ${v2Summary.base_hash.slice(0, 10)}=${v1Summary.base_hash.slice(0, 10)}, commitment ${String(
            v2Summary.module_hashes["commitment"] === v1Summary.module_hashes["commitment"],
          )}`,
    );
    const pendingV2 = state.playable;
    record(
      "the edited version's stored diff names discovery and preserves world, core, and commitment",
      pendingV2 !== null &&
        pendingV2.diff !== null &&
        pendingV2.diff.changed_slots.join(",") === "discovery" &&
        pendingV2.diff.unchanged.world &&
        pendingV2.diff.unchanged.core &&
        pendingV2.diff.unchanged.modules["commitment"] === true,
      pendingV2?.diff === null || pendingV2 === null
        ? "no diff"
        : `label ${pendingV2.diff.label}, mechanical ${pendingV2.diff.mechanical_change}`,
    );
    record(
      "and that stored diff is exactly what the engine recomputes from the two stored scenes",
      pendingV2 !== null && pendingV2.diff !== null && sameDiff(pendingV2.diff, v1, pendingV2),
      "deterministic, byte-identical",
    );
    record(
      "the previous version is untouched and still active while the edit awaits review",
      state.project.active_version_id === first.versionId &&
        state.playable?.version_id === second.versionId,
      `active ${state.project.active_version_id?.slice(0, 8)}…, pending ${second.versionId?.slice(0, 8)}…`,
    );
    if (second.versionId === null || pendingV2 === null) return;
    await p5Activate(base, cookie, projectId, state.project.revision, second.versionId);
    state = await p5Read(base, cookie, projectId);
    const v2 = state.playable as P5Playable;
    record(
      "the previous version stays playable beside the current one",
      state.previous_playable?.version_id === first.versionId &&
        state.versions.some((entry) => entry.id === first.versionId),
      `${state.versions.length} versions listed`,
    );

    // --------------------------------- publish this version, before revising on
    const previewed = await p5Call<{ snapshot: Record<string, unknown>; snapshot_hash: string }>(
      base,
      `/api/projects/${projectId}/publish`,
      cookie,
      {
        expected_revision: state.project.revision,
        version_id: v2.version_id,
        include_provenance: true,
        preview: true,
      },
    );
    const afterPreview = await p5Read(base, cookie, projectId);
    record(
      "a publication preview returns the document and publishes nothing",
      previewed.status === 200 && afterPreview.publications.length === 0,
      `status ${previewed.status}, ${afterPreview.publications.length} publications`,
    );
    const wrongHash = await p5Call(base, `/api/projects/${projectId}/publish`, cookie, {
      expected_revision: state.project.revision,
      version_id: v2.version_id,
      include_provenance: false,
      preview: false,
      snapshot_hash: previewed.body.snapshot_hash,
    });
    record(
      "publishing a document other than the previewed one is refused",
      wrongHash.status >= 400 && wrongHash.status < 500,
      `status ${wrongHash.status}`,
    );
    const stranger = await p5Session(base);
    const strangerPublish = await p5Call(base, `/api/projects/${projectId}/publish`, stranger, {
      expected_revision: state.project.revision,
      version_id: v2.version_id,
      include_provenance: true,
      preview: true,
    });
    record("another session cannot preview or publish this project", strangerPublish.status === 404, `status ${strangerPublish.status}`);
    const published = await p5Call<{
      play_path: string;
      publication: { id: string; scene_version_id: string };
    }>(base, `/api/projects/${projectId}/publish`, cookie, {
      expected_revision: state.project.revision,
      version_id: v2.version_id,
      include_provenance: true,
      preview: false,
      snapshot_hash: previewed.body.snapshot_hash,
    });
    const playPath = published.body?.play_path ?? "";
    const token = playPath.split("/").pop() ?? "";
    record(
      "publishing the previewed version returns a version-pinned read link once",
      published.status === 201 &&
        published.body.publication.scene_version_id === v2.version_id &&
        /^\/play\/[A-Za-z0-9_-]{43}$/.test(playPath),
      `status ${published.status}, path /play/<${token.length}-character token>`,
    );
    const publicationId = published.body?.publication?.id ?? "";

    // ----------------------------------------------- replace one influence
    state = await p5Read(base, cookie, projectId);
    const currentCommitment = state.project.approvals.find((entry) => entry.slot === "commitment");
    const alternative = state.project.proposals.find(
      (entry) => entry.slot === "commitment" && entry.reference_id !== currentCommitment?.reference_id,
    );
    if (alternative === undefined) {
      record(
        "the draft offers a different commitment reference to replace with",
        false,
        "no alternative commitment proposal in the current draft",
      );
    } else {
      const replaced = await p5Call<P5Revision>(base, `/api/projects/${projectId}/revisions`, cookie, {
        expected_revision: state.project.revision,
        kind: "replace",
        slot: "commitment",
        proposal_id: alternative.proposal_id,
      });
      const third = await p5Compile(base, cookie, projectId, replaced.body.project.revision);
      state = await p5Read(base, cookie, projectId);
      const v3Summary = state.versions.find((entry) => entry.id === third.versionId);
      const v2Summary2 = state.versions.find((entry) => entry.id === v2.version_id);
      record(
        "replacing one influence makes no call itself and recompiles that slot with one call",
        replaced.status === 200 &&
          replaced.body.model_calls === 0 &&
          third.state !== "FAILED" &&
          third.providerCalls === 1,
        `${replaced.status} ${replaced.body?.outcome}, then ${third.providerCalls} provider call(s)`,
      );
      record(
        "the base and the discovery module are untouched by the replacement",
        v3Summary !== undefined &&
          v2Summary2 !== undefined &&
          v3Summary.base_hash === v2Summary2.base_hash &&
          v3Summary.module_hashes["discovery"] === v2Summary2.module_hashes["discovery"] &&
          v3Summary.module_hashes["commitment"] !== v2Summary2.module_hashes["commitment"],
        v3Summary === undefined ? "no third version" : `label ${v3Summary.revision_label}`,
      );
      if (third.versionId !== null && state.playable !== null) {
        record(
          "the replacement's stored diff is exactly the engine's recomputation",
          state.playable.diff !== null && sameDiff(state.playable.diff, v2, state.playable),
          `changed ${state.playable.diff?.changed_slots.join(",")}`,
        );
        await p5Activate(base, cookie, projectId, state.project.revision, third.versionId);
        state = await p5Read(base, cookie, projectId);
      }
    }

    // ------------------------------------ ending wording, previewed then applied
    const beforeCopy = state.playable as P5Playable;
    const previewCopy = await p5Call<P5Revision>(base, `/api/projects/${projectId}/revisions`, cookie, {
      expected_revision: state.project.revision,
      kind: "ending_copy_preview",
      ending_id: "end.give",
      request: "Make this ending kinder to her.",
    });
    const afterPreviewCopy = await p5Read(base, cookie, projectId);
    const previewBody = previewCopy.body?.preview;
    record(
      "an ending rewrite is previewed with one text-only provider call and applies nothing",
      previewCopy.status === 200 &&
        previewCopy.body.outcome === "preview" &&
        previewCopy.body.model_calls === 1 &&
        previewBody !== null &&
        previewBody !== undefined &&
        afterPreviewCopy.project.active_version_id === beforeCopy.version_id &&
        afterPreviewCopy.project.pending_version_id === null,
      `${previewCopy.status} ${previewCopy.body?.outcome ?? previewCopy.text.slice(0, 160)}`,
    );
    if (previewBody !== null && previewBody !== undefined) {
      const forged = await p5Call(base, `/api/projects/${projectId}/revisions`, cookie, {
        expected_revision: afterPreviewCopy.project.revision,
        kind: "ending_copy_apply",
        ending_id: "end.give",
        // Valid wording that is not the previewed wording.
        text:
          previewBody.proposed_text.length < 1100
            ? `${previewBody.proposed_text} And the gate opens.`
            : previewBody.proposed_text.slice(0, -1),
        preview_hash: previewBody.preview_hash,
      });
      record(
        "applying wording other than the previewed text is refused",
        forged.status >= 400 && forged.status < 500 && forged.text.includes("PREVIEW_MISMATCH"),
        `status ${forged.status}`,
      );
      const applied = await p5Call<P5Revision>(base, `/api/projects/${projectId}/revisions`, cookie, {
        expected_revision: afterPreviewCopy.project.revision,
        kind: "ending_copy_apply",
        ending_id: "end.give",
        text: previewBody.proposed_text,
        preview_hash: previewBody.preview_hash,
      });
      const copyDiff = applied.body?.diff;
      record(
        "the explicit apply composes a version with no provider call, labelled wording",
        applied.status === 200 &&
          applied.body.outcome === "version_pending" &&
          applied.body.model_calls === 0 &&
          copyDiff !== null &&
          copyDiff !== undefined &&
          copyDiff.label === "wording" &&
          copyDiff.mechanical_change === false &&
          copyDiff.structure_identical,
        `${applied.status} ${applied.body?.outcome ?? applied.text.slice(0, 160)}, label ${copyDiff?.label}`,
      );
      state = await p5Read(base, cookie, projectId);
      const copied = state.playable;
      // An applied wording is an override beside the base ending, never an edit
      // of the base ending itself, so the base text stays byte-identical.
      const overrides = copied?.scene.ending_copy_overrides ?? [];
      record(
        "only that one ending's wording changed, as an override, with mechanics identical",
        copied !== null &&
          beforeCopy.scene.ending_copy_overrides.length === 0 &&
          overrides.length === 1 &&
          overrides[0]?.ending_id === "end.give" &&
          overrides[0]?.text === previewBody.proposed_text &&
          canonical(copied.scene.core.endings) === canonical(beforeCopy.scene.core.endings) &&
          canonical(mechanicalSignature(copied.scene)) ===
            canonical(mechanicalSignature(beforeCopy.scene)),
        `${overrides.length} override(s), base endings and mechanical signature identical`,
      );
      if (copied !== null && applied.body.pending_version_id !== null) {
        record(
          "the wording diff is exactly the engine's recomputation",
          copied.diff !== null && sameDiff(copied.diff, beforeCopy, copied),
          `summary: ${copied.diff?.summary[0] ?? "none"}`,
        );
        await p5Activate(base, cookie, projectId, state.project.revision, applied.body.pending_version_id);
        state = await p5Read(base, cookie, projectId);
      }
    }

    // -------------------------------------------------- remove one influence
    const beforeRemove = state.playable as P5Playable;
    const beforeRemoveSummary = state.versions.find((entry) => entry.id === beforeRemove.version_id);
    const removed = await p5Call<P5Revision>(base, `/api/projects/${projectId}/revisions`, cookie, {
      expected_revision: state.project.revision,
      kind: "remove",
      slot: "discovery",
    });
    state = await p5Read(base, cookie, projectId);
    const afterRemove = state.playable;
    const removedSummary = state.versions.find((entry) => entry.id === removed.body?.pending_version_id);
    record(
      "removing an influence composes a validated version with zero provider calls",
      removed.status === 200 &&
        removed.body.outcome === "version_pending" &&
        removed.body.model_calls === 0 &&
        removedSummary !== undefined &&
        removedSummary.active_slots.join(",") === "commitment",
      `${removed.status} ${removed.body?.outcome ?? removed.text.slice(0, 160)}, calls ${removed.body?.model_calls}`,
    );
    record(
      "the removal preserves the base and the remaining module, and keeps the applied wording",
      removedSummary !== undefined &&
        beforeRemoveSummary !== undefined &&
        removedSummary.base_hash === beforeRemoveSummary.base_hash &&
        removedSummary.module_hashes["commitment"] === beforeRemoveSummary.module_hashes["commitment"] &&
        removedSummary.module_hashes["discovery"] === undefined &&
        afterRemove !== null &&
        beforeRemove.scene.ending_copy_overrides.length === 1 &&
        canonical(afterRemove.scene.ending_copy_overrides) ===
          canonical(beforeRemove.scene.ending_copy_overrides),
      `label ${afterRemove?.diff?.label ?? "none"}, mechanical ${afterRemove?.diff?.mechanical_change}`,
    );
    record(
      "the removal's stored diff is exactly the engine's recomputation",
      afterRemove !== null && afterRemove.diff !== null && sameDiff(afterRemove.diff, beforeRemove, afterRemove),
      `removed ${afterRemove?.diff?.removed_action_ids.length ?? 0} action(s)`,
    );
    if (removed.body?.pending_version_id) {
      await p5Activate(base, cookie, projectId, state.project.revision, removed.body.pending_version_id);
      state = await p5Read(base, cookie, projectId);
    }

    // ------------------------------------------------ immutable version history
    const history = state.versions;
    const historyAgain = (await p5Read(base, cookie, projectId)).versions;
    record(
      "every version is still listed, linked to its parent, and reads back identically",
      history.length >= 4 &&
        history.some((entry) => entry.id === first.versionId) &&
        history.filter((entry) => entry.parent_version_id !== null).length === history.length - 1 &&
        JSON.stringify(history) === JSON.stringify(historyAgain),
      history.map((entry) => `${entry.id.slice(0, 6)}:${entry.revision_label ?? "first"}`).join(" "),
    );

    // ---------------------------------------- the public link, from a stranger
    const publicRead = await p5Call<{ snapshot: Record<string, unknown>; published_at: string }>(
      base,
      `/api/public/${token}`,
      null,
      undefined,
      "GET",
    );
    const snapshot = publicRead.body?.snapshot ?? {};
    record(
      "the public link still plays the version it was published from, after four more revisions",
      publicRead.status === 200 && snapshot["version_id"] === v2.version_id,
      `status ${publicRead.status}, version ${String(snapshot["version_id"]).slice(0, 8)}…`,
    );
    record(
      "the public payload carries exactly the whitelisted keys",
      JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify(PUBLIC_SNAPSHOT_KEYS) &&
        JSON.stringify(Object.keys(publicRead.body ?? {}).sort()) ===
          JSON.stringify(["published_at", "snapshot"]),
      Object.keys(snapshot).sort().join(","),
    );
    const unapproved = draft
      .filter(
        (entry) =>
          entry.proposal_id !== firstDiscovery.proposal_id &&
          entry.proposal_id !== firstCommitment.proposal_id,
      )
      .map((entry) => entry.idea);
    const privateMarkers = [
      projectId,
      PHASE5_BRIEF.premise,
      "Radiohead",
      cookie.split("=")[1] ?? "fp_owner",
      ...draft.flatMap((entry) => [entry.capture_id ?? "", entry.entity_id]),
      ...unapproved,
    ].filter((marker) => marker.length > 0);
    const leakedPrivate = privateMarkers.filter((marker) => publicRead.text.includes(marker));
    const leakedShapes = CREDENTIAL_SHAPES.filter((shape) => shape.pattern.test(publicRead.text));
    record(
      "no project id, brief, artist, owner cookie, capture, entity id, or unapproved idea is public",
      leakedPrivate.length === 0 && leakedShapes.length === 0,
      leakedPrivate.length === 0
        ? `${privateMarkers.length} private markers checked, ${unapproved.length} unapproved ideas`
        : `${leakedPrivate.length} leaked`,
    );
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch();
      const viewer = await deploymentContext(browser, base);
      const page = await viewer.newPage();
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      await page.goto(`${base}${playPath}`, { waitUntil: "load" });
      await page.getByTestId("public-player").waitFor({ timeout: 30_000 });
      const loadedVersion = (await page.getByTestId("public-version-id").innerText()).trim();
      const beforePlay = requests.length;
      let ended = false;
      for (let stepIndex = 0; stepIndex < 14 && !ended; stepIndex += 1) {
        const enabled = page.locator('[data-testid^="public-choice-"]:not([disabled])');
        if ((await enabled.count()) === 0) break;
        await enabled.first().click();
        ended = (await page.getByTestId("public-ending").count()) === 1;
      }
      const playRequests = requests.slice(beforePlay);
      record(
        "a fresh browser with no session plays the shared version to an ending, read-only",
        loadedVersion === v2.version_id && ended && playRequests.length === 0,
        `ended ${ended}, ${playRequests.length} requests during play`,
      );
      const actionable = (await page.locator("button, a, input, select, textarea").allInnerTexts())
        .join(" ")
        .toLowerCase();
      const owned = ["publish", "revoke", "withdraw", "export", "download", "remove this influence", "build"]
        .filter((word) => actionable.includes(word));
      const robots = await page.locator('meta[name="robots"]').getAttribute("content");
      const shareHtml = await page.content();
      record(
        "the shared page offers no owner control, is noindex, and renders nothing private",
        owned.length === 0 &&
          (robots ?? "").includes("noindex") &&
          privateMarkers.every((marker) => !shareHtml.includes(marker)),
        owned.join(",") || `robots "${robots}"`,
      );
      const upstream = requests.filter((url) => /qloo\.com|api\.openai\.com|supabase\.(co|in)/i.test(url));
      record(
        "the shared page reached no provider and no foreign origin",
        upstream.length === 0 && foreignRequests(requests, base).length === 0,
        foreignRequests(requests, base).join(", ") || "same-origin only",
      );
      await viewer.close();

      // ----------------------------------------------------------- revocation
      const strangerRevoke = await p5Call(base, `/api/publications/${publicationId}`, stranger, undefined, "DELETE");
      record("another session cannot revoke the link", strangerRevoke.status === 404, `status ${strangerRevoke.status}`);
      const revoked = await p5Call<{ outcome: string }>(
        base,
        `/api/publications/${publicationId}`,
        cookie,
        undefined,
        "DELETE",
      );
      const afterRevoke = await p5Call(base, `/api/public/${token}`, null, undefined, "GET");
      const unknown = await p5Call(base, `/api/public/${"A".repeat(43)}`, null, undefined, "GET");
      const strip = (text: string) => text.replace(/"request_id":"[^"]+"/, "");
      record(
        "revoking stops the token on the very next read, indistinguishable from an unknown one",
        revoked.status === 200 &&
          revoked.body.outcome === "revoked" &&
          afterRevoke.status === 404 &&
          unknown.status === 404 &&
          strip(afterRevoke.text) === strip(unknown.text),
        `revoke ${revoked.status}, next read ${afterRevoke.status}`,
      );
      const again = await p5Call<{ outcome: string }>(base, `/api/publications/${publicationId}`, cookie, undefined, "DELETE");
      record("revoking twice is idempotent", again.status === 200 && again.body.outcome === "already_revoked", again.body?.outcome ?? `${again.status}`);
      const fresh = await deploymentContext(browser, base);
      const freshPage = await fresh.newPage();
      await freshPage.goto(`${base}${playPath}`, { waitUntil: "load" });
      // Wait for either outcome, so a link that still plays is recorded as a
      // failure here rather than ending the checks that follow.
      await freshPage
        .getByTestId("public-unavailable")
        .or(freshPage.getByTestId("public-player"))
        .waitFor({ timeout: 30_000 });
      record(
        "a fresh browser opening the revoked link sees the clean unavailable screen",
        (await freshPage.getByTestId("public-unavailable").count()) === 1 &&
          (await freshPage.getByTestId("public-player").count()) === 0,
        (await freshPage.getByTestId("public-unavailable").count()) === 1
          ? "public-unavailable shown"
          : "the revoked link still played",
      );
      await fresh.close();

      // ------------------------------------------------------- offline export
      const activeId = state.project.active_version_id ?? "";
      const exported = await fetch(`${base}/api/projects/${projectId}/export?version=${activeId}`, {
        headers: { cookie },
      });
      const exportHtml = await exported.text();
      const strangerExport = await p5Call(base, `/api/projects/${projectId}/export?version=${activeId}`, stranger, undefined, "GET");
      const anonymousExport = await p5Call(base, `/api/projects/${projectId}/export?version=${activeId}`, null, undefined, "GET");
      record(
        "the export is an owner-only attachment",
        exported.status === 200 &&
          (exported.headers.get("content-disposition") ?? "").startsWith("attachment") &&
          strangerExport.status === 404 &&
          anonymousExport.status === 401,
        `owner ${exported.status}, stranger ${strangerExport.status}, anonymous ${anonymousExport.status}`,
      );
      const exportLeaks = [
        ...privateMarkers.filter((marker) => exportHtml.includes(marker)),
        ...CREDENTIAL_SHAPES.filter((shape) => shape.pattern.test(exportHtml)).map((shape) => shape.name),
      ];
      const externalRefs = [...exportHtml.matchAll(/(?:src|href)\s*=\s*["']?(https?:|\/\/)/gi)].length;
      record(
        "the exported bytes carry no private data, credential, provider host, or external reference",
        exportLeaks.length === 0 &&
          externalRefs === 0 &&
          !/qloo|openai|supabase/i.test(exportHtml),
        exportLeaks.length === 0 ? `${exportHtml.length} bytes clean` : `${exportLeaks.length} leaked`,
      );
      const directory = mkdtempSync(join(tmpdir(), "fp-deployed-export-"));
      const file = join(directory, "exported.html");
      writeFileSync(file, exportHtml, "utf8");
      const offline = await browser.newContext({ offline: true });
      const offlinePage = await offline.newPage();
      const blocked: string[] = [];
      await offlinePage.route(/^(https?|wss?):/, async (route) => {
        blocked.push(route.request().url());
        await route.abort();
      });
      const violations: string[] = [];
      offlinePage.on("console", (message) => {
        if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
      });
      await offlinePage.goto(pathToFileURL(file).href);
      await offlinePage.locator(".fp-choices").waitFor({ timeout: 15_000 });
      let offlineEnded = false;
      for (let stepIndex = 0; stepIndex < 14 && !offlineEnded; stepIndex += 1) {
        const enabled = offlinePage.locator(".fp-choice:not(.fp-choice-locked):not([disabled])");
        if ((await enabled.count()) === 0) break;
        await enabled.first().click();
        offlineEnded = (await offlinePage.locator(".fp-ending").count()) > 0;
      }
      // At an ending the player offers "Play it again"; mid-scene, "Start over".
      await offlinePage
        .locator("button", { hasText: offlineEnded ? "Play it again" : "Start over" })
        .first()
        .click();
      const resetTranscript = await offlinePage.locator(".fp-transcript li").count();
      const resetChoices = await offlinePage.locator(".fp-choice").count();
      record(
        "the exported file plays from file:// to an ending and resets, with the network offline",
        offlineEnded && resetTranscript === 0 && resetChoices > 0,
        `ended ${offlineEnded}, transcript after reset ${resetTranscript}, ${resetChoices} choices offered`,
      );
      record(
        "and it requested nothing at all — no OpenAI, Qloo, Supabase, or any other host",
        blocked.length === 0 && violations.length === 0,
        blocked.join(", ") || `0 requests, ${violations.length} policy violations`,
      );
      await offline.close();

      // ------------------------------------------------ the owner's studio
      const studio = await deploymentContext(browser, base);
      const ownerValue = cookie.slice("fp_owner=".length);
      await studio.addCookies([{ name: "fp_owner", value: ownerValue, url: base, httpOnly: true, secure: true }]);
      const studioPage = await studio.newPage();
      await studioPage.goto(`${base}/studio/${projectId}`, { waitUntil: "load" });
      await studioPage.getByTestId("version-compare").waitFor({ timeout: 60_000 });
      const panels = await Promise.all(
        ["revision-panel", "version-compare", "publish-panel", "export-download", "publication-list"].map(
          async (id) => [id, await studioPage.getByTestId(id).count()] as const,
        ),
      );
      record(
        "the owner's studio shows revision, comparison, the withdrawn link, and export",
        panels.every(([, count]) => count === 1) &&
          (await studioPage.getByTestId("publication-list").innerText()).toLowerCase().includes("withdrawn"),
        panels.map(([id, count]) => `${id}:${count}`).join(" "),
      );
      await studio.close();
    } finally {
      await browser?.close();
    }
  } catch (error) {
    record(
      "the deployed phase 5 workflow completed",
      false,
      error instanceof Error
        ? // A bare "fetch failed" hides the transport reason, which is in `cause`.
          `${error.name}: ${error.message.slice(0, 300)}${
            error.cause instanceof Error
              ? ` (cause: ${(error.cause as { code?: string }).code ?? error.cause.name}: ${error.cause.message.slice(0, 160)})`
              : ""
          }`
        : "unknown",
    );
  }
}

async function main(): Promise<void> {
  if (process.env[GUARD] !== "1") {
    console.log(
      [
        "verify:deployment did not run, and contacted nothing.",
        "",
        "It writes a project to the deployed application, so it is opt-in:",
        "",
        `  ${GUARD}=1 DEPLOY_URL=https://… npm run verify:deployment`,
      ].join("\n"),
    );
    process.exitCode = 0;
    return;
  }

  const raw = process.env["DEPLOY_URL"];
  if (raw === undefined || raw.trim().length === 0) {
    console.error("verify:deployment FAILED — set DEPLOY_URL to the deployment to verify");
    process.exitCode = 1;
    return;
  }
  const base = raw.trim().replace(/\/+$/, "");
  installFetchBypass(base);

  console.log("verify:deployment");
  console.log(`  target            ${base}`);
  console.log(`  protection bypass ${bypassSecret() === null ? "not used" : "sent to the target origin only"}`);
  console.log("");

  const landing = await fetch(`${base}/`);
  record("the landing page loads", landing.status === 200, `status ${landing.status}`);
  const example = await fetch(`${base}/example`);
  record("/example loads", example.status === 200, `status ${example.status}`);
  const studio = await fetch(`${base}/studio`);
  record("/studio loads", studio.status === 200, `status ${studio.status}`);
  console.log("");

  await httpMatrix(base);
  await phase3Flow(base);
  await browserChecks(base);
  await phase3BrowserFlow(base);
  await phase4BrowserFlow(base);
  await phase5Flow(base);
  await freshServerPersistence(base);
  await clientBundleScan(base);

  const failed = checks.filter((check) => !check.ok).length;
  console.log("");
  if (previewToolbarExempted > 0) {
    console.log(
      `  note: ${previewToolbarExempted} request(s) to the Vercel preview toolbar (${PREVIEW_TOOLBAR_PREFIX}) were exempted from the same-origin checks; production is checked without this exemption`,
    );
  }
  console.log(
    failed === 0
      ? `verify:deployment OK — ${checks.length} checks passed`
      : `verify:deployment FAILED — ${failed} of ${checks.length} checks failed`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
