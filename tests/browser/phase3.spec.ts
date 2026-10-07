import { expect, test } from "@playwright/test";
import type { Page, Request } from "@playwright/test";
import { GAMES, installPhase3Api, MOVIES, PROJECT_ID } from "./support/phase3-api";

/**
 * Browser behaviour of the phase 3 influence workflow.
 *
 * The studio's own API is mocked with route interception (see
 * `support/phase3-api.ts`), because the Playwright gate runs with persistence
 * deliberately unconfigured and must reach no external service. These tests
 * are about the interface: that confirmation is explicit, that cards show
 * supported context and nothing resembling a score, that zero influences are
 * approved by default, that approve / edit / dismiss / replace behave as the
 * specification describes, and that the provenance drawer shows three layers
 * and not four.
 *
 * The real route handlers — Zod contracts, ownership, cache, limiter, model
 * boundary — are covered by the offline unit suite.
 */

const HALCYON = MOVIES[2]!;
const ASHFALL = MOVIES[0]!;
const STARWARD = GAMES[0]!;

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

test("the persisted project opens with its brief and no cultural work yet", async ({
  page,
  baseURL,
}) => {
  const foreign = watchForeignRequests(page, baseURL ?? "");
  await installPhase3Api(page);

  await page.goto(`/studio/${PROJECT_ID}`);

  await expect(page.getByTestId("project-title")).toHaveText("The Second Copy");
  await expect(page.getByTestId("project-premise")).toContainText("sealed letter");
  await expect(page.getByTestId("project-state")).toHaveText("DRAFT");
  await expect(page.getByTestId("references-need-anchor")).toBeVisible();
  await expect(page.getByTestId("no-approvals")).toBeVisible();
  // Phase 4's compilation panel is present but asks for an approval first:
  // nothing can be built until the creator has approved an interaction.
  await expect(page.getByTestId("compile-needs-approval")).toBeVisible();

  expect(foreign).toEqual([]);
});

test("artist search lists every result and selects none of them", async ({ page }) => {
  await installPhase3Api(page);
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId("artist-query").fill("Lanternfold");
  await page.getByTestId("artist-search-submit").click();

  const results = page.getByTestId("artist-results");
  await expect(results).toBeVisible();
  await expect(results.getByRole("radio")).toHaveCount(3);

  // Nothing is preselected, so confirming is impossible until a choice is made.
  for (const index of [1, 2, 3]) {
    await expect(page.getByTestId(`artist-option-${index}`)).not.toBeChecked();
  }
  await expect(page.getByTestId("anchor-confirm")).toBeDisabled();

  // Enough context to tell the band from the tribute acts.
  await expect(results).toContainText("Lanternfold Tribute");
  await expect(results).toContainText("Also listed on lastfm, musicbrainz, spotify");

  // No ranking score is shown anywhere.
  const text = await results.innerText();
  expect(text).not.toMatch(/\b\d{1,3}\s?%/);
  expect(text.toLowerCase()).not.toContain("popularity");
  expect(text.toLowerCase()).not.toContain("affinity");
  expect(text.toLowerCase()).not.toContain("confidence");
});

test("an unknown artist fails honestly and retrieves nothing", async ({ page }) => {
  await installPhase3Api(page);
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId("artist-query").fill("zzqxvnotanartist");
  await page.getByTestId("artist-search-submit").click();

  await expect(page.getByTestId("artist-no-match")).toContainText("exact spelling");
  await expect(page.getByTestId("artist-results")).toHaveCount(0);
  // The brief is preserved, and the anchor is still unconfirmed.
  await expect(page.getByTestId("project-premise")).toContainText("sealed letter");
  await expect(page.getByTestId("references-need-anchor")).toBeVisible();
});

test("confirming an artist is an explicit second step", async ({ page }) => {
  await installPhase3Api(page);
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId("artist-query").fill("Lanternfold");
  await page.getByTestId("artist-search-submit").click();
  await expect(page.getByTestId("artist-results")).toBeVisible();

  // Searching alone changed nothing.
  await expect(page.getByTestId("anchor-confirmed")).toHaveCount(0);

  await page.getByTestId("artist-option-1").check();
  await page.getByTestId("anchor-confirm").click();

  await expect(page.getByTestId("anchor-confirmed")).toBeVisible();
  await expect(page.getByTestId("anchor-name")).toHaveText("Lanternfold");
  await expect(page.getByTestId("anchor-confirmed")).toContainText("as result 1");
  await expect(page.getByTestId("project-state")).toHaveText("ANCHOR_CONFIRMED");
  await expect(page.getByTestId("retrieve-references")).toBeVisible();
});

test("the reference loading state is truthful and then becomes two rows", async ({ page }) => {
  await installPhase3Api(page, { anchorConfirmed: true, referencesDelayMs: 400 });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId("retrieve-references").click();
  await expect(page.getByTestId("finding-references")).toContainText("one for movies");

  await expect(page.getByTestId("domain-row-movie")).toBeVisible();
  await expect(page.getByTestId("domain-row-videogame")).toBeVisible();
  // No invented percentage while it waits.
  await expect(page.getByTestId("finding-references")).toHaveCount(0);
});

test("each domain row shows at most three cards with supported context", async ({ page }) => {
  await installPhase3Api(page, { anchorConfirmed: true, referencesReady: true });
  await page.goto(`/studio/${PROJECT_ID}`);

  const movies = page.getByTestId("domain-row-movie");
  await expect(movies.locator(".card")).toHaveCount(3);
  await expect(page.getByTestId(`card-${HALCYON.reference_id}`)).toContainText("Halcyon Relay");
  await expect(page.getByTestId(`card-context-${HALCYON.reference_id}`)).toContainText(
    "Qloo describes",
  );
  await expect(page.getByTestId(`card-context-${HALCYON.reference_id}`)).toContainText(
    "duplicate of himself",
  );

  const games = page.getByTestId("domain-row-videogame");
  await expect(games.locator(".card")).toHaveCount(2);
  await expect(page.getByTestId(`card-${STARWARD.reference_id}`)).toContainText(
    "Starward Accord II",
  );

  // The ranking and its gaps are honest, behind a disclosure.
  await page.getByTestId("domain-skipped-movie").click();
  await expect(movies).toContainText("Result 4: Second Draft Weather");

  // Nothing resembling a quality score anywhere in the rows.
  const text = await page.locator("main").innerText();
  expect(text.toLowerCase()).not.toContain("affinity");
  expect(text.toLowerCase()).not.toContain("confidence");
  expect(text.toLowerCase()).not.toContain("best match");
  expect(text).not.toMatch(/\b\d{1,3}\s?%/);
  // And no overclaim about what Qloo did.
  expect(text).not.toMatch(/Qloo (recommends|proves|says|knows|generated)/i);
  expect(text).toContain("Qloo describes");
});

test("one empty domain leaves the other usable", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    emptyDomain: "movie",
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await expect(page.getByTestId("domain-empty-movie")).toContainText("no movie with usable context");
  await expect(page.getByTestId("domain-row-videogame").locator(".card")).toHaveCount(2);
  await expect(page.getByTestId("run-proposals")).toBeVisible();
  await expect(page.getByTestId("no-supported-influences")).toHaveCount(0);
});

test("both domains unusable says so and invents nothing", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    bothUnusable: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await expect(page.getByTestId("no-supported-influences")).toContainText(
    "No supported influences available for this artist.",
  );
  await expect(page.getByTestId("run-proposals")).toHaveCount(0);
  const text = await page.locator("main").innerText();
  expect(text).not.toContain("Ashfall Covenant");
  expect(text).not.toContain("Starward Accord");
  expect(text).toContain("Nothing was invented");
});

test("proposals render under their cards and approve nothing by default", async ({ page }) => {
  await installPhase3Api(page, { anchorConfirmed: true, referencesReady: true });
  await page.goto(`/studio/${PROJECT_ID}`);

  // Before the proposal stage: cards, but no interaction and no decision buttons.
  await expect(page.getByTestId(`card-no-proposal-${HALCYON.reference_id}`)).toBeVisible();
  await expect(page.getByTestId(`approve-${HALCYON.reference_id}`)).toHaveCount(0);

  await page.getByTestId("run-proposals").click();

  const card = page.getByTestId(`card-${HALCYON.reference_id}`);
  await expect(card).toContainText("Proposed interaction:");
  await expect(card).toContainText("FirstPlayable interpretation, not a Qloo assertion");
  // Approve, Edit and Dismiss sit immediately under the interaction.
  await expect(page.getByTestId(`approve-${HALCYON.reference_id}`)).toBeVisible();
  await expect(page.getByTestId(`edit-${HALCYON.reference_id}`)).toBeVisible();
  await expect(page.getByTestId(`dismiss-${HALCYON.reference_id}`)).toBeVisible();

  // The default approved count is zero.
  await expect(page.getByTestId("no-approvals")).toBeVisible();
  await expect(page.getByTestId("approved-chips")).toHaveCount(0);
});

test("approving one proposal creates one chip and one provenance chain", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();

  await expect(page.getByTestId("approved-chip-discovery")).toContainText("Discovery: Halcyon Relay");
  await expect(page.getByTestId("no-approvals")).toHaveCount(0);

  await page.getByTestId("approved-chip-discovery").click();
  const drawer = page.getByTestId("provenance-discovery");
  await expect(drawer).toBeVisible();

  // Exactly three layers, in order.
  await expect(drawer.locator(".drawer__label")).toHaveCount(3);
  const labels = await drawer.locator(".drawer__label").allInnerTexts();
  // The labels render uppercase through CSS, so compare the text itself.
  expect(labels.map((label) => label.split("\n")[0]?.trim().toLowerCase())).toEqual([
    "qloo retrieved",
    "firstplayable proposed",
    "creator approved",
  ]);
  // And no fourth one.
  await expect(drawer).not.toContainText("Scene changed");

  await expect(page.getByTestId("provenance-context-discovery")).toContainText("duplicate of himself");
  await expect(drawer).toContainText("Retrieved for Lanternfold on 2026-10-04");
  await expect(page.getByTestId("approved-text-discovery")).toContainText(
    "contradictory identity",
  );
  await expect(page.getByTestId("edited-by-you-discovery")).toHaveCount(0);

  // Rank and field paths are behind a second disclosure, not on the first
  // fold. Checked on visibility, because a collapsed <details> still has its
  // content in the DOM.
  const fieldPath = drawer.locator("code", { hasText: "properties.plot_summary" });
  await expect(drawer.locator("details")).not.toHaveAttribute("open", /.*/);
  await expect(fieldPath).toBeHidden();

  await page.getByTestId("provenance-detail-discovery").click();
  await expect(fieldPath).toBeVisible();
  await expect(drawer.getByText("Original response position: 3")).toBeVisible();
});

test("editing before approving records the creator's own wording", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId(`edit-${HALCYON.reference_id}`).click();
  const idea = page.getByTestId(`edit-idea-${HALCYON.reference_id}`);
  await expect(idea).toBeVisible();
  await idea.fill("Inspecting the letter shows two names. Ask Nia which one is hers.");
  await page
    .getByTestId(`edit-effect-${HALCYON.reference_id}`)
    .fill("Asking about the second name is what opens returning it.");
  await page.getByTestId(`approve-edit-${HALCYON.reference_id}`).click();

  await expect(page.getByTestId("approved-chip-discovery")).toContainText("edited");
  await page.getByTestId("approved-chip-discovery").click();
  await expect(page.getByTestId("edited-by-you-discovery")).toBeVisible();
  await expect(page.getByTestId("approved-text-discovery")).toHaveText(
    "Inspecting the letter shows two names. Ask Nia which one is hers.",
  );
  // The model's own wording is still shown, separately.
  await expect(page.getByTestId("provenance-discovery")).toContainText(
    "Borrow the idea of a contradictory identity",
  );
});

test("dismissing a proposal approves nothing and keeps an existing approval", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  // Dismiss with nothing approved: still nothing approved.
  await page.getByTestId(`dismiss-${ASHFALL.reference_id}`).click();
  await expect(page.getByTestId("no-approvals")).toBeVisible();

  // Approve one, then dismiss another card for the same slot.
  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();
  await expect(page.getByTestId("approved-chip-discovery")).toBeVisible();
  await page.getByTestId(`dismiss-${ASHFALL.reference_id}`).click();

  // The approval survives the dismissal.
  await expect(page.getByTestId("approved-chip-discovery")).toContainText("Discovery: Halcyon Relay");
});

test("filling an occupied slot requires an explicit replacement", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();
  await expect(page.getByTestId("approved-chip-discovery")).toContainText("Halcyon Relay");

  // The other Discovery card now offers a replacement, not a plain approval.
  const other = page.getByTestId(`card-${ASHFALL.reference_id}`);
  await expect(other).toContainText("this slot already holds an approval");
  await expect(page.getByTestId(`approve-${ASHFALL.reference_id}`)).toHaveText(
    "Replace this slot",
  );

  await page.getByTestId(`approve-${ASHFALL.reference_id}`).click();
  await expect(page.getByTestId("approved-chip-discovery")).toContainText(
    "Discovery: Ashfall Covenant",
  );

  // The replacement names its predecessor, so the change is visible.
  await page.getByTestId("approved-chip-discovery").click();
  await expect(page.getByTestId("replaced-discovery")).toContainText("still on record");
});

test("at most one approval per slot, across both slots", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();
  await page.getByTestId(`approve-${STARWARD.reference_id}`).click();

  await expect(page.getByTestId("approved-chip-discovery")).toBeVisible();
  await expect(page.getByTestId("approved-chip-commitment")).toBeVisible();
  await expect(page.getByTestId("approved-chips").locator("li")).toHaveCount(2);
});

test("an approval survives a reload", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();
  await expect(page.getByTestId("approved-chip-discovery")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("approved-chip-discovery")).toContainText("Discovery: Halcyon Relay");
  await page.getByTestId("approved-chip-discovery").click();
  await expect(page.getByTestId("approved-text-discovery")).toContainText(
    "contradictory identity",
  );
});

test("removing an approval restores the empty state and keeps the cards", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();
  await page.getByTestId("approved-chip-discovery").click();
  await page.getByTestId("remove-discovery").click();

  await expect(page.getByTestId("no-approvals")).toBeVisible();
  await expect(page.getByTestId("approved-chips")).toHaveCount(0);
  // The reference is still retrieved and still inspectable.
  await expect(page.getByTestId(`card-${HALCYON.reference_id}`)).toBeVisible();
});

test("a second browser cannot inspect the project", async ({ page }) => {
  await installPhase3Api(page, { foreign: true });
  await page.goto(`/studio/${PROJECT_ID}`);

  await expect(page.getByTestId("project-unavailable")).toBeVisible();
  await expect(page.getByTestId("project-premise")).toHaveCount(0);
  await expect(page.getByTestId("artist-query")).toHaveCount(0);
  await expect(page.getByTestId("approved-chips")).toHaveCount(0);
  // It learns nothing about whether the id exists.
  const text = await page.locator("main").innerText();
  expect(text).not.toContain("The Second Copy");
  expect(text).not.toContain("Lanternfold");
});

test("the browser speaks only to this application, never to an upstream host", async ({
  page,
  baseURL,
}) => {
  const foreign = watchForeignRequests(page, baseURL ?? "");
  const seen: string[] = [];
  page.on("request", (request) => seen.push(request.url()));

  const api = await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });

  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId(`approve-${HALCYON.reference_id}`).click();
  await page.getByTestId("approved-chip-discovery").click();
  await page.getByTestId("provenance-detail-discovery").click();

  expect(foreign).toEqual([]);
  for (const url of seen) {
    for (const host of UPSTREAM_HOSTS) {
      expect(url.includes(host), `${url} reached ${host}`).toBe(false);
    }
  }

  // Every API call the studio made was to this application's own routes.
  expect(api.calls.length).toBeGreaterThan(1);
  for (const call of api.calls) {
    expect(call).toMatch(/^(GET|POST|PUT) \/api\/(projects|session)/);
  }

  // No credential is reachable from page scripts.
  expect(await page.evaluate(() => document.cookie)).not.toContain("fp_owner");
  const html = await page.content();
  expect(html).not.toContain("x-api-key");
  expect(html).not.toContain("X-Api-Key");
  expect(html.toLowerCase()).not.toContain("sk-proj-");
});

test("the workflow is keyboard-operable and focus stays visible", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });
  await page.goto(`/studio/${PROJECT_ID}`);

  const approve = page.getByTestId(`approve-${HALCYON.reference_id}`);
  await approve.focus();
  await expect(approve).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approved-chip-discovery")).toBeVisible();

  const chip = page.getByTestId("approved-chip-discovery");
  await chip.focus();
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("provenance-discovery")).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
});

test("the workflow has no clipped critical action at 390px or 1440px", async ({ page }) => {
  await installPhase3Api(page, {
    anchorConfirmed: true,
    referencesReady: true,
    proposalsReady: true,
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/studio/${PROJECT_ID}`);

    for (const testId of [
      "artist-query",
      "artist-search-submit",
      `approve-${HALCYON.reference_id}`,
      `edit-${HALCYON.reference_id}`,
      `dismiss-${HALCYON.reference_id}`,
    ]) {
      const locator = page.getByTestId(testId);
      await expect(locator, `${testId} at ${viewport.width}px`).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, `${testId} at ${viewport.width}px`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    // No horizontal page scroll at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(1);
  }
});
