import { expect, test } from "@playwright/test";
import { installPhase3Api, PROJECT_ID as P3, MOVIES } from "./support/phase3-api";
import { installPhase4Api, PROJECT_ID } from "./support/phase4-api";
import { installPhase5Api, READ_TOKEN } from "./support/phase5-api";

for (const width of [1280, 1100, 1024, 768, 640]) {
  test(`polish: Play and Compare remain clickable and aligned at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/difference?view=play");
    const stable = ["rt-topbar", "rt-title", "rt-band", "rt-head", "rt-row-core.ask_terms", "rt-row-core.withhold", "rt-row-core.leave"];
    const before = await Promise.all(stable.map(id => page.getByTestId(id).boundingBox()));
    await page.getByTestId("rt-tab-compare").click();
    await expect(page.getByTestId("rt-compare-count")).toContainText("3 choices changed");
    expect(await Promise.all(stable.map(id => page.getByTestId(id).boundingBox()))).toEqual(before);
    await page.getByTestId("rt-tab-play").click();
    await expect(page.getByTestId("rt-version-without")).toBeVisible();
    await page.getByTestId("rt-version-without").click();
    await expect(page.getByTestId("rt-choice-core.give")).not.toHaveAttribute("aria-disabled", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });
}

test("polish: an expanded causal record stays on paper below the scene", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/difference?view=compare");
  await page.getByTestId("rt-note").locator(".rt-note__more > summary").click();
  await page.getByTestId("rt-note").locator(".rt-note__more").scrollIntoViewIfNeeded();
  expect(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(244, 244, 240)");
});

test("polish: build progress reads naturally and its diagnostics remain available", async ({ page }) => {
  await installPhase4Api(page);
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible();
  const panel = page.getByTestId("compile-panel");
  await expect(panel.getByRole("list", { name: "Build progress" })).toContainText("Done");
  await expect(page.getByTestId("compile-model-calls")).toBeHidden();
  expect(await panel.innerText()).not.toMatch(/REVIEW_PLAYABLE|Model calls|committed/);
  await panel.getByText("Build details", { exact: true }).click();
  await expect(page.getByTestId("compile-model-calls")).toBeVisible();
  await expect(page.getByTestId("compile-state")).toContainText("REVIEW_PLAYABLE");
});

test("polish: an unavailable studio leads with recovery and keeps request details secondary", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByTestId("error-panel")).toBeVisible();
  await expect(page.getByTestId("error-code")).toBeHidden();
  await expect(page.getByTestId("error-example-link")).toBeVisible();
  await page.getByText("Request details", { exact: true }).click();
  await expect(page.getByTestId("error-code")).toHaveText("PERSISTENCE_UNAVAILABLE");
  await expect(page.getByTestId("error-request-id")).toBeVisible();
});

test("polish: public source notes are secondary and open from the keyboard without a request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installPhase5Api(page, { published: true });
  await page.goto(`/play/${READ_TOKEN}`);
  const sources = page.getByTestId("public-provenance");
  await expect(sources).toBeVisible();
  await expect(sources.locator(".rt-public__chains")).toBeHidden();
  const before = api.calls.length;
  await page.getByTestId("public-choice-core.inspect").click();
  const summary = sources.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(sources.locator(".rt-public__chains")).toBeVisible();
  await expect(sources).toContainText("Decision · the creator approved");
  expect(api.calls.length).toBe(before);
});

test("polish: approval chips and their source disclosure use ink focus rings", async ({ page }) => {
  await installPhase3Api(page, { anchorConfirmed: true, referencesReady: true, proposalsReady: true });
  await page.goto(`/studio/${P3}`);
  await page.getByTestId(`approve-${MOVIES[2]!.reference_id}`).click();
  const chip = page.getByTestId("approved-chip-discovery");
  await chip.focus();
  expect(await chip.evaluate(el => getComputedStyle(el).outlineColor)).toBe("rgb(20, 21, 24)");
  await page.keyboard.press("Enter");
  const summary = page.getByTestId("provenance-detail-discovery");
  await summary.focus();
  expect(await summary.evaluate(el => getComputedStyle(el).outlineColor)).toBe("rgb(20, 21, 24)");
  await page.keyboard.press("Enter");
  await expect(summary.locator("..")).toHaveAttribute("open", "");
});

test("polish: view and version controls offer 44px targets", async ({ page }) => {
  await page.goto("/difference?view=play");
  for (const id of ["rt-tab-play", "rt-tab-compare", "rt-version-with", "rt-version-without", "rt-restart"]) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test("polish: mobile provenance focus clears the pinned footer", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/difference?view=compare");
  const summary = page.getByTestId("rt-why-summary");
  await summary.focus();
  const note = (await summary.boundingBox())!;
  const footer = (await page.getByTestId("rt-foot").boundingBox())!;
  expect(note.y).toBeGreaterThanOrEqual(56);
  expect(note.y + note.height).toBeLessThanOrEqual(footer.y);
});
