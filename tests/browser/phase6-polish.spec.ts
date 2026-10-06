import { expect, test } from "@playwright/test";

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
