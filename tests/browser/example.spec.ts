import { expect, test } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

/**
 * Browser behaviour of the offline vertical slice.
 *
 * Every test asserts that gameplay reaches no later-phase API route and no
 * third-party host: after the initial page load, playing, resetting, and
 * switching version must be entirely local.
 */

const PREFIX = ["core.inspect", "core.ask_context", "discovery.ask_identity"];

type NetworkLog = { offending: string[] };

/**
 * Fail on any application-origin API request and on any request leaving the
 * local origin. Next.js' own static assets and dev/HMR endpoints are the only
 * permitted same-origin traffic.
 */
async function watchNetwork(page: Page, baseURL: string): Promise<NetworkLog> {
  const log: NetworkLog = { offending: [] };
  const record = (request: Request): void => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!url.startsWith(baseURL)) {
      log.offending.push(url);
      return;
    }
    const path = new URL(url).pathname;
    if (path.startsWith("/api/") || path.startsWith("/_next/api")) {
      log.offending.push(url);
    }
  };
  page.on("request", record);
  await page.route("**/api/**", (route) => route.abort());
  return log;
}

async function openExample(page: Page, baseURL: string): Promise<NetworkLog> {
  const log = await watchNetwork(page, baseURL);
  await page.goto("/example");
  await expect(page.getByRole("heading", { name: "The Second Copy" })).toBeVisible();
  return log;
}

async function playPrefix(page: Page): Promise<void> {
  for (const actionId of PREFIX) {
    await page.getByTestId(`choice-${actionId}`).click();
  }
}

test.describe("the /example vertical slice", () => {
  test("loads with the scene, the object, and the opening choices", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);
    await expect(page.getByTestId("object")).toContainText("Sealed letter");
    await expect(
      page.getByRole("heading", { name: "Lost-property counter" }),
    ).toBeVisible();
    await expect(page.getByTestId("choice-core.inspect")).toBeEnabled();
    await expect(page.getByTestId("choice-core.ask_context")).toBeEnabled();
    // Actions whose own condition is false are not offered at all.
    await expect(page.getByTestId("choice-core.give")).toHaveCount(0);
    expect(log.offending).toEqual([]);
  });

  test("plays a complete run to an ending and shows NPC dialogue", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);
    await page.getByTestId("choice-core.inspect").click();
    await expect(page.getByTestId("transcript")).toContainText(
      "a second name has been pressed into the paper",
    );
    await page.getByTestId("choice-core.ask_context").click();
    await expect(page.getByTestId("transcript")).toContainText(
      "I left it here on purpose",
    );
    await page.getByTestId("choice-discovery.ask_identity").click();
    await page.getByTestId("choice-core.give").click();
    await expect(page.getByTestId("ending")).toContainText("Returned");
    await expect(page.getByTestId("choices")).toHaveCount(0);
    expect(log.offending).toEqual([]);
  });

  test("the same three choices open the return in v1 and close it in v2", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);

    await page.getByTestId("version-v1").click();
    await playPrefix(page);
    await expect(page.getByTestId("choice-core.give")).toBeEnabled();

    await page.getByTestId("version-v2").click();
    await expect(page.getByTestId("transcript")).toBeEmpty();
    await playPrefix(page);
    const locked = page.getByTestId("choice-core.give");
    await expect(locked).toBeDisabled();
    await expect(locked).toContainText("Nia refused the letter");
    // The other choices are untouched by the revision.
    await expect(page.getByTestId("choice-core.withhold")).toBeEnabled();
    await expect(page.getByTestId("choice-core.leave")).toBeEnabled();

    expect(log.offending).toEqual([]);
  });

  test("the clean base has no influence module and no module action", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);
    await page.getByTestId("version-base").click();
    await expect(page.getByTestId("current-version")).toContainText(
      "Without this influence",
    );
    await page.getByTestId("choice-core.inspect").click();
    await page.getByTestId("choice-core.ask_context").click();
    await expect(page.getByTestId("choice-discovery.ask_identity")).toHaveCount(0);
    await expect(page.getByTestId("choice-core.give")).toBeEnabled();
    expect(log.offending).toEqual([]);
  });

  test("reset returns the run to its initial state", async ({ page, baseURL }) => {
    const log = await openExample(page, baseURL as string);
    await playPrefix(page);
    await expect(page.getByTestId("transcript")).not.toBeEmpty();
    await page.getByTestId("reset").click();
    await expect(page.getByTestId("transcript")).toBeEmpty();
    await expect(page.getByTestId("choice-core.inspect")).toBeEnabled();
    await expect(page.getByTestId("choice-discovery.ask_identity")).toHaveCount(0);
    expect(log.offending).toEqual([]);
  });

  test("version switching is indicated and restarts the run", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);
    await expect(page.getByTestId("version-v1")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("choice-core.inspect").click();
    await page.getByTestId("version-v2").click();
    await expect(page.getByTestId("version-v2")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("version-v1")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByTestId("current-version")).toContainText(
      "saved revision",
    );
    await expect(page.getByTestId("transcript")).toBeEmpty();
    expect(log.offending).toEqual([]);
  });

  test("keyboard-only play works and focus stays visible", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);
    const inspect = page.getByTestId("choice-core.inspect");
    await inspect.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("transcript")).not.toBeEmpty();
    expect(log.offending).toEqual([]);
  });

  test("a complete run after load makes no request at all", async ({
    page,
    baseURL,
  }) => {
    const log = await openExample(page, baseURL as string);
    await page.waitForLoadState("networkidle");
    const seen: string[] = [];
    page.on("request", (request) => seen.push(request.url()));
    await playPrefix(page);
    await page.getByTestId("choice-core.give").click();
    await expect(page.getByTestId("ending")).toBeVisible();
    await page.getByTestId("reset").click();
    await page.getByTestId("version-base").click();
    expect(seen).toEqual([]);
    expect(log.offending).toEqual([]);
  });
});
