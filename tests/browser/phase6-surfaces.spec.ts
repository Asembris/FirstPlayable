import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { auditContrast } from "./support/contrast";
import { installPhase3Api, PROJECT_ID as P3 } from "./support/phase3-api";
import {
  installPhase5Api,
  PROJECT_ID as P5,
  READ_TOKEN,
} from "./support/phase5-api";

/**
 * Phase 6 Session 3: the rest of the judge-facing product on the Rehearsal
 * Table — the brief, the artist, revision, version comparison, sharing, and
 * the public player.
 *
 * The studio's own API is mocked by the Phase 3 and Phase 5 harnesses. What
 * these tests hold the UI to: every surface is paper (no Phase 5 dark panel
 * survives), text reaches AA, nothing scrolls sideways on a phone, actions
 * are named by their labels rather than their ids, and the revision colour
 * appears only on an observed change.
 */

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

/** The Phase 1–5 dark palette: panel, page ink, and card. */
const DARK = ["rgb(29, 31, 37)", "rgb(21, 22, 26)", "rgb(25, 27, 33)"];
const REV = ["rgb(176, 21, 76)", "rgb(249, 225, 232)", "rgb(140, 15, 59)"];

async function darkPainted(page: Page): Promise<string[]> {
  return page.evaluate((dark) => {
    const found: string[] = [];
    for (const element of [document.body, ...document.body.querySelectorAll("*")]) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (dark.includes(getComputedStyle(element).backgroundColor)) {
        found.push(`${element.tagName}.${element.className}`);
      }
    }
    return found;
  }, DARK);
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Elements inside `scope` painted in the revision colours, by class. */
async function revisionPainted(scope: Locator): Promise<string[]> {
  return scope.evaluate((root, colours) => {
    const found: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      if ([style.color, style.backgroundColor].some((v) => colours.includes(v))) {
        found.push(String(element.className));
      }
    }
    return found;
  }, REV);
}

async function openBrief(page: Page): Promise<void> {
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { established: true, expires_at: "2026-11-05T00:00:00Z" } }),
  );
  await page.goto("/studio");
  await expect(page.getByTestId("session-ready")).toBeVisible();
}

async function openProject(page: Page): Promise<void> {
  await installPhase5Api(page, { published: true });
  await page.goto(`/studio/${P5}`);
  await expect(page.getByTestId("version-compare")).toBeVisible();
}

test.describe("Phase 6 · the brief", () => {
  test("is a paper sheet: the encounter beside what stays fixed, tone as a choice", async ({
    page,
  }) => {
    await openBrief(page);
    await expect(page.locator(".rt.rt-desk")).toBeVisible();
    await expect(page.getByText("The encounter", { exact: true })).toBeVisible();
    await expect(page.getByText("Keep these fixed", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "tense" })).toBeChecked();
    await page.getByRole("radio", { name: "wry" }).check();
    await expect(page.getByRole("radio", { name: "wry" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Save this brief" })).toBeEnabled();
    // No phase label, no infrastructure copy.
    await expect(page.locator("body")).not.toContainText(/Phase \d|persistent shell|owner session/i);
  });

  test("its failure is a finished paper state that leads to the Moon difference", async ({
    page,
  }) => {
    await page.goto("/studio");
    const panel = page.getByTestId("error-panel");
    await expect(panel).toBeVisible();
    await expect(page.locator(".rt.rt-desk").getByTestId("error-panel")).toBeVisible();
    await expect(page.getByTestId("error-example-link")).toHaveAttribute("href", "/difference");
    expect(await darkPainted(page)).toEqual([]);
  });
});

test.describe("Phase 6 · the project desk", () => {
  test("holds the brief as strip, title, premise and cast, with a step line in plain words", async ({
    page,
  }) => {
    await openProject(page);
    const steps = page.getByRole("navigation", { name: "Where this scene stands" });
    await expect(steps).toContainText("Brief");
    await expect(steps).toContainText("Radiohead");
    await expect(steps).toContainText("1 approved");
    await expect(steps).toContainText("1 live link");
    // The record ids are kept, but behind a disclosure rather than in the head.
    await expect(page.getByTestId("project-id")).toBeHidden();
    await expect(page.getByTestId("project-title")).toBeVisible();
  });

  test("every sheet is on paper; no Phase 5 dark panel survives", async ({ page }) => {
    await openProject(page);
    await expect(page.locator("main.studio, section.panel, .studio__fieldset")).toHaveCount(0);
    for (const id of ["revision-panel", "version-compare", "publish-panel", "compile-panel"]) {
      await expect(page.getByTestId(id)).toHaveClass(/rt-studio/);
    }
    await expect(page.locator("#artist")).toHaveClass(/rt-studio/);
    expect(await darkPainted(page)).toEqual([]);
  });

  test("the artist results are catalogue slips; nothing is preselected", async ({ page }) => {
    await installPhase3Api(page);
    await page.goto(`/studio/${P3}`);
    await page.getByTestId("artist-query").fill("Radiohead");
    await page.getByTestId("artist-search-submit").click();
    const results = page.getByTestId("artist-results");
    await expect(results).toBeVisible();
    await expect(results.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(page.getByTestId("anchor-confirm")).toBeDisabled();
    await page.getByTestId("artist-option-1").check();
    await expect(page.locator(".rt-artist__choice[data-selected='true']")).toHaveCount(1);
    await expect(page.getByTestId("anchor-confirm")).toBeEnabled();
  });

  for (const viewport of WIDTHS) {
    test(`text reaches AA and nothing scrolls sideways at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openProject(page);
      await page.getByTestId("publish-preview").click();
      await expect(page.getByTestId("publish-preview-body")).toBeVisible();
      expect(await overflow(page), "horizontal overflow").toBeLessThanOrEqual(1);
      expect(await auditContrast(page)).toEqual([]);
    });
  }

  test("the brief reaches AA and fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBrief(page);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await auditContrast(page)).toEqual([]);
  });
});

test.describe("Phase 6 · revision and comparison", () => {
  test("a removal reads the engine's verdict by action label, never by id", async ({ page }) => {
    await openProject(page);
    await page.getByTestId("revise-remove-discovery").click();
    await expect(page.getByTestId("revision-label")).toContainText("Mechanical change");
    const summary = page.getByTestId("revision-summary");
    await expect(summary).toContainText("Fixed details preserved");
    await expect(summary).not.toContainText(/core\.|discovery\./);
    await expect(summary).toContainText("“");
  });

  test("compares as aligned rows: changed rows split, this version's cell on stock", async ({
    page,
  }) => {
    await openProject(page);
    const compare = page.getByTestId("version-compare");
    await expect(compare.getByRole("heading", { level: 2 })).toHaveText(
      "Same choices. Different next move.",
    );
    const changed = page.getByTestId("replay-changes").locator("> li.rt-vrow--changed, > li.rt-vrow--added, > li.rt-vrow--removed");
    expect(await changed.count()).toBeGreaterThan(0);

    // The prefix and every row are named by label; ids stay in the record.
    const visible = await compare.evaluate((root) => (root as HTMLElement).innerText);
    expect(visible).not.toMatch(/\bcore\.[a-z_]+|\bdiscovery\.[a-z_0-9]+/);

    // Revision colour only on an observed change: this version's changed
    // cells and the changed count.
    const painted = await revisionPainted(compare);
    expect(painted.length).toBeGreaterThan(0);
    for (const className of painted) {
      // A cell's own tag inherits the cell's ink.
      expect(className).toMatch(/rt-vrow__cell--current|rt-vrow__tag|rt-versions__changed/);
    }
    for (const cell of await compare.locator(".rt-vrow__cell--previous").all()) {
      expect(await revisionPainted(cell)).toEqual([]);
      expect(await cell.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(REV[1]);
    }
    for (const row of await page.locator(".rt-vrow--unchanged").all()) {
      expect(await revisionPainted(row)).toEqual([]);
    }
  });

  test("at phone width a changed row stacks PREVIOUS above THIS VERSION inside one row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page);
    const row = page.locator(".rt-vrow:not(.rt-vrow--unchanged)").first();
    const previous = await row.locator(".rt-vrow__cell--previous").boundingBox();
    const current = await row.locator(".rt-vrow__cell--current").boundingBox();
    expect(previous).not.toBeNull();
    expect(current!.y).toBeGreaterThan(previous!.y);
    await expect(row.locator(".rt-vrow__cell--current .rt-vrow__tag")).toBeVisible();
  });
});

test.describe("Phase 6 · sharing", () => {
  test("versions are named in words, and the link is a fact you can copy", async ({ page }) => {
    await openProject(page);
    const option = page.getByTestId("publish-version").locator("option").first();
    await expect(option).toHaveText(/^Current version · with Discovery · built .+ · 9e3e4f60$/);
    await page.getByTestId("publish-preview").click();
    await expect(page.getByTestId("preview-title")).toHaveText("The Second Copy");
    await page.getByTestId("publish-confirm").click();
    await expect(page.getByTestId("publish-link")).toContainText("Copy the link");
    await expect(page.getByTestId("publication-list")).not.toContainText(
      "9e3e4f60-7c8d-4ea0-9012-334455667788",
    );
  });
});

test.describe("Phase 6 · public player", () => {
  for (const viewport of WIDTHS) {
    test(`is play only, on paper, and fits ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installPhase5Api(page, { published: true });
      await page.goto(`/play/${READ_TOKEN}`);
      await expect(page.getByTestId("public-player")).toHaveClass(/rt-public/);
      await expect(page.getByText("Made with FirstPlayable · play only")).toBeVisible();
      // No tabs, no version control, no marks.
      await expect(page.locator("[data-testid^='rt-tab-'], .rt-seg, .rt-mark")).toHaveCount(0);
      await page.getByTestId("public-choice-core.inspect").click();
      expect(await overflow(page)).toBeLessThanOrEqual(1);
      expect(await darkPainted(page)).toEqual([]);
      expect(await auditContrast(page)).toEqual([]);
    });
  }

  test("the engine's observation names actions by label", async ({ page }) => {
    await installPhase5Api(page, { published: true });
    await page.goto(`/play/${READ_TOKEN}`);
    const sources = page.getByTestId("public-provenance");
    await expect(sources).toBeVisible();
    await expect(sources).not.toContainText(/core\.|discovery\./);
    await expect(sources).toContainText("Consequence · the engine observed");
  });

  test("an unavailable link is one clean paper screen", async ({ page }) => {
    await installPhase5Api(page, { published: true });
    await page.goto(`/play/${"Z".repeat(43)}`);
    await expect(page.getByTestId("public-unavailable")).toBeVisible();
    expect(await darkPainted(page)).toEqual([]);
    await expect(page.getByRole("link", { name: "Play the saved example" })).toHaveAttribute(
      "href",
      "/difference",
    );
  });
});
