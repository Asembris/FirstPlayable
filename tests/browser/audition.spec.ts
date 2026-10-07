import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { clarificationSlotContext } from "../../src/domain/audition";
import { compareAudiences } from "../../src/domain/audition-compare";
import { decideForeground } from "../../src/domain/audition-decision";
import type { AuditionState, InterpretResponse } from "../../src/domain/audition";
import type { ConfirmedEntityView, ScoreResponse } from "../../src/domain/audition-view";

/**
 * The comp audition loop in a real browser: ask → confirm → score → compare.
 *
 * The application's own routes are mocked, as in the other browser specs,
 * because this gate runs with persistence deliberately unconfigured and must
 * reach no external service. The mocked score is produced by the real
 * `compareAudiences`, from synthetic affinities, so what the page renders is
 * what the deterministic layer decides. The real handlers are covered by
 * `tests/server/audition-routes.test.ts`.
 */

const CAPTURE = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MOON = "B0000000-0000-4000-8000-0000000000B1";
const MOONRISE = "B0000000-0000-4000-8000-0000000000B9";
const ARRIVAL = "B0000000-0000-4000-8000-0000000000B2";
const RADIOHEAD = "A0000000-0000-4000-8000-0000000000A0";
const KENDRICK = "A0000000-0000-4000-8000-0000000000A1";

const SEARCH: Record<string, { kind: "movie" | "audience"; query: string; candidates: [string, string, string | null][] }> = {
  s1: { kind: "movie", query: "Moon", candidates: [[MOON, "Moon", "2009"], [MOONRISE, "Moonrise Kingdom", "2012"]] },
  s2: { kind: "movie", query: "Arrival", candidates: [[ARRIVAL, "Arrival", "2016"]] },
  s3: { kind: "audience", query: "Radiohead", candidates: [[RADIOHEAD, "Radiohead", null]] },
  s4: { kind: "audience", query: "Kendrick Lamar", candidates: [[KENDRICK, "Kendrick Lamar", null]] },
};

const NAMES: Record<string, string> = { [MOON]: "Moon", [ARRIVAL]: "Arrival", [RADIOHEAD]: "Radiohead", [KENDRICK]: "Kendrick Lamar" };
const AFFINITY: Record<string, Record<string, number>> = {
  [RADIOHEAD]: { [MOON]: 0.81, [ARRIVAL]: 0.62 },
  [KENDRICK]: { [MOON]: 0.31, [ARRIVAL]: 0.55 },
};

function interpretResponse(): InterpretResponse {
  const ids = Object.keys(SEARCH);
  return {
    state: {
      slots: ids.map((id, index) => ({
        slot_id: id,
        kind: SEARCH[id]!.kind,
        query: SEARCH[id]!.query,
        search_capture_id: CAPTURE(index + 1),
        confirmed_entity_id: null,
      })),
    },
    applied: ids.map((id) => ({ op: "add", slot_id: id, kind: SEARCH[id]!.kind, query: SEARCH[id]!.query })),
    skipped: [],
    clarification: null,
    decision: null,
    searches: ids.map((id, index) => ({
      slot_id: id,
      kind: SEARCH[id]!.kind,
      search_capture_id: CAPTURE(index + 1),
      retrieved_at: "2026-10-07T10:00:00.000Z",
      cache: "live",
      candidates: SEARCH[id]!.candidates.map(([entity_id, name, hint], rank) => ({ entity_id, name, hint, original_rank: rank + 1 })),
    })),
    model_calls: 1,
    upstream_calls: 4,
  };
}

function scoreResponse(state: AuditionState): ScoreResponse {
  const view = (slotId: string, entityId: string): ConfirmedEntityView => ({
    slot_id: slotId,
    entity_id: entityId,
    name: NAMES[entityId]!,
    search_capture_id: CAPTURE(1),
    original_rank: 1,
  });
  const confirmed = state.slots.filter((s) => s.confirmed_entity_id !== null);
  const audiences = confirmed.filter((s) => s.kind === "audience").map((s) => view(s.slot_id, s.confirmed_entity_id!));
  const comps = confirmed.filter((s) => s.kind === "movie").map((s) => view(s.slot_id, s.confirmed_entity_id!));
  const scores = (audience: ConfirmedEntityView) => ({
    audience_entity_id: audience.entity_id,
    audience_name: audience.name,
    domain: "movie" as const,
    affinities: new Map(Object.entries(AFFINITY[audience.entity_id]!)),
  });
  const comparison = compareAudiences(
    "movie",
    comps.map((c) => ({ entity_id: c.entity_id, name: c.name, domain: "movie" as const })),
    scores(audiences[0]!),
    scores(audiences[1]!),
  );
  const movie = {
    domain: "movie" as const,
    comps,
    // Maps do not survive JSON; the rendered comparison never needs them.
    comparison,
    evidence: audiences.map((a) => ({
      audience_entity_id: a.entity_id,
      capture_id: CAPTURE(9),
      retrieved_at: "2026-10-07T10:00:01.000Z",
      cache: "live" as const,
      request: `GET /v2/insights?filter.type=urn:entity:movie&signal.interests.entities=${a.entity_id}&filter.results.entities=${[ARRIVAL, MOON].join(",")}&take=2`,
      missing_entity_ids: [],
    })),
  };
  const asked = state.decision_request;
  return {
    audiences: [audiences[0]!, audiences[1]!],
    domains: { movie, videogame: null },
    unconfirmed: [],
    decision: asked === undefined ? null : decideForeground(asked, asked.domain === "movie" ? movie : null, audiences.find((a) => a.slot_id === asked.audience_slot_id)!),
    upstream_calls: 2,
  };
}

async function install(page: Page): Promise<{ scored: AuditionState[] }> {
  const scored: AuditionState[] = [];
  const reply = (route: Route, value: unknown) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/session", (route) => reply(route, { established: true, expires_at: "2026-11-07T00:00:00.000Z" }));
  await page.route("**/api/audition/interpret", (route) => reply(route, interpretResponse()));
  await page.route("**/api/audition/score", (route) => {
    const state = (route.request().postDataJSON() as { state: AuditionState }).state;
    scored.push(state);
    return reply(route, scoreResponse(state));
  });
  return { scored };
}

test("ask, confirm, score, and see the audience switch reverse a pair", async ({ page, baseURL }) => {
  const foreign: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(baseURL ?? "") && !request.url().startsWith("data:")) foreign.push(request.url());
  });
  const { scored } = await install(page);

  await page.goto("/audition?mode=live");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Choose the comps. Switch the audience. See what changes.",
  );

  await page.getByTestId("audition-send").click();
  await expect(page.getByTestId("audition-transcript")).toContainText("searching movie comp “Moon”");

  // Nothing is confirmed for the creator, so scoring is locked.
  const scoreButton = page.getByTestId("audition-score");
  await expect(scoreButton).toBeDisabled();

  await page.getByTestId("confirm-s1-1").check();
  await page.getByTestId("confirm-s2-1").check();
  await page.getByTestId("confirm-s3-1").check();
  await expect(scoreButton).toBeDisabled();
  await page.getByTestId("confirm-s4-1").check();
  await expect(scoreButton).toBeEnabled();
  await scoreButton.click();

  // The request carried exactly what the creator confirmed.
  expect(scored[0]?.slots.map((s) => s.confirmed_entity_id)).toEqual([MOON, ARRIVAL, RADIOHEAD, KENDRICK]);

  const results = page.getByTestId("audition-results");
  await expect(results.getByRole("heading", { level: 2 })).toHaveText("Radiohead vs Kendrick Lamar");
  await expect(page.getByTestId("headline-movie")).toContainText("Switching audience reverses one pair");

  const radiohead = page.getByTestId(`ranking-movie-${RADIOHEAD}`);
  const kendrick = page.getByTestId(`ranking-movie-${KENDRICK}`);
  await expect(radiohead.getByTestId("ranked").locator(".rt-audition__name")).toHaveText(["Moon", "Arrival"]);
  await expect(kendrick.getByTestId("ranked").locator(".rt-audition__name")).toHaveText(["Arrival", "Moon"]);
  await expect(radiohead.getByTestId("ranked").first()).toContainText("affinity 0.810");
  await expect(page.locator('[data-verdict="reversal"]')).toHaveCount(1);
  await expect(page.getByTestId("panel-videogame")).toContainText("No confirmed game comps");
  await expect(results).toContainText("not statistical significance");

  await page.getByTestId("evidence-movie").locator("summary").click();
  await expect(page.getByTestId("evidence-movie")).toContainText("filter.results.entities=");
  await expect(page.getByTestId("evidence-movie").locator("summary")).toHaveText("Qloo evidence");
  await expect(page.getByTestId("evidence-note-movie")).toContainText("Names come from the Qloo search result you confirmed");
  await expect(page.getByTestId("evidence-movie")).toContainText(`Moon — Qloo ${MOON}`);
  await expect(page.getByTestId("evidence-movie")).not.toContainText(/synthetic/i);

  expect(foreign).toEqual([]);
});

test("a creator choice other than Qloo's first result is the one sent", async ({ page }) => {
  const { scored } = await install(page);
  await page.goto("/audition?mode=live");
  await page.getByTestId("audition-send").click();
  await page.getByTestId("confirm-s1-2").check();
  for (const slot of ["s2", "s3", "s4"]) await page.getByTestId(`confirm-${slot}-1`).check();
  await page.route("**/api/audition/score", (route) => {
    scored.push((route.request().postDataJSON() as { state: AuditionState }).state);
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ code: "REQUEST_REFUSED", message: "Stopped for the test.", retryable: false, last_good_version_id: null, request_id: "t" }),
    });
  });
  await page.getByTestId("audition-score").click();
  await expect(page.getByTestId("audition-failure")).toContainText("Stopped for the test.");
  expect(scored.at(-1)?.slots[0]?.confirmed_entity_id).toBe(MOONRISE);
});


test("pending Alien clarification survives browser state and confirmation, then clears", async ({ page }) => {
  const requests: { message: string; state: AuditionState }[] = [];
  const message = "Add Alien, but ask me whether I mean the film or the game before searching.";
  const question = "Do you mean the film or the game?";
  await page.route("**/api/session", route => route.fulfill({ json: { established: true } }));
  await page.route("**/api/audition/interpret", async route => {
    const input = route.request().postDataJSON() as { message: string; state: AuditionState };
    requests.push(input);
    const value = interpretResponse();
    value.state.slots = [ { ...value.state.slots[0]!, query: "Dune" } ];
    value.searches = [ { ...value.searches[0]!, candidates: [{ entity_id: MOON, name: "Dune", hint: null, original_rank: 1 }] } ];
    value.applied = [];
    if (requests.length === 2) {
      value.clarification = question;
      value.state.pending_clarification = { action: { op: "add", slot_id: null, query: "Alien" }, ambiguity: "media_type", choices: ["movie", "videogame"], question, slot_context: clarificationSlotContext(value.state.slots) };
    }
    if (requests.length >= 3) {
      value.state.slots = [...input.state.slots];
      if (requests.length === 3) value.state.slots.push({ slot_id: "s2", kind: "movie", query: "Alien", search_capture_id: CAPTURE(2), confirmed_entity_id: null });
      value.searches = [];
    }
    await route.fulfill({ json: value });
  });
  await page.goto("/audition?mode=live");
  await page.getByTestId("audition-message").fill("Add the film Dune");
  await page.getByTestId("audition-send").click();
  await expect(page.getByTestId("confirm-s1-1")).toBeVisible();
  await page.getByTestId("audition-message").fill(message);
  await page.getByTestId("audition-send").click();
  await expect(page.getByTestId("audition-transcript")).toContainText(question);
  // Creator identity confirmation must preserve pending context.
  await page.getByTestId("confirm-s1-1").check();
  await page.getByTestId("audition-message").fill("The film");
  await page.getByTestId("audition-send").click();
  await expect(page.getByTestId("audition-transcript")).toContainText("You: The film");
  expect(requests[2]!.state.pending_clarification).toMatchObject({ action: { op: "add", slot_id: null, query: "Alien" }, question });
  expect(requests[2]!.state.slots[0]!.confirmed_entity_id).toBe(MOON);
  await page.getByTestId("audition-message").fill("Add the movie Arrival");
  await page.getByTestId("audition-send").click();
  await expect(page.getByTestId("audition-transcript")).toContainText("You: Add the movie Arrival");
  expect(requests[3]!.state.pending_clarification).toBeUndefined();
  expect(requests[3]!.state.slots.map(slot => slot.query)).toEqual(["Dune", "Alien"]);
});

test("a bounded decision question is answered by the scored comparison, not the agent", async ({ page }) => {
  const { scored } = await install(page);
  await page.goto("/audition?mode=live");
  await page.getByTestId("audition-send").click();
  for (const slot of ["s1", "s2", "s3", "s4"]) await page.getByTestId(`confirm-${slot}-1`).check();
  await page.getByTestId("audition-score").click();
  await expect(page.getByTestId("audition-results")).toBeVisible();
  await expect(page.getByTestId("audition-decision")).toHaveCount(0);

  await page.route("**/api/audition/interpret", (route) => {
    const { state } = route.request().postDataJSON() as { state: AuditionState };
    const decision = { action: "foreground_comp" as const, domain: "movie" as const, audience_slot_id: "s3" };
    const value: InterpretResponse = { ...interpretResponse(), state: { ...state, decision_request: decision }, applied: [], searches: [], decision, upstream_calls: 0 };
    return route.fulfill({ json: value });
  });
  await page.getByTestId("audition-message").fill("Which movie comp should I foreground for Radiohead fans?");
  await page.getByTestId("audition-send").click();
  await expect(page.getByTestId("audition-transcript")).toContainText("noted your decision question");

  const card = page.getByTestId("audition-decision");
  await expect(card).toHaveAttribute("data-status", "clear_lead");
  await expect(page.getByTestId("decision-question")).toHaveText("Which movie comp should I foreground for Radiohead fans?");
  await expect(page.getByTestId("decision-answer")).toHaveText("For this audience signal, Moon is the clear lead among your confirmed movie comps.");
  await expect(page.getByTestId("decision-basis")).toContainText("Qloo audience affinity for Radiohead fans");
  await expect(page.getByTestId("decision-basis")).toContainText("not the assistant");
  await expect(card).not.toContainText(/best comp/i);
  expect(scored.at(-1)?.decision_request).toEqual({ action: "foreground_comp", domain: "movie", audience_slot_id: "s3" });
  await expect(page.getByTestId(`ranking-movie-${RADIOHEAD}`)).toHaveAttribute("data-active", "true");
});
