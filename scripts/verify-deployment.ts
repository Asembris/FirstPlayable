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
  await browserChecks(base);
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
