import { expect, test } from "@playwright/test";

import { installPhase4Api, PROJECT_ID } from "./support/phase4-api";
import { validCommitmentOutput } from "../server/support/compile-fixtures";

/**
 * The consequential dilemma, as the creator reviews it and the player meets it.
 *
 * The studio's API is mocked as in phase 4, but the build it serves is a real
 * dilemma: assembled by the production wiring and accepted by the real
 * validator. These tests are about whether the interface makes the dilemma
 * legible — the two directions side by side for the creator, and for the
 * player a choice that visibly closes the other one.
 */

const OUTPUT = validCommitmentOutput();

test("the creator sees both dramatic directions and what each gives up", async ({ page }) => {
  await installPhase4Api(page, { dilemma: true });
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible();

  const card = page.getByTestId("dilemma-audition");
  await expect(card).toContainText("Which dramatic direction should I develop?");
  await expect(page.getByTestId("dilemma-tension")).toContainText(OUTPUT.tension_text);
  await expect(page.getByTestId("dilemma-side-1")).toContainText(OUTPUT.first_response.action_label);
  await expect(page.getByTestId("dilemma-side-1")).toContainText(OUTPUT.second_response.lock_text);
  await expect(page.getByTestId("dilemma-side-2")).toContainText(OUTPUT.second_response.action_label);
  await expect(page.getByTestId("dilemma-side-2")).toContainText(OUTPUT.first_response.lock_text);
});

test("the player can take only one answer, and sees what it closed", async ({ page }) => {
  await installPhase4Api(page, { dilemma: true });
  await page.goto(`/studio/${PROJECT_ID}`);
  await page.getByTestId("compile-start").click();
  await expect(page.getByTestId("pending-review")).toBeVisible();

  await page.getByTestId("pending-choice-core.inspect").click();
  await page.getByTestId("pending-choice-core.ask_context").click();
  await expect(page.getByTestId("pending-transcript")).toContainText(OUTPUT.tension_text);

  await expect(page.getByTestId("pending-dilemma")).toContainText("rule each other out");
  const first = page.getByTestId("pending-choice-commitment.action_1");
  const second = page.getByTestId("pending-choice-commitment.action_2");
  await expect(first).toHaveClass(/choice--dilemma/);
  await expect(second).toHaveClass(/choice--dilemma/);
  await expect(page.getByTestId("pending-choice-core.give")).toBeDisabled();
  await expect(page.getByTestId("pending-choice-core.withhold")).toBeDisabled();

  await second.click();
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await expect(page.getByTestId("pending-dilemma")).toContainText(`You chose “${OUTPUT.second_response.action_label}”`);
  await expect(page.getByTestId("pending-choice-core.withhold")).toBeEnabled();
  await expect(page.getByTestId("pending-choice-core.give")).toBeDisabled();
  await expect(page.getByTestId("pending-choice-core.give")).toContainText(OUTPUT.first_response.lock_text);
});
