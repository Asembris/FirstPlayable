import { expect, test } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

import { baseIsValid, installPhase4Api, PROJECT_ID, VERSION_ID } from "./support/phase4-api";

/**
 * Browser behaviour of the phase 4 compilation workflow.
 *
 * The studio's own API is mocked with route interception (see
 * `support/phase4-api.ts`), because the Playwright gate runs with persistence
 * deliberately unconfigured and must reach no external service. These tests
 * are about the interface: that a build can be started only once something is
 * approved, that the stage list tells the truth, that an interrupted build
 * resumes, that a failure is a finished state with the last good version
 * named, that the pending scene plays locally through the Phase 1 engine, that
 * activation is explicit, and that no phase 5 control exists.
 *
 * The real controller, the database-enforced attempt ceiling, the
 * compare-and-swap, the payload isolation, and the validator are covered by
 * the offline unit suite against the real handlers.
 */

/** Records any request that is not same-origin. The list must stay empty. */
function watchForeignRequests(page: Page, baseURL: string): string[] {
  const offending: string[] = [];
  const record = (request: Request): void => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!url.startsWith(baseURL)) offending.push(url);
  };
  page.on("request", record);
  return offending;
}

/** Hosts the browser must never reach, whatever the application does. */
const UPSTREAM_HOSTS = ["qloo.com", "api.openai.com", "supabase.co", "supabase.in"];

/**
 * Controls that exist only once a version has been confirmed.
 *
 * Phase 5 owns revision, comparison, publication, and export, and every one of
 * them acts on a version the creator confirmed — so before activation none of
 * them may be offered. This is deliberately a scan of *actionable* elements
 * rather than of all page text: the project header legitimately says
 * "revision 5", and a word ban on body text would make that a false positive.
 */
const POST_ACTIVATION_CONTROLS = [
  "revise",
  "remove this influence",
  "publish",
  "withdraw",
  "export",
  "download an offline",
  "rewrite this ending",
  "compare",
];

test("the hand-authored control fixture is valid, so a failure here is the UI's", () => {
  expect(baseIsValid()).toBe(true);
});

test("a build cannot start until an interaction is approved", async ({ page }) => {
  await installPhase4Api(page, {});
  await page.goto(`/studio/${PROJECT_ID}`);
  // This project has one approval, so the build button is offered.
  await expect(page.getByTestId("compile-start")).toBeEnabled();
  await expect(page.getByTestId("compile-needs-approval")).toHaveCount(0);
});

test("the stage list advances truthfully and ends in a pending review", async ({
  page,
  baseURL,
}) => {
  const foreign = watchForeignRequests(page, baseURL ?? "");
  const api = await installPhase4Api(page, {});
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId("compile-start").click();

  // Every stage reaches "committed", in the locked wording.
  await expect(page.getByTestId("stage-base")).toContainText("Writing encounter");
  await expect(page.getByTestId("stage-module_discovery")).toContainText("Building Discovery");
  await expect(page.getByTestId("stage-validate")).toContainText("Checking choices");
  await expect(page.getByTestId("compile-state")).toContainText("REVIEW_PLAYABLE", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("stage-validate")).toContainText("committed");

  // One advance request per stage, and not one more.
  const advances = api.calls.filter((call) => call.endsWith("/advance"));
  expect(advances).toHaveLength(3);

  await expect(page.getByTestId("pending-review")).toBeVisible();
  await expect(page.getByTestId("pending-version-id")).toHaveText(VERSION_ID);
  expect(foreign).toEqual([]);
});

test("the pending scene is playable before it is activated", async ({ page }) => {
  await installPhase4Api(page, {});
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible({ timeout: 15_000 });

  // "Where this appears" is deterministic engine output, not model prose.
  await expect(page.getByTestId("scene-changed-discovery")).toBeVisible();
  const witness = await page.getByTestId("witness-discovery").innerText();
  expect(witness.length).toBeGreaterThan(20);
  for (const overclaim of ["Qloo", "prove", "unique", "better"]) {
    expect(witness.toLowerCase()).not.toContain(overclaim.toLowerCase());
  }

  // The scene plays locally, through the same engine that validated it.
  await page.getByTestId("pending-choice-core.inspect").click();
  await expect(page.getByTestId("pending-transcript")).toContainText("still sealed");
  await page.getByTestId("pending-choice-core.ask_context").click();
  await expect(page.getByTestId("pending-transcript")).toContainText("on purpose");

  // The Discovery gate closes the return until the contradiction is discussed.
  await expect(page.getByTestId("pending-choice-core.give")).toBeDisabled();
  await page.getByTestId("pending-choice-discovery.ask_identity").click();
  await expect(page.getByTestId("pending-choice-core.give")).toBeEnabled();
});

test("activation is explicit, and the activated scene stays playable", async ({ page }) => {
  await installPhase4Api(page, {});
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible({ timeout: 15_000 });

  // Nothing is active until the creator says so.
  await expect(page.getByTestId("active-playable")).toHaveCount(0);
  await expect(page.getByTestId("activate-version")).toBeVisible();
  await expect(page.getByTestId("decline-version")).toBeVisible();

  await page.getByTestId("activate-version").click();
  await expect(page.getByTestId("active-playable")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("active-version-id")).toHaveText(VERSION_ID);
  await expect(page.getByTestId("pending-review")).toHaveCount(0);
  await expect(page.getByTestId("project-state")).toHaveText("READY");

  // The same generated scene plays and resets locally.
  await page.getByTestId("active-choice-core.inspect").click();
  await expect(page.getByTestId("active-transcript")).toContainText("still sealed");
  await page.getByTestId("active-reset").click();
  await expect(page.getByTestId("active-transcript")).toBeEmpty();
  await page.getByTestId("active-choice-core.inspect").click();
  await expect(page.getByTestId("active-transcript")).toContainText("still sealed");
});

test("declining a review preserves the previous state", async ({ page }) => {
  await installPhase4Api(page, {});
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("decline-version").click();
  await expect(page.getByTestId("pending-review")).toHaveCount(0);
  await expect(page.getByTestId("active-playable")).toHaveCount(0);
  // The build button is offered again; nothing was activated.
  await expect(page.getByTestId("compile-start")).toBeEnabled();
});

test("an interrupted build resumes from its committed stage after a reload", async ({
  page,
}) => {
  const api = await installPhase4Api(page, { interruptedAfter: "base" });
  await page.goto(`/studio/${PROJECT_ID}`);

  // The reload itself starts nothing.
  expect(api.calls.filter((call) => call.endsWith("/advance"))).toEqual([]);
  await expect(page.getByTestId("compile-interrupted")).toBeVisible();
  await expect(page.getByTestId("compile-start")).toContainText("Resume the build");

  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible({ timeout: 15_000 });
  // Only the two uncommitted stages ran: the base was not rebuilt.
  expect(api.calls.filter((call) => call.endsWith("/advance"))).toHaveLength(2);
});

test("a failed build is a finished state with a real recovery action", async ({ page }) => {
  await installPhase4Api(page, { failAt: "module_discovery" });
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();

  await expect(page.getByTestId("compile-failed")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("compile-failure-code")).toHaveText("VALIDATION_FAILED");
  await expect(page.getByTestId("compile-failed")).toContainText("interaction checks");
  // No spinner outlives the work, and no pending scene appears.
  await expect(page.getByTestId("pending-review")).toHaveCount(0);
  await expect(page.getByTestId("compile-last-good")).toBeVisible();
  // The saved example is one click away, from inside the failure panel itself.
  await expect(
    page.getByTestId("compile-failed").getByRole("link", { name: "Play saved example" }),
  ).toBeVisible();
});

test("a failed build leaves an already active version playable", async ({ page }) => {
  await installPhase4Api(page, { activated: true, failAt: "base" });
  await page.goto(`/studio/${PROJECT_ID}`);

  await expect(page.getByTestId("active-playable")).toBeVisible();
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("compile-failed")).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("compile-last-good")).toContainText(VERSION_ID);
  // The previous version is still there and still plays.
  await expect(page.getByTestId("active-playable")).toBeVisible();
  await page.getByTestId("active-choice-core.inspect").click();
  await expect(page.getByTestId("active-transcript")).toContainText("still sealed");
});

test("playing the generated scene makes no request at all", async ({ page, baseURL }) => {
  await installPhase4Api(page, { activated: true });
  await page.goto(`/studio/${PROJECT_ID}`);
  await expect(page.getByTestId("active-playable")).toBeVisible();

  /**
   * Start counting only once the scene has arrived.
   *
   * The claim being tested is the specification's: a complete playthrough, a
   * reset, and a replay cause zero Qloo calls, zero model calls, and no
   * gameplay server write. So this counts requests to this application's own
   * API and to any foreign host. Next.js's own route prefetches for the two
   * `<Link>` elements on the page — `/studio?_rsc=…`, `/difference?_rsc=…`, and
   * static chunks — are same-origin framework navigation, not gameplay, and
   * are deliberately not counted as either.
   */
  const apiCalls: string[] = [];
  const foreignCalls: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (url.includes("/api/")) apiCalls.push(url);
    if (!url.startsWith(baseURL ?? "")) foreignCalls.push(url);
  });

  await page.getByTestId("active-choice-core.inspect").click();
  await page.getByTestId("active-choice-core.ask_context").click();
  await page.getByTestId("active-choice-discovery.ask_identity").click();
  await page.getByTestId("active-choice-core.give").click();
  await expect(page.getByTestId("active-ending")).toBeVisible();
  await page.getByTestId("active-reset").click();
  await page.getByTestId("active-choice-core.inspect").click();

  // A complete playthrough, an ending, and a reset: zero API calls, and
  // nothing off-origin at all.
  expect(apiCalls).toEqual([]);
  expect(foreignCalls).toEqual([]);
});

test("the browser speaks only to this application, never to an upstream host", async ({
  page,
  baseURL,
}) => {
  const foreign = watchForeignRequests(page, baseURL ?? "");
  const seen: string[] = [];
  page.on("request", (request) => seen.push(request.url()));

  await installPhase4Api(page, {});
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("activate-version").click();
  await expect(page.getByTestId("active-playable")).toBeVisible({ timeout: 15_000 });

  expect(foreign).toEqual([]);
  for (const host of UPSTREAM_HOSTS) {
    expect(
      seen.filter((url) => url.includes(host)),
      `the browser reached ${host}`,
    ).toEqual([]);
  }
});

/**
 * Nothing acts on a version the creator has not confirmed.
 *
 * Before activation the studio offers the build and the review, and no
 * revision, comparison, publication, or export control at all — which is the
 * ordering the whole product depends on: a creator revises, compares, shares,
 * and exports the scene they said yes to.
 */
test("offers no revision, comparison, share, or export before a version is confirmed", async ({
  page,
}) => {
  await installPhase4Api(page);
  await page.goto(`/studio/${PROJECT_ID}`);
  await expect(page.getByTestId("compile-panel")).toBeVisible();

  const labels = await page
    .locator("button, a, [role=button], input, select, textarea")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").toLowerCase()),
    );
  for (const control of POST_ACTIVATION_CONTROLS) {
    expect(
      labels.filter((label) => label.includes(control)),
      `"${control}" is offered before a version was confirmed`,
    ).toEqual([]);
  }
  await expect(page.getByTestId("revision-panel")).toHaveCount(0);
  await expect(page.getByTestId("publish-panel")).toHaveCount(0);
  await expect(page.getByTestId("version-compare")).toHaveCount(0);

  // And no raw JSON or provider log view, in either phase.
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("schema_version");
  expect(text).not.toContain("prompt");
  expect(text).not.toContain("instructions");
});

test("a second owner is denied and learns nothing about the project", async ({ page }) => {
  await installPhase4Api(page, { foreign: true });
  await page.goto(`/studio/${PROJECT_ID}`);

  await expect(page.getByTestId("project-unavailable")).toBeVisible();
  await expect(page.getByTestId("compile-panel")).toHaveCount(0);
  await expect(page.getByTestId("pending-review")).toHaveCount(0);
  await expect(page.getByTestId("active-playable")).toHaveCount(0);
});
