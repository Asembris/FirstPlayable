import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { SECOND_COPY_DISCOVERY_V1 } from "../../fixtures/second-copy";
import { auditContrast } from "./support/contrast";
import { installPhase3Api, MOVIES, PROJECT_ID as P3 } from "./support/phase3-api";
import { installPhase4Api, PROJECT_ID as P4, VERSION_ID } from "./support/phase4-api";

/**
 * Phase 6 Session 2: influence approval, edit before approval, "approved ·
 * not built yet", and the review of a candidate build, on the Rehearsal
 * Table.
 *
 * The studio's own API is mocked by the Phase 3 and Phase 4 harnesses; the
 * candidate scene, its validation, and its witness are the real engine's
 * output over the design fixture. What these tests hold the UI to is the
 * chain of distinctions: Qloo returned → FirstPlayable proposed → the creator
 * edited and approved → a build observed a consequence → the creator, and
 * only the creator, makes it current.
 */

const MOON = MOVIES[2]!;
const fixture = SECOND_COPY_DISCOVERY_V1;
const fixtureModule = fixture.modules[0]!;
const fixtureInfluence = fixture.influences[0]!;
const label = (id: string): string =>
  [...fixture.core.actions, ...fixtureModule.actions].find((action) => action.id === id)!.label;

const REV = ["rgb(176, 21, 76)", "rgb(249, 225, 232)", "rgb(140, 15, 59)"];

/** Elements inside `scope` painted in the revision colours. */
async function revisionPainted(scope: Locator): Promise<number> {
  return scope.evaluate((root, colours) => {
    let count = 0;
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const style = getComputedStyle(element);
      if ([style.color, style.backgroundColor, style.borderTopColor].some((v) => colours.includes(v))) {
        count += 1;
      }
    }
    return count;
  }, REV);
}

async function openApproval(page: Page): Promise<void> {
  await installPhase3Api(page, { anchorConfirmed: true, referencesReady: true, proposalsReady: true });
  await page.goto(`/studio/${P3}`);
  await expect(page.getByTestId(`card-${MOON.reference_id}`)).toBeVisible();
}

async function openReview(page: Page, options: { activated?: boolean } = {}): Promise<void> {
  await installPhase4Api(page, options);
  await page.goto(`/studio/${P4}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible({ timeout: 15_000 });
}

test.describe("Phase 6 · influence approval", () => {
  test("each reference is three materials: what Qloo returned, the proposal, your decision", async ({
    page,
  }) => {
    await openApproval(page);
    const card = page.getByTestId(`card-${MOON.reference_id}`);
    await expect(page.locator(".rt-ref-heads")).toHaveText(/Qloo returned\s*FirstPlayable proposes\s*You decide/);

    const slipFont = await card.locator(".rt-ref__slip").evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(slipFont).toBe("solid");
    const name = await card.locator(".rt-ref__name").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(name).toContain("Geist Mono");
    const idea = page.getByTestId(`card-idea-${MOON.reference_id}`);
    expect(await idea.evaluate((el) => getComputedStyle(el).fontStyle)).toBe("italic");

    await expect(page.getByTestId(`approve-${MOON.reference_id}`)).toHaveText("Approve this interpretation");
    await expect(page.getByTestId(`edit-${MOON.reference_id}`)).toHaveText("Edit before approving");
    await expect(page.getByTestId(`dismiss-${MOON.reference_id}`)).toHaveText("Not this one");
    // A proposal is not an observed change: no revision colour anywhere here.
    expect(await revisionPainted(page.locator(".rt-approval"))).toBe(0);
  });

  test("editing keeps the suggestion visible as the suggestion, then records your words", async ({
    page,
  }) => {
    await openApproval(page);
    const proposed = await page.getByTestId(`card-idea-${MOON.reference_id}`).innerText();
    await page.getByTestId(`edit-${MOON.reference_id}`).click();

    const editor = page.getByLabel("Your interpretation");
    await expect(editor).toBeFocused();
    const was = page.getByTestId(`card-proposed-${MOON.reference_id}`);
    await expect(was).toBeVisible();
    expect(proposed.startsWith((await was.innerText()).replace(/^Proposed: /, "").replace(/…$/, ""))).toBe(true);
    await expect(page.getByLabel("What should change in play")).toBeVisible();

    const mine = "Two names on the envelope. Returning it stays locked until you ask whose the other is.";
    await editor.fill(mine);
    await page.getByTestId(`approve-edit-${MOON.reference_id}`).click();

    const status = page.getByTestId(`card-status-${MOON.reference_id}`);
    await expect(status).toHaveText("✓ Approved");
    await expect(status).toBeFocused();
    await expect(page.getByTestId(`card-approved-${MOON.reference_id}`)).toHaveText(mine);
    await expect(page.getByTestId(`card-${MOON.reference_id}`)).toContainText("Edited by you");
    // The suggestion is still on record, in its own material.
    await expect(page.getByTestId(`card-${MOON.reference_id}`).locator(".rt-ref__was")).toBeVisible();
    const approvedStyle = await page
      .getByTestId(`card-approved-${MOON.reference_id}`)
      .evaluate((el) => getComputedStyle(el).fontStyle);
    expect(approvedStyle).toBe("normal");
  });

  test("an approval says it is not built yet, and the scene has not changed", async ({ page }) => {
    await openApproval(page);
    await expect(page.getByTestId("compile-start")).toBeDisabled();
    await expect(page.getByTestId("compile-needs-approval")).toContainText("Approving alone changes nothing");

    await page.getByTestId(`approve-${MOON.reference_id}`).click();
    await expect(page.getByTestId(`card-build-${MOON.reference_id}`)).toHaveText("Not built yet");
    await expect(page.getByTestId(`card-build-${MOON.reference_id}`)).toHaveClass(/rt-chip--dashed/);
    await expect(page.getByTestId(`card-${MOON.reference_id}`)).toContainText("The scene hasn't changed");
    await expect(page.getByTestId("approved-build-discovery")).toHaveText("Not built yet");
    await expect(page.getByTestId("build-chip")).toHaveText("Draft · nothing built");
    await expect(page.getByTestId("compile-start")).toHaveText("Build the scene with 1 approved interpretation");
    await expect(page.getByTestId("compile-start")).toBeEnabled();

    // Approval is not a build: nothing claims the scene changed.
    await page.getByTestId("approved-chip-discovery").click();
    await expect(page.getByTestId("provenance-discovery")).not.toContainText("Scene changed");
    expect(await revisionPainted(page.locator(".rt-approval"))).toBe(0);
    expect(await revisionPainted(page.locator(".rt-approved"))).toBe(0);
  });

  test("an approval can be undone from its own row", async ({ page }) => {
    await openApproval(page);
    await page.getByTestId(`approve-${MOON.reference_id}`).click();
    await page.getByTestId(`undo-approval-${MOON.reference_id}`).click();
    await expect(page.getByTestId("no-approvals")).toBeVisible();
    await expect(page.getByTestId(`approve-${MOON.reference_id}`)).toBeVisible();
  });
});

test.describe("Phase 6 · pending review", () => {
  test("sets what you intended against what the build was observed to do", async ({ page }) => {
    await openReview(page);
    const review = page.getByTestId("pending-review");
    await expect(page.getByTestId("build-chip")).toHaveText("New version · awaiting review");
    await expect(page.getByTestId("build-chip")).toHaveClass(/rt-chip--dashed/);
    await expect(review.getByRole("heading", { name: "Did it do what you approved?" })).toBeVisible();

    await expect(page.getByTestId("intended-discovery")).toHaveText(fixtureInfluence.intended_effect);
    await expect(page.getByTestId("review-intended")).toContainText("From your interpretation of Moon");

    const observed = page.getByTestId("scene-changed-discovery");
    await expect(observed).toContainText(`${label("core.give")} · locked`);
    await expect(observed).toContainText(`${label("discovery.ask_identity")} · added`);
    await expect(observed).toContainText(fixtureModule.gates[0]!.blocked_text);
    await expect(observed).toContainText(`${label("core.give")} has one requirement in this build.`);

    // Player words, never the engine's raw sentence or an identifier.
    const words = await page.getByTestId("witness-discovery").innerText();
    expect(words).toContain("is locked with Moon and open without it");
    const visible = await review.innerText();
    expect(visible).not.toMatch(/\b(core|discovery|approval)\.[a-z_]/);
    expect(visible).not.toContain(VERSION_ID);
    await expect(page.getByTestId("pending-version-id")).toBeHidden();

    // Only the observed side wears the revision colour.
    expect(await revisionPainted(page.getByTestId("review-intended"))).toBe(0);
    expect(await revisionPainted(observed)).toBeGreaterThan(0);
  });

  test("building never makes a version current; the three decisions are distinct", async ({ page }) => {
    await openReview(page);
    await expect(page.getByTestId("active-playable")).toHaveCount(0);
    await expect(page.getByTestId("play-candidate")).toHaveText("▸ Play this version");
    await expect(page.getByTestId("activate-version")).toHaveText("Make it current");
    await expect(page.getByTestId("decline-version")).toHaveText("Discard this build");
    await expect(page.getByTestId("pending-review")).toContainText(
      "Building never makes a version current by itself.",
    );
  });

  test("Play this version moves to the candidate, which plays without changing anything", async ({
    page,
  }) => {
    await openReview(page);
    await page.getByTestId("play-candidate").click();
    await expect(page.getByTestId("candidate-pending")).toBeFocused();
    await page.getByTestId("pending-choice-core.inspect").click();
    await expect(page.getByTestId("pending-transcript")).toContainText("still sealed");
    await expect(page.getByTestId("build-chip")).toHaveText("New version · awaiting review");
  });

  test("Make it current stamps the chip solid and says so", async ({ page }) => {
    await openReview(page);
    await page.getByTestId("activate-version").click();
    const outcome = page.getByTestId("review-outcome");
    await expect(outcome).toHaveText("✓ Made current. This is now the version people play.");
    await expect(outcome).toBeFocused();
    await expect(page.getByTestId("build-chip")).toHaveText("Current");
    await expect(page.getByTestId("build-chip")).not.toHaveClass(/rt-chip--dashed/);
    await expect(page.getByTestId("active-playable")).toContainText("✓ Current. This is the version people play.");
  });

  test("a first build can be discarded, leaving the approval untouched", async ({ page }) => {
    await openReview(page);
    await page.getByTestId("decline-version").click();
    await expect(page.getByTestId("review-outcome")).toHaveText(
      "Discarded this build. Your brief and your approvals are unchanged.",
    );
    await expect(page.getByTestId("pending-review")).toHaveCount(0);
    await expect(page.getByTestId("active-playable")).toHaveCount(0);
  });

  test("with a current version, the choice is to keep it", async ({ page }) => {
    await openReview(page, { activated: true });
    await expect(page.getByTestId("decline-version")).toHaveText("Keep the current version");
    await page.getByTestId("decline-version").click();
    await expect(page.getByTestId("review-outcome")).toContainText("Kept the current version");
    await expect(page.getByTestId("active-playable")).toBeVisible();
    await expect(page.getByTestId("build-chip")).toHaveText("Current");
  });

  test("reduced motion: the stamp lands without animating", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openReview(page);
    await page.getByTestId("activate-version").click();
    const animation = await page.getByTestId("build-chip").evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe("none");
  });
});

test.describe("Phase 6 · creator sheets · contrast and mobile", () => {
  for (const width of [1440, 390]) {
    test(`approval and review text reach AA at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await openApproval(page);
      await page.getByTestId(`edit-${MOON.reference_id}`).click();
      expect(await auditContrast(page)).toEqual([]);
      await page.getByTestId(`approve-edit-${MOON.reference_id}`).click();
      await page.getByTestId("approved-chip-discovery").click();
      await expect(page.getByTestId("provenance-discovery")).toBeVisible();
      expect(await auditContrast(page)).toEqual([]);

      await openReview(page);
      expect(await auditContrast(page)).toEqual([]);
      await page.getByTestId("activate-version").click();
      await expect(page.getByTestId("active-playable")).toBeVisible();
      expect(await auditContrast(page)).toEqual([]);
    });
  }

  test.describe("at 390px", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("approval stacks into one column with full-width 44px actions", async ({ page }) => {
      await openApproval(page);
      const slip = await page.getByTestId(`card-${MOON.reference_id}`).locator(".rt-ref__slip").boundingBox();
      const idea = await page.getByTestId(`card-idea-${MOON.reference_id}`).boundingBox();
      expect(idea!.y).toBeGreaterThan(slip!.y + slip!.height);
      for (const id of [`approve-${MOON.reference_id}`, `edit-${MOON.reference_id}`, `dismiss-${MOON.reference_id}`]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.height, id).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width, id).toBeLessThanOrEqual(390);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("review stacks intended above observed, and every decision stays reachable", async ({ page }) => {
      await openReview(page);
      const intended = (await page.getByTestId("review-intended").boundingBox())!;
      const observed = (await page.getByTestId("where-this-appears").boundingBox())!;
      expect(observed.y).toBeGreaterThanOrEqual(intended.y + intended.height - 1);
      for (const id of ["play-candidate", "activate-version", "decline-version"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.height, id).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width, id).toBeLessThanOrEqual(390);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
