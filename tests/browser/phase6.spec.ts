import { expect, test } from "@playwright/test";
import type { Locator, Page, Request } from "@playwright/test";

import provenanceJson from "../../docs/phase6-canonical-pair/provenance.json";
import withMoonJson from "../../docs/phase6-canonical-pair/with-moon.version.json";
import withoutMoonJson from "../../docs/phase6-canonical-pair/without-moon.version.json";
import { auditContrast } from "./support/contrast";

/**
 * Browser behaviour of the Phase 6 judge path: landing → Play → Compare on
 * the real canonical pair.
 *
 * Expected strings are read from the stored version files, never retyped, so
 * these tests fail if the page drifts from what the stored versions say. The
 * geometry tests assert bounding boxes, not pixels: the shell and every
 * unchanged row must keep exactly the same box in Play and in Compare.
 */

const scene = withMoonJson.scene;
const discovery = scene.modules[0]!;
const approval = withMoonJson.approval_snapshot[0]!;
const replay = withoutMoonJson.revision_diff.replay;

const label = (id: string): string =>
  [...scene.core.actions, ...discovery.actions].find((action) => action.id === id)!.label;
const gateText = (id: string): string => discovery.gates.find((gate) => gate.id === id)!.blocked_text;
const dialogue = (id: string): string =>
  [...scene.core.dialogue, ...discovery.dialogue].find((node) => node.id === id)!.text;
const endingTitle = (id: string): string => scene.core.endings.find((e) => e.id === id)!.title;
const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

const CHANGED = [...replay.changed_action_ids].sort();
const UNCHANGED = ["core.ask_terms", "core.withhold", "core.leave"];

/** Identifiers, hashes, and validator vocabulary that must never reach the judge. */
const RAW_ID =
  /\b(core|discovery|commitment|approval|ref|end|scene|pr)\.[a-z0-9_]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{16,}|witness|validator|fp-(engine|compiler|prompts)|gpt-|supabase|phase \d/i;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
}

/** Fails on any API request and any request leaving the local origin. */
function watchNetwork(page: Page, baseURL: string): string[] {
  const offending: string[] = [];
  page.on("request", (request: Request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    if (!url.startsWith(baseURL)) {
      offending.push(url);
      return;
    }
    const path = new URL(url).pathname;
    if (path.startsWith("/api/")) offending.push(url);
  });
  return offending;
}

async function openPlay(page: Page): Promise<void> {
  await page.goto("/difference?view=play");
  await expect(page.getByTestId("rt-title")).toHaveText(scene.title);
}

async function openCompare(page: Page): Promise<void> {
  await page.goto("/difference?view=compare");
  await expect(page.getByTestId("rt-compare-headline")).toBeVisible();
}

const row = (page: Page, id: string): Locator => page.getByTestId(`rt-row-${id}`);

test.describe("Phase 6 · landing", () => {
  test("exposes both judge paths as whole-row links, with the saved-build truth label", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Choose the influences. Play the consequences.",
    );
    // Who it is for, what they test, and the decision it serves.
    await expect(page.locator(".rt-landing__lede")).toContainText("For narrative-game creators");
    await expect(page.locator(".rt-landing__lede")).toContainText("decide whether to keep it");
    const play = page.getByTestId("rt-door-play");
    const create = page.getByTestId("rt-door-create");
    await expect(play).toHaveAttribute("href", "/difference");
    await expect(create).toHaveAttribute("href", "/studio");
    await expect(play).toContainText("Play the difference");
    await expect(play).toContainText("Saved example · generated from a real build");
    await expect(play).toContainText("Plays instantly · nothing is generated live");
    await expect(create).toContainText("Create your scene");

    // The whole row is the target, and it is reachable by keyboard.
    const box = await boxOf(play);
    expect(box.height).toBeGreaterThanOrEqual(72);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(play).toBeFocused();

    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(RAW_ID);
    expect(text).not.toMatch(/fixture|database|model|infrastructure/i);
  });

  test("its specimen is the real pair's changed row", async ({ page }) => {
    await page.goto("/");
    const specimen = page.getByTestId("rt-specimen");
    await expect(specimen).toContainText(scene.title);
    await expect(specimen).toContainText(label("core.give"));
    await expect(specimen).toContainText("Locked · 2 new requirements");
  });

  test("Play the difference opens the saved example", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("rt-door-play").click();
    await expect(page).toHaveURL(/\/difference/);
    await expect(page.getByTestId("rt-title")).toHaveText(scene.title);
  });
});

test.describe("Phase 6 · canonical Play", () => {
  test("renders the stored Moon version at the recorded point, verbatim", async ({
    page,
    baseURL,
  }) => {
    const offending = watchNetwork(page, baseURL as string);
    await openPlay(page);
    await expect(page.getByTestId("rt-strip")).toContainText(scene.world.room.name);
    await expect(page.getByTestId("rt-strip")).toContainText(scene.world.room.description);
    await expect(page.getByTestId("rt-cast")).toContainText(scene.world.characters[0]!.name);
    await expect(page.getByTestId("rt-cast")).toContainText(scene.world.object.name);
    await expect(page.getByTestId("rt-cast")).toContainText(scene.world.player_role);

    const transcript = page.getByTestId("rt-transcript");
    for (const id of replay.prefix) await expect(transcript).toContainText(label(id));
    for (const id of ["core.context_text", "core.inspect_text", "discovery.hook_line_1"]) {
      await expect(transcript).toContainText(dialogue(id));
    }

    const ids = await page.getByTestId("rt-rowlist").locator("> li").evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset["action"]),
    );
    expect(ids).toEqual([...UNCHANGED.slice(0, 1), "core.give", ...UNCHANGED.slice(1), "discovery.action_1", "discovery.action_2"]);
    for (const id of ids) await expect(row(page, id!)).toContainText(label(id!));

    await expect(row(page, "core.give")).toContainText(
      `Locked · ${gateText("discovery.gate_1")} +1 more requirement`,
    );
    await expect(page.getByTestId("rt-choice-core.give")).toHaveAttribute("aria-disabled", "true");

    // Marks sit only on the rows the approved influence binds.
    for (const id of CHANGED) await expect(page.getByTestId(`rt-mark-${id}`)).toBeVisible();
    for (const id of UNCHANGED) await expect(page.getByTestId(`rt-mark-${id}`)).toHaveCount(0);
    expect(offending).toEqual([]);
  });

  test("a mark reveals the contextual causal note", async ({ page }) => {
    await openPlay(page);
    const note = page.getByTestId("rt-note");
    await expect(note).toBeHidden();
    await page.getByTestId("rt-mark-core.give").click();
    await expect(note).toBeVisible();
    await expect(page.getByTestId("rt-mark-core.give")).toHaveAttribute("aria-expanded", "true");
    await expect(note.getByTestId("rt-layer-approved")).toHaveText(approval.approved_text);
    await page.getByTestId("rt-mark-core.give").click();
    await expect(note).toBeHidden();
  });

  test("plays on: both requirements unlock Return, which ends the scene", async ({ page }) => {
    await openPlay(page);
    await page.getByTestId("rt-choice-discovery.action_1").click();
    await expect(row(page, "core.give")).toContainText(`Locked · ${gateText("discovery.gate_2")}`);
    await page.getByTestId("rt-choice-discovery.action_2").click();
    await page.getByTestId("rt-choice-core.give").click();
    await expect(page.getByTestId("rt-transcript")).toContainText(endingTitle("end.give"));
    await expect(page.getByTestId("rt-restart")).toHaveText("Play it again");
  });

  test("Without has no marks, and Return is open after the same choices", async ({ page }) => {
    await openPlay(page);
    await page.getByTestId("rt-version-without").click();
    await expect(page.getByTestId("rt-version-without")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".rt-mark:visible")).toHaveCount(0);
    await expect(page.getByTestId("rt-choice-core.give")).not.toHaveAttribute("aria-disabled", "true");
    await expect(row(page, "discovery.action_1")).toBeHidden();
  });
});

test.describe("Phase 6 · canonical Compare", () => {
  test("derives 3 changed · 3 unchanged and splits exactly the changed rows", async ({
    page,
    baseURL,
  }) => {
    const offending = watchNetwork(page, baseURL as string);
    await openCompare(page);
    await expect(page.getByTestId("rt-compare-headline")).toHaveText("Same choices. Different next move.");
    await expect(page.getByTestId("rt-compare-count")).toContainText(`${CHANGED.length} choices changed`);
    await expect(page.getByTestId("rt-compare-count")).toContainText("3 unchanged");
    await expect(page.getByTestId("rt-compare-prefix")).toHaveText(replay.prefix.map(label).join(" → "));

    const kinds = await page.getByTestId("rt-rowlist").locator("> li").evaluateAll((items) =>
      items.map((item) => [(item as HTMLElement).dataset["action"], (item as HTMLElement).dataset["kind"]]),
    );
    const changed = kinds.filter(([, kind]) => kind !== "unchanged").map(([id]) => id).sort();
    expect(changed).toEqual(CHANGED);
    expect(kinds.filter(([, kind]) => kind === "unchanged").map(([id]) => id)).toEqual(UNCHANGED);

    for (const id of UNCHANGED) await expect(page.getByTestId(`rt-split-${id}`)).toHaveCount(0);
    for (const id of CHANGED) await expect(page.getByTestId(`rt-split-${id}`)).toBeVisible();

    await expect(page.getByTestId("rt-note-without-core.give")).toHaveText(
      `Open · ends the scene: ${endingTitle("end.give")}`,
    );
    await expect(page.getByTestId("rt-note-with-core.give")).toHaveText(
      `Locked · needs: ${lower(label("discovery.action_1"))}, and ${lower(label("discovery.action_2"))}`,
    );
    for (const id of ["discovery.action_1", "discovery.action_2"]) {
      await expect(page.getByTestId(`rt-note-without-${id}`)).toHaveText("Not in this version");
      await expect(page.getByTestId(`rt-note-with-${id}`)).toHaveText("Added with Moon · open now");
      await expect(page.getByTestId(`rt-cell-with-${id}`)).toContainText(label(id));
    }
    expect(offending).toEqual([]);
  });

  test("the causal note shows the four stored layers in their own materials", async ({ page }) => {
    await openCompare(page);
    const note = page.getByTestId("rt-note");
    await expect(note).toBeVisible();
    await expect(note.getByTestId("rt-layer-source")).toContainText(provenanceJson.reference.name);
    await expect(note.getByTestId("rt-layer-source")).toContainText("film · 2009 · Duncan Jones");
    const proposed = await note.getByTestId("rt-layer-proposed").innerText();
    expect(approval.proposed_idea.startsWith(proposed.replace(/…$/, ""))).toBe(true);
    await expect(note.getByTestId("rt-layer-approved")).toHaveText(approval.approved_text);
    await expect(note).toContainText("Edited by the creator");
    await expect(note.getByTestId("rt-layer-consequence")).toHaveText(
      `After the same two choices, ${label("core.give")} is locked with Moon and open without it. ` +
        `With Moon, two choices are added, and ${label("core.give")} needs both.`,
    );
    // Suggestion and decision are different materials.
    const proposedStyle = await note.getByTestId("rt-layer-proposed").evaluate((el) => getComputedStyle(el).fontStyle);
    const approvedStyle = await note.getByTestId("rt-layer-approved").evaluate((el) => getComputedStyle(el).fontStyle);
    expect(proposedStyle).toBe("italic");
    expect(approvedStyle).toBe("normal");
  });

  test("the saved example names Radiohead and credits the creator, not the visitor", async ({ page }) => {
    await openCompare(page);
    const note = page.getByTestId("rt-note");
    await expect(note.getByTestId("rt-layer-source")).toContainText(
      `Radiohead → Qloo → ${provenanceJson.reference.name}`,
    );
    await expect(note.locator(".rt-layer__label--decision")).toContainText("the creator approved");
    await expect(note.locator(".rt-layer__label--decision")).toContainText("Edited by the creator");
    await expect(page.getByTestId("rt-compare-heads")).toContainText("creator approved");
    await page.getByTestId("rt-note").locator(".rt-note__more > summary").click();
    for (const path of ["/difference?view=compare", "/difference?view=play"]) {
      if (path !== "/difference?view=compare") await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(/\byou (edited|approved|confirmed)\b|edited by you|artist you confirmed|interpretation is yours/i);
    }
  });

  test("no raw id, hash, or validator term reaches the page", async ({ page }) => {
    await openCompare(page);
    await page.getByTestId("rt-note").locator(".rt-note__more > summary").click();
    for (const path of ["/difference?view=compare", "/difference?view=play"]) {
      if (path !== "/difference?view=compare") await page.goto(path);
      const text = await page.locator("body").innerText();
      expect(text).not.toMatch(RAW_ID);
      expect(text).not.toContain(withMoonJson.validation_summary.witnesses[0]!.sentence);
    }
  });

  test("the revision colour appears only on observed-change elements", async ({ page }) => {
    await openCompare(page);
    await page.waitForTimeout(1200);
    const offenders = await page.evaluate(() => {
      const REV = ["rgb(176, 21, 76)", "rgb(249, 225, 232)", "rgb(140, 15, 59)"];
      const allowed = [
        ".rt-mark",
        ".rt-cmp__changed",
        ".rt-note__head",
        ".rt-note__title",
        ".rt-layer__label--change",
        ".rt-consequence",
        ".rt-cell--with",
        ".rt-why__title",
        ".rt-specimen__cell--with",
        ".rt-specimen__mark",
        ".rt-row[data-kind='added']",
        ".rt-sheet",
      ].join(", ");
      const bad: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(".rt *")) {
        const style = getComputedStyle(element);
        const values = [style.color, style.backgroundColor, style.borderTopColor, style.borderBottomColor];
        if (!values.some((value) => REV.includes(value))) continue;
        if (element.closest(allowed) === null) bad.push(element.className || element.tagName);
      }
      return bad;
    });
    expect(offenders).toEqual([]);
  });
});

test.describe("Phase 6 · Play ↔ Compare", () => {
  test("the shell and every unchanged row keep identical boxes across modes", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await openPlay(page);
    const stable = [
      page.getByTestId("rt-topbar"),
      page.getByTestId("rt-strip"),
      page.getByTestId("rt-title"),
      page.getByTestId("rt-cast"),
      page.getByTestId("rt-band"),
      page.getByTestId("rt-head"),
      ...UNCHANGED.map((id) => row(page, id)),
      // Changed rows split in place: the row itself does not move either.
      ...CHANGED.map((id) => row(page, id)),
    ];
    const before = await Promise.all(stable.map(boxOf));
    const labelBefore = await boxOf(row(page, "core.give").locator(".rt-row__label"));

    await page.getByTestId("rt-tab-compare").click();
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "compare");
    await page.waitForTimeout(1000);
    const after = await Promise.all(stable.map(boxOf));
    expect(after).toEqual(before);
    // "Return the letter" stays put: the Without cell starts at the single label's x.
    const withoutLabel = await boxOf(page.getByTestId("rt-cell-without-core.give").locator(".rt-cell__label"));
    expect(withoutLabel.x).toBe(labelBefore.x);
    expect(withoutLabel.y).toBe(labelBefore.y);

    await page.getByTestId("rt-tab-play").click();
    await page.waitForTimeout(400);
    expect(await Promise.all(stable.map(boxOf))).toEqual(before);
  });

  test("first entry opens on Play, then splits into Compare by itself", async ({ page }) => {
    await page.goto("/difference");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "play");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "compare", { timeout: 4000 });
    await expect(page).toHaveURL(/view=compare/);
  });

  test("follows the handoff timings, with the note resolving last", async ({ page }) => {
    await openPlay(page);
    await page.getByTestId("rt-tab-compare").click();
    const timing = async (selector: string) =>
      page.locator(selector).first().evaluate((el) => {
        const style = getComputedStyle(el);
        return { delay: style.transitionDelay, duration: style.transitionDuration };
      });
    expect((await timing(".rt-note")).delay).toContain("0.62s");
    expect((await timing(".rt-band__cmp")).delay).toContain("0.2s");
    expect((await timing("[data-testid='rt-split-core.give']")).delay).toContain("0.2s");
    expect((await timing("[data-testid='rt-mark-core.give']")).delay).toContain("0.45s");
    await expect
      .poll(() => page.getByTestId("rt-note").evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");
  });

  test("reduced motion lands directly on the final Compare state", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPlay(page);
    await page.getByTestId("rt-tab-compare").click();
    const state = await page.evaluate(() => {
      const read = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement;
        const style = getComputedStyle(el);
        return { opacity: style.opacity, duration: style.transitionDuration };
      };
      return {
        note: read(".rt-note"),
        split: read("[data-testid='rt-split-core.give']"),
        band: read(".rt-band__cmp"),
        stock: getComputedStyle(document.querySelector(".rt-cell--with")!, "::before").transform,
      };
    });
    expect(state.note).toEqual({ opacity: "1", duration: "0s" });
    expect(state.split).toEqual({ opacity: "1", duration: "0s" });
    expect(state.band).toEqual({ opacity: "1", duration: "0s" });
    expect(state.stock).toBe("matrix(1, 0, 0, 1, 0, 0)");
  });

  test("Continue without replays the compared choices in the Without version", async ({ page }) => {
    await openCompare(page);
    await page.getByTestId("rt-continue-without").click();
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "play");
    await expect(page.getByTestId("rt-version-without")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("rt-choice-core.give").click();
    await expect(page.getByTestId("rt-transcript")).toContainText(endingTitle("end.give"));
  });

  test("keyboard: P / C switch modes, W / O switch versions, rows are buttons in order", async ({
    page,
  }) => {
    await openPlay(page);
    await page.keyboard.press("c");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "compare");
    await page.keyboard.press("p");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "play");
    await page.keyboard.press("o");
    await expect(page.getByTestId("rt-version-without")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("w");
    await expect(page.getByTestId("rt-version-with")).toHaveAttribute("aria-pressed", "true");

    const first = page.getByTestId("rt-choice-core.ask_terms");
    await first.focus();
    await expect(first).toBeFocused();
    // The 1.5px ink ring (Chrome snaps its width to whole device pixels at 1x).
    const ring = await first.evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, color: style.outlineColor, offset: style.outlineOffset };
    });
    expect(ring).toEqual({ style: "solid", color: "rgb(20, 21, 24)", offset: "2px" });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("rt-transcript")).toContainText(dialogue("core.promise_text"));
  });
});

test.describe("Phase 6 · contrast", () => {
  for (const [name, path, width] of [
    ["landing", "/", 1440],
    ["Play", "/difference?view=play", 1440],
    ["Compare", "/difference?view=compare", 1440],
    ["mobile Play", "/difference?view=play", 390],
    ["mobile Compare", "/difference?view=compare", 390],
  ] as const) {
    test(`every meaningful text on ${name} at ${width}px reaches AA`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.locator(".rt").first()).toBeVisible();
      if (name === "Play") await page.getByTestId("rt-mark-core.give").click();
      expect(await auditContrast(page)).toEqual([]);
    });
  }
});

test.describe("Phase 6 · shortcuts can be turned off (WCAG 2.1.4)", () => {
  test("turning them off stops single keys, and the choice survives a reload", async ({ page }) => {
    await openPlay(page);
    const toggle = page.getByTestId("rt-shortcuts-toggle");
    await expect(toggle).toHaveText("Turn off");
    await expect(page.getByTestId("rt-tab-compare")).toHaveAttribute("aria-keyshortcuts", "C");

    await toggle.click();
    await expect(toggle).toHaveText("Turn on");
    await expect(page.getByTestId("rt-tab-compare")).not.toHaveAttribute("aria-keyshortcuts", /.*/);
    await page.locator("body").press("c");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "play");

    await page.reload();
    await expect(page.getByTestId("rt-shortcuts-toggle")).toHaveText("Turn on");
    await page.locator("body").press("c");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "play");

    await page.getByTestId("rt-shortcuts-toggle").click();
    await page.locator("body").press("c");
    await expect(page.locator(".rt-scene")).toHaveAttribute("data-view", "compare");
  });
});

test.describe("Phase 6 · mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("changed rows stack WITHOUT / WITH inside one row, with no horizontal pan", async ({ page }) => {
    await openCompare(page);
    const without = await boxOf(page.getByTestId("rt-cell-without-core.give"));
    const withCell = await boxOf(page.getByTestId("rt-cell-with-core.give"));
    expect(withCell.y).toBeGreaterThan(without.y);
    expect(Math.abs(withCell.x - without.x)).toBeLessThanOrEqual(8);
    expect(withCell.width).toBeGreaterThan(300);
    await expect(page.getByTestId("rt-compare-heads")).toBeHidden();
    await expect(page.getByTestId("rt-cell-with-core.give")).toContainText("With Moon");
    await expect(row(page, "discovery.action_1")).toContainText("Added with Moon · without: not in this version");

    for (const id of [...UNCHANGED, ...CHANGED]) {
      expect((await boxOf(row(page, id))).height).toBeGreaterThanOrEqual(52);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("provenance sits below the rows and opens the four layers in a sheet", async ({ page }) => {
    await openCompare(page);
    const summary = page.getByTestId("rt-why-summary");
    await expect(summary).toBeVisible();
    await expect(page.getByTestId("rt-note")).toBeHidden();
    const lastRow = await boxOf(row(page, "discovery.action_2"));
    expect((await boxOf(summary)).y).toBeGreaterThan(lastRow.y);

    await summary.click();
    const sheet = page.getByTestId("rt-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("rt-layer-approved")).toHaveText(approval.approved_text);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("Play pins the version buttons to the bottom", async ({ page }) => {
    await openPlay(page);
    const pinned = page.getByTestId("rt-version-pinned-without");
    await expect(pinned).toBeVisible();
    const box = await boxOf(pinned);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await pinned.click();
    await expect(page.getByTestId("rt-choice-core.give")).not.toHaveAttribute("aria-disabled", "true");
  });
});
