import { expect, test } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

/**
 * Browser behaviour of the phase 2 studio shell with persistence unavailable.
 *
 * The Playwright web server runs `npm run start` with no Supabase
 * configuration, which is exactly the "database unavailable or paused" row of
 * specification section 12. That makes this suite the offline half of the phase
 * 2 acceptance evidence: it proves the honest finished error state and the
 * saved example's independence from the database, without the gate ever
 * requiring network access or a credential.
 *
 * The other half — a project that really persists, and a second browser that
 * really cannot read it — is verified against the deployed application and
 * recorded in docs/DEPLOYMENT_PREFLIGHT.md.
 */

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

test("the studio reports an honest finished error when persistence is unavailable", async ({
  page,
  baseURL,
}) => {
  const foreign = watchForeignRequests(page, baseURL ?? "");

  await page.goto("/studio");

  const panel = page.getByTestId("error-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("error-code")).toHaveText("PERSISTENCE_UNAVAILABLE");
  await expect(page.getByTestId("error-request-id")).toHaveText(/^[0-9a-f-]{36}$/);
  await expect(panel).toContainText("saved example");

  // No spinner is left running, and the brief form is never offered as if it
  // could be saved.
  await expect(page.getByText("Starting a session…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save this brief" })).toHaveCount(0);

  // Nothing about the failure leaks a credential, a hostname, or a stack trace.
  const body = (await page.locator("body").innerText()).toLowerCase();
  expect(body).not.toContain("supabase");
  expect(body).not.toContain("sb_secret_");
  expect(body).not.toContain("postgres");
  expect(body).not.toContain("at object.");

  expect(foreign).toEqual([]);
});

test("the owner cookie is never readable from page scripts", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByTestId("error-panel")).toBeVisible();
  const visible = await page.evaluate(() => document.cookie);
  expect(visible).not.toContain("fp_owner");
});

test("the error state leads to a saved example that plays without a database", async ({
  page,
  baseURL,
}) => {
  const foreign = watchForeignRequests(page, baseURL ?? "");

  await page.goto("/studio");
  // Phase 6: the saved example is the canonical Halcyon Relay difference, not the
  // Phase 1 design fixture.
  await expect(page.getByTestId("error-example-link")).toHaveAttribute("href", "/difference");
  await page.getByTestId("error-example-link").click();

  await expect(page).toHaveURL(/\/difference$/);
  await expect(page.getByRole("heading", { name: "The Second Copy" })).toBeVisible();

  // A complete run through the real engine, with the database still absent:
  // from the recorded point, both requirements unlock Return, which ends it.
  await page.getByTestId("rt-tab-play").click();
  await page.getByTestId("rt-choice-discovery.action_1").click();
  await page.getByTestId("rt-choice-discovery.action_2").click();
  await page.getByTestId("rt-choice-core.give").click();
  await expect(page.getByTestId("rt-restart")).toHaveText("Play it again");

  expect(foreign).toEqual([]);
});

test("a project address in a browser with no owner session says nothing about it", async ({
  page,
}) => {
  await page.goto("/studio/00000000-0000-4000-8000-000000000000");

  // With persistence down this is the recoverable error state; with persistence
  // up it is the "not available here" state. Neither reveals whether the id
  // exists, and neither leaves a spinner behind.
  await expect(
    page.getByTestId("project-unavailable").or(page.getByTestId("error-panel")),
  ).toBeVisible();
  await expect(page.getByText("Loading this project…")).toHaveCount(0);
  await expect(page.getByTestId("project-premise")).toHaveCount(0);
});

test("the landing page offers both paths and claims no generation", async ({ page }) => {
  await page.goto("/");
  // The audience landing: the saved Qloo comparison opens
  // instantly, and nothing on it is generated live.
  await expect(page.getByRole("link", { name: /Switch the audience/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Try your own/ })).toBeVisible();
  await expect(page.getByText("Opens instantly · no live calls")).toBeVisible();
});
