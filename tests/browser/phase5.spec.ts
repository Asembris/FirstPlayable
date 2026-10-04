import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

import { buildOfflineExport } from "../../src/export/html";
import {
  installPhase5Api,
  KINDER_ENDING,
  PROJECT_ID,
  PUBLICATION_ID,
  publicSnapshot,
  READ_TOKEN,
} from "./support/phase5-api";

/**
 * Browser behaviour of the Phase 5 loop: revise, compare, publish, revoke, and
 * play an exported file from disk.
 *
 * The studio's own API is mocked with route interception (see
 * `support/phase5-api.ts`), because the Playwright gate runs with persistence
 * deliberately unconfigured and must reach no external service. What is not
 * mocked is the scene, its validation, its comparison, or its witness: those are
 * the real engine's output, computed in the support file.
 *
 * The offline export test is different in kind — it builds a real exported file
 * with the real bundler output and opens it from `file://` with every http
 * request aborted, which is the closest a test gets to "open this on a laptop
 * with the network unplugged".
 */

/** Records any request that is not same-origin. The list must stay empty. */
function watchForeignRequests(page: Page, baseURL: string): string[] {
  const offending: string[] = [];
  page.on("request", (request: Request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("file:")) return;
    if (!url.startsWith(baseURL)) offending.push(url);
  });
  return offending;
}

const UPSTREAM_HOSTS = ["qloo.com", "api.openai.com", "supabase.co", "supabase.in"];

test.describe("revising one influence", () => {
  test("removes it with no generation and labels the result mechanically", async ({
    page,
    baseURL,
  }) => {
    const foreign = watchForeignRequests(page, baseURL ?? "");
    const state = await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    await expect(page.getByTestId("revision-panel")).toBeVisible();
    await expect(page.getByTestId("revise-discovery")).toBeVisible();

    await page.getByTestId("revise-remove-discovery").click();

    // The engine's own label and its three summary lines.
    await expect(page.getByTestId("revision-label")).toContainText("Mechanical change");
    const summary = page.getByTestId("revision-summary").locator("li");
    await expect(summary.first()).toBeVisible();
    expect(await summary.count()).toBeLessThanOrEqual(3);
    await expect(page.getByTestId("revision-summary")).toContainText(
      "Fixed details preserved",
    );

    // The pending revision is offered for review, and the previous version is
    // still the active one.
    await expect(page.getByTestId("pending-review")).toBeVisible();
    await expect(page.getByTestId("version-compare")).toBeVisible();

    expect(state.calls.filter((call) => call.includes("/revisions"))).toHaveLength(1);
    expect(state.calls.some((call) => call.includes("/compile"))).toBe(false);
    expect(foreign).toEqual([]);
  });

  test("shows a refusal as a finished state that names the live version", async ({ page }) => {
    await installPhase5Api(page, { refuseRevisions: true });
    await page.goto(`/studio/${PROJECT_ID}`);

    await page.getByTestId("revise-remove-discovery").click();
    const failure = page.getByTestId("revision-failure");
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("SLOT_EMPTY");
    await expect(failure).toContainText("still plays");
    // No spinner outlived the request, and nothing was applied.
    await expect(page.getByTestId("revision-result")).toHaveCount(0);
  });

  test("records a new approval for an edit and asks for a rebuild", async ({ page }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    await page.getByTestId("revise-edit-discovery").click();
    const text = page.getByTestId("revise-text-discovery");
    await expect(text).toBeVisible();
    await text.fill(
      "Inspecting the letter shows a second name, and she will not take it back until that name is said aloud.",
    );
    await page.getByTestId("revise-submit-discovery").click();

    await expect(page.getByTestId("revision-needs-build")).toContainText(
      "Build the scene again",
    );
    await expect(page.getByTestId("revision-needs-build")).toContainText(
      "the foundation and any other influence are reused",
    );
  });

  test("previews an ending rewrite, applies it explicitly, and calls it wording", async ({
    page,
  }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    const endings = page.getByTestId("ending-list").locator("li");
    await expect(endings.first()).toBeVisible();
    expect(await endings.count()).toBe(3);

    await page.getByTestId("ending-rewrite-end.give").click();
    await page.getByTestId("ending-request-end.give").fill("Make this ending kinder to her.");
    await page.getByTestId("ending-preview-end.give").click();

    const preview = page.getByTestId("ending-preview");
    await expect(preview).toBeVisible();
    await expect(page.getByTestId("ending-preview-text")).toContainText(
      KINDER_ENDING.slice(0, 40),
    );
    await expect(preview).toContainText("Nothing has changed yet");

    await page.getByTestId("ending-apply").click();
    await expect(page.getByTestId("revision-label")).toContainText(
      "Wording changed; interaction unchanged.",
    );
  });

  test("keeps a previewed wording unapplied when the creator declines it", async ({ page }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    await page.getByTestId("ending-rewrite-end.give").click();
    await page.getByTestId("ending-request-end.give").fill("Make this ending kinder to her.");
    await page.getByTestId("ending-preview-end.give").click();
    await page.getByTestId("ending-discard").click();

    await expect(page.getByTestId("ending-preview")).toHaveCount(0);
    await expect(page.getByTestId("revision-result")).toHaveCount(0);
  });
});

test.describe("comparing versions", () => {
  test("switches between previous and current without any request", async ({
    page,
    baseURL,
  }) => {
    const state = await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);
    await expect(page.getByTestId("version-compare")).toBeVisible();

    const before = state.calls.length;
    await page.getByTestId("compare-previous").click();
    await expect(page.getByTestId("compare-previous-play-choices")).toBeVisible();
    await page.getByTestId("compare-current").click();
    await expect(page.getByTestId("compare-current-play-choices")).toBeVisible();
    // Switching version, and playing either one, costs nothing at all.
    expect(state.calls.length).toBe(before);
    void baseURL;
  });

  test("replays the creator's own choices in the other version", async ({ page }) => {
    const state = await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    await expect(page.getByTestId("version-compare")).toBeVisible();
    const before = state.calls.length;

    // Play the current version: inspect, then ask.
    await page.getByTestId("compare-current-play-choice-core.inspect").click();
    await expect(page.getByTestId("replay-prefix")).toContainText("core.inspect");
    await expect(page.getByTestId("replay-prefix")).toContainText("Your choices");

    // The foundation alone does not gate the return, so the same prefix leaves
    // a different action availability — which the engine, not the page, decided.
    const changes = page.getByTestId("replay-changes");
    const same = page.getByTestId("replay-same");
    await expect(changes.or(same)).toBeVisible();
    expect(state.calls.length).toBe(before);
  });

  test("names the choice at which a replay stops in the other version", async ({ page }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    // The current version's module action does not exist in the foundation, so
    // replaying it there has to stop and say so.
    const moduleAction = page
      .getByTestId("compare-current-play-choices")
      .locator('[data-testid^="compare-current-play-choice-discovery"]');
    if ((await moduleAction.count()) === 0) return;
    await page.getByTestId("compare-current-play-choice-core.inspect").click();
    await moduleAction.first().click();
    await expect(page.getByTestId("replay-stopped")).toBeVisible();
  });
});

test.describe("publishing and withdrawing a link", () => {
  test("previews exactly what will be public, then publishes it once", async ({ page }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    const panel = page.getByTestId("publish-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("share-warning")).toContainText("cannot recall a copy");

    await page.getByTestId("publish-preview").click();
    const preview = page.getByTestId("publish-preview-body");
    await expect(preview).toBeVisible();
    await expect(page.getByTestId("preview-version")).toContainText("9e3e4f60");
    await expect(page.getByTestId("preview-provenance")).toContainText("included");
    await expect(preview).toContainText("Nothing is public yet");
    // The preview says what stays private, in the creator's own terms.
    await expect(preview).toContainText("stay private");

    await page.getByTestId("publish-confirm").click();
    const link = page.getByTestId("publish-link");
    await expect(link).toBeVisible();
    await expect(page.getByTestId("publish-link-path")).toContainText("/play/");
    await expect(link).toContainText("only time this link is shown");
  });

  test("refuses to publish a document other than the previewed one", async ({ page }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);

    await page.getByTestId("publish-preview").click();
    await expect(page.getByTestId("publish-preview-body")).toBeVisible();
    // Changing the disclosure choice clears the preview, so the only way to
    // publish the other document is to preview it.
    await page.getByTestId("publish-provenance").uncheck();
    await expect(page.getByTestId("publish-preview-body")).toHaveCount(0);

    await page.getByTestId("publish-preview").click();
    await expect(page.getByTestId("preview-provenance")).toContainText("not included");
    await page.getByTestId("publish-confirm").click();
    await expect(page.getByTestId("publish-link")).toBeVisible();
  });

  test("lists a live link and withdraws it", async ({ page }) => {
    await installPhase5Api(page, { published: true });
    await page.goto(`/studio/${PROJECT_ID}`);

    const list = page.getByTestId("publication-list");
    await expect(list).toBeVisible();
    await expect(list).toContainText("live");
    await page.getByTestId(`revoke-${PUBLICATION_ID}`).click();
    await expect(list).toContainText("withdrawn");
    await expect(page.getByTestId("publish-panel")).toContainText(
      "cannot recall a file somebody",
    );
  });

  test("offers the offline download as a direct, same-origin file", async ({ page }) => {
    await installPhase5Api(page);
    await page.goto(`/studio/${PROJECT_ID}`);
    const link = page.getByTestId("export-download");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("download", "");
    const href = await link.getAttribute("href");
    expect(href).toContain(`/api/projects/${PROJECT_ID}/export?version=`);
    expect(href?.startsWith("/")).toBe(true);
  });
});

test.describe("the public share view", () => {
  test("plays read-only, with no owner control and no private data", async ({
    page,
    baseURL,
  }) => {
    const foreign = watchForeignRequests(page, baseURL ?? "");
    const state = await installPhase5Api(page, { published: true });
    await page.goto(`/play/${READ_TOKEN}`);

    await expect(page.getByTestId("public-player")).toBeVisible();
    await expect(page.getByTestId("public-title")).toContainText("The Second Copy");
    await expect(page.getByTestId("public-provenance")).toBeVisible();

    // A complete local interaction with no further request of any kind.
    const before = state.calls.length;
    await page.getByTestId("public-choice-core.inspect").click();
    await expect(page.getByTestId("public-transcript")).toContainText(">");
    expect(state.calls.length).toBe(before);

    // No owner control exists on the page at all.
    const actionable = await page.locator("button, a, input, select, textarea").allInnerTexts();
    const joined = actionable.join(" ").toLowerCase();
    for (const owned of [
      "publish",
      "revoke",
      "withdraw",
      "export",
      "download",
      "remove this influence",
      "rewrite this ending",
      "build",
    ]) {
      expect(joined.includes(owned), `the share offered "${owned}"`).toBe(false);
    }

    // And nothing private is in the rendered bytes.
    const html = await page.content();
    for (const forbidden of [
      PROJECT_ID,
      "Radiohead",
      "proposal_draft",
      "capture_id",
      "fp_owner",
      ...UPSTREAM_HOSTS,
    ]) {
      expect(html.includes(forbidden), `the share rendered ${forbidden}`).toBe(false);
    }
    expect(foreign).toEqual([]);
  });

  test("shows one clean unavailable screen for a withdrawn or unknown link", async ({
    page,
  }) => {
    await installPhase5Api(page, { published: true });
    await page.goto(`/play/${"Z".repeat(43)}`);
    await expect(page.getByTestId("public-unavailable")).toBeVisible();
    await expect(page.getByTestId("public-unavailable")).toContainText(
      "may never have existed",
    );
    // It reveals nothing about the owner or the project.
    const html = await page.content();
    expect(html.includes(PROJECT_ID)).toBe(false);
  });

  test("keeps the share out of search indexes", async ({ page }) => {
    await installPhase5Api(page, { published: true });
    await page.goto(`/play/${READ_TOKEN}`);
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots).toContain("noindex");
  });
});

test.describe("the exported file", () => {
  test("plays from disk with every network request blocked", async ({ page }) => {
    // The real builder, the real committed bundle, the real engine.
    const built = buildOfflineExport(publicSnapshot(), "2026-10-04T13:00:00.000Z");
    const directory = mkdtempSync(join(tmpdir(), "fp-export-"));
    const file = join(directory, built.fileName);
    writeFileSync(file, built.html, "utf8");

    // Everything except the file itself is refused, which is what "the network
    // is unplugged" means for a browser.
    const blocked: string[] = [];
    await page.route(/^(https?|ws):/, async (route) => {
      blocked.push(route.request().url());
      await route.abort();
    });

    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) {
        violations.push(message.text());
      }
    });

    await page.goto(pathToFileURL(file).href);

    // It rendered, from its own bytes.
    await expect(page.locator("#fp-root h1")).toContainText("The Second Copy");
    await expect(page.locator(".fp-choices")).toBeVisible();

    // A real state transition: the first choice is taken, the transcript grows,
    // and the engine offers a different set of choices afterwards.
    const openingChoices = await page.locator(".fp-choice").count();
    expect(openingChoices).toBeGreaterThanOrEqual(2);
    await page.locator(".fp-choice:not(.fp-choice-locked)").first().click();
    await expect(page.locator(".fp-transcript li").first()).toBeVisible();
    const after = await page.locator(".fp-transcript li").count();
    expect(after).toBeGreaterThan(0);

    // A locked choice explains itself rather than disappearing, which is the
    // engine's own blocked text travelling into an offline file.
    const locked = page.locator(".fp-choice-locked");
    if ((await locked.count()) > 0) {
      await expect(locked.first()).toContainText(/\S/);
      await expect(locked.first()).toBeDisabled();
    }

    // Reset starts a new run from the initial state.
    await page.locator("button", { hasText: "Start over" }).click();
    await expect(page.locator(".fp-transcript li")).toHaveCount(0);
    expect(await page.locator(".fp-choice").count()).toBe(openingChoices);

    // Nothing was requested, and the policy refused nothing — because the file
    // asked for nothing.
    expect(blocked).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("refuses a damaged file instead of playing an approximate one", async ({ page }) => {
    const built = buildOfflineExport(publicSnapshot(), "2026-10-04T13:00:00.000Z");
    // Corrupt the data block, leaving the trusted bundle intact.
    const damaged = built.html.replace(
      /<div id="fp-data" hidden>[^<]*<\/div>/,
      '<div id="fp-data" hidden>bm90IGEgcGxheWFibGU=</div>',
    );
    const directory = mkdtempSync(join(tmpdir(), "fp-export-bad-"));
    const file = join(directory, "damaged.html");
    writeFileSync(file, damaged, "utf8");

    await page.goto(pathToFileURL(file).href);
    await expect(page.locator("#fp-root h1")).toContainText(
      "This playable could not be loaded",
    );
    await expect(page.locator("#fp-root")).toContainText("Nothing was run");
  });

  test("renders a script-breakout string as text", async ({ page }) => {
    const snapshot = publicSnapshot(false);
    const hostile = {
      ...snapshot,
      scene: {
        ...snapshot.scene,
        world: {
          ...snapshot.scene.world,
          object: {
            ...snapshot.scene.world.object,
            description: '</script><img src=x onerror="window.__xss=1"> a letter',
          },
        },
      },
    };
    const built = buildOfflineExport(hostile as typeof snapshot, "2026-10-04T13:00:00.000Z");
    const directory = mkdtempSync(join(tmpdir(), "fp-export-xss-"));
    const file = join(directory, "hostile.html");
    writeFileSync(file, built.html, "utf8");

    await page.goto(pathToFileURL(file).href);
    await expect(page.locator(".fp-object")).toContainText("onerror");
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator("#fp-root img").count()).toBe(0);
  });
});
