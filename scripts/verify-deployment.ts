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
 * It is never part of `npm test`, `npm run test:e2e`, or `npm run build`.
 * It prints no credential: cookie values are only ever passed back as headers.
 */

import { chromium, type Browser, type BrowserContext } from "@playwright/test";

import { sha256Hex } from "../src/engine/hash";

const GUARD = "RUN_DEPLOY_VERIFY";

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

function foreignRequests(requests: readonly string[], base: string): string[] {
  return requests.filter(
    (url) => !url.startsWith(base) && !url.startsWith("data:") && !url.startsWith("blob:"),
  );
}

async function browserChecks(base: string): Promise<void> {
  console.log("");
  console.log("  Two isolated browser contexts");

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ownerContext = await browser.newContext();
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
      const strangerContext = await browser.newContext();
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
    const playContext = await browser.newContext();
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
    const context = await browser.newContext();
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
    const context = await browser.newContext();
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

    // ------------------------------------------------- no phase 5 capability
    const actionable = await page
      .locator("button, a, [role=button], input, select, textarea")
      .allInnerTexts();
    const offending = actionable
      .map((label) => label.trim().toLowerCase())
      .filter((label) =>
        ["revise", "publish", "share", "export", "revoke", "public link", "compare"].some(
          (banned) => label.includes(banned),
        ),
      );
    record(
      "no deployed revision, share, publish, export, or compare control exists",
      offending.length === 0,
      offending.join(", ") || `${actionable.length} actionable elements checked`,
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
    const stranger = await browser.newContext();
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

  // A fresh anonymous session must still be refused.
  const stranger = await fetch(`${base}/api/projects/${target.projectId}`);
  const strangerText = await stranger.text();
  record(
    "a fresh anonymous session is still denied the same project",
    stranger.status === 404 && !strangerText.includes(target.versionId),
    `status ${stranger.status}`,
  );

  console.log("");
  console.log("  To re-verify this exact version against a later deployment, set");
  console.log("  DEPLOY_VERIFY_VERSION to the object this run recorded. It carries an");
  console.log("  owner cookie, so keep it out of any file that git tracks.");
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

  console.log("verify:deployment");
  console.log(`  target            ${base}`);
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
  await freshServerPersistence(base);
  await clientBundleScan(base);

  const failed = checks.filter((check) => !check.ok).length;
  console.log("");
  console.log(
    failed === 0
      ? `verify:deployment OK — ${checks.length} checks passed`
      : `verify:deployment FAILED — ${failed} of ${checks.length} checks failed`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
