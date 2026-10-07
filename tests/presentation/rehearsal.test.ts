import { describe, expect, it } from "vitest";
import provenanceJson from "../../docs/phase6-canonical-pair/provenance.json";
import withInfluenceJson from "../../docs/phase6-canonical-pair/with-influence.version.json";
import withoutInfluenceJson from "../../docs/phase6-canonical-pair/without-influence.version.json";
import { observeReplayPrefix } from "../../src/engine/diff";
import { CANONICAL_PAIR, buildCanonicalPair } from "../../src/presentation/canonical-pair";
import type { CanonicalPair } from "../../src/presentation/canonical-pair";
import {
  causalSummary,
  compareAt,
  comparisonPoint,
  consequenceOf,
  firstSentence,
  listOf,
  playRows,
  runChoices,
  transcriptOf,
} from "../../src/presentation/rehearsal";
import type { Phrase } from "../../src/presentation/rehearsal";

/**
 * The Phase 6 presentation model, against the stored canonical pair (a synthetic deterministic demonstration).
 *
 * Every expectation below is read back from the three stored files rather
 * than restated by hand, so a test can only pass while the judge path shows
 * exactly what the stored versions say.
 */

const pair = CANONICAL_PAIR;
const stored = {
  withScene: withInfluenceJson.scene,
  approval: withInfluenceJson.approval_snapshot[0]!,
  witness: withInfluenceJson.validation_summary.witnesses[0]!,
  replay: withoutInfluenceJson.revision_diff.replay,
};

const moduleOf = stored.withScene.modules[0]!;
const gateText = (id: string) => moduleOf.gates.find((gate) => gate.id === id)!.blocked_text;
const actionLabel = (id: string) =>
  [...stored.withScene.core.actions, ...moduleOf.actions].find((action) => action.id === id)!.label;
const endingTitle = (id: string) =>
  stored.withScene.core.endings.find((ending) => ending.id === id)!.title;
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Raw identifiers, hashes, and validator vocabulary a judge must never see. */
const RAW_ID =
  /\b(core|discovery|commitment|approval|ref|end|scene|pr)\.[a-z0-9_]+|[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{16,}|witness|validator|#ev\d/i;

function phraseText(phrase: Phrase | null): string {
  return (phrase ?? []).map((part) => (typeof part === "string" ? part : part.em)).join("");
}

describe("the canonical pair", () => {
  it("loads both stored versions and the provenance record", () => {
    expect(pair.withScene.title).toBe(stored.withScene.title);
    expect(pair.withoutScene.title).toBe(withoutInfluenceJson.scene.title);
    expect(pair.withScene.modules).toHaveLength(1);
    expect(pair.withoutScene.modules).toHaveLength(0);
    expect(pair.influenceName).toBe(stored.approval.reference_name);
    expect(pair.influenceName).toBe(provenanceJson.reference.name);
  });

  it("uses the stored comparison point, not a hand-written one", () => {
    expect(pair.recordedPrefix).toEqual(stored.replay.prefix);
    expect(pair.storedChangedActionIds).toEqual(stored.replay.changed_action_ids);
  });

  it("keeps every causal layer verbatim from the stored record", () => {
    const { causal } = pair;
    expect(causal.source.name).toBe(provenanceJson.reference.name);
    expect(causal.source.year).toBe(provenanceJson.reference.year);
    expect(causal.source.rank).toBe(provenanceJson.reference.original_rank);
    expect(`${causal.source.year}, ${causal.source.maker}`).toBe(provenanceJson.reference.disambiguation);
    expect(causal.source.theme).toBe(provenanceJson.evidence.find((e) => e.kind === "theme")!.text);
    expect(causal.proposed.idea).toBe(stored.approval.proposed_idea);
    expect(causal.decision.approvedText).toBe(stored.approval.approved_text);
    expect(causal.decision.intendedEffect).toBe(stored.approval.intended_effect);
    expect(causal.decision.editedByCreator).toBe(true);
    // The proposal and the approval are different texts: the creator edited it.
    expect(causal.proposed.idea).not.toBe(causal.decision.approvedText);
    expect(causal.witness).toEqual({
      actionId: stored.witness.action_id,
      without: stored.witness.before,
      with: stored.witness.after,
      prefix: stored.witness.prefix,
      pairsExplored: stored.witness.pairs_explored,
    });
  });

  it("refuses a malformed record", () => {
    expect(() => buildCanonicalPair({}, withoutInfluenceJson, provenanceJson)).toThrow();
    expect(() =>
      buildCanonicalPair(
        { ...withInfluenceJson, scene: { ...withInfluenceJson.scene, title: "" } },
        withoutInfluenceJson,
        provenanceJson,
      ),
    ).toThrow();
  });
});

describe("Attribution of the saved example", () => {
  it("names the confirmed artist recorded for the stored capture's Qloo entity", () => {
    expect(provenanceJson.capture.artist_entity_id).toBe("5A000000-0000-4000-8000-000000000001");
    expect(pair.causal.artist.name).toBe("Lanternfold");
  });

  it("refuses a record whose artist is not the recorded one, rather than misnaming it", () => {
    expect(() =>
      buildCanonicalPair(withInfluenceJson, withoutInfluenceJson, {
        ...provenanceJson,
        capture: { ...provenanceJson.capture, artist_entity_id: "00000000-0000-0000-0000-000000000000" },
      }),
    ).toThrow();
  });

  it("keeps the cross-domain step and the four layers distinct, credited to the creator", () => {
    const summary = causalSummary(pair);
    expect(summary.startsWith(`Lanternfold → Qloo → ${provenanceJson.reference.name} · `)).toBe(true);
    // The stored decision is a creator edit, and the summary must not hide it.
    expect(stored.approval.edited_by_creator).toBe(true);
    expect(summary).toContain("the creator edited and approved an interpretation");
    expect(summary.endsWith("the scene changed.")).toBe(true);
    // A visitor reading the saved example did not approve anything.
    expect(summary).not.toMatch(/\byou\b/i);
  });
});

describe("Compare at the recorded point", () => {
  const comparison = compareAt(pair, pair.recordedPrefix);

  it("derives 3 changed · 3 unchanged from the two stored scenes", () => {
    expect(comparison.changedCount).toBe(3);
    expect(comparison.unchangedCount).toBe(3);
    expect(comparison.sameWorld).toBe(true);
    expect(comparison.mine).toBe(false);
  });

  it("changes exactly the actions the stored diff and the engine name", () => {
    const changed = comparison.rows.filter((row) => row.kind !== "unchanged").map((row) => row.id);
    expect([...changed].sort()).toEqual([...stored.replay.changed_action_ids].sort());
    const observed = observeReplayPrefix(pair.withScene, pair.withoutScene, pair.recordedPrefix);
    expect([...changed].sort()).toEqual([...observed.changed_action_ids].sort());
    expect(comparison.rows.filter((row) => row.kind === "unchanged").map((row) => row.id)).toEqual([
      "core.ask_terms",
      "core.withhold",
      "core.leave",
    ]);
  });

  it("orders rows in scene order, so the Without list is a prefix of the With list", () => {
    expect(comparison.rows.map((row) => row.id)).toEqual([
      "core.ask_terms",
      "core.give",
      "core.withhold",
      "core.leave",
      "discovery.action_1",
      "discovery.action_2",
    ]);
    const withoutIds = comparison.rows.filter((row) => row.without.status !== "hidden").map((row) => row.id);
    expect(comparison.rows.slice(0, withoutIds.length).map((row) => row.id)).toEqual(withoutIds);
  });

  it("reads every label and requirement from the stored versions", () => {
    for (const row of comparison.rows) expect(row.label).toBe(actionLabel(row.id));
    const give = comparison.rows.find((row) => row.id === "core.give")!;
    expect(give.kind).toBe("changed");
    expect(give.without.note).toBe(`Open · ends the scene: ${endingTitle("end.give")}`);
    // Return's lock names both requirements, each by its own stored label.
    expect(give.with.note).toBe(
      `Locked · needs: ${lower(actionLabel("discovery.action_1"))}, and ${lower(actionLabel("discovery.action_2"))}`,
    );
    for (const id of ["discovery.action_1", "discovery.action_2"]) {
      const row = comparison.rows.find((candidate) => candidate.id === id)!;
      expect(row.kind).toBe("added");
      expect(row.without.note).toBe("Not in this version");
      expect(row.with.note).toBe(`Added with ${pair.influenceName} · open now`);
    }
    expect(comparison.prefixLabels).toEqual(stored.replay.prefix.map(actionLabel));
  });
});

describe("Play at the recorded point", () => {
  const run = runChoices(pair.withScene, pair.recordedPrefix);

  it("locks Return with gate 1's stored text and +1 more requirement", () => {
    const rows = playRows(pair.withScene, run.state);
    const give = rows.find((row) => row.id === "core.give")!;
    expect(give.enabled).toBe(false);
    expect(give.reason).toBe(`Locked · ${gateText("discovery.gate_1")} +1 more requirement`);
  });

  it("names gate 2's stored text alone once the other name is asked", () => {
    const after = runChoices(pair.withScene, [...pair.recordedPrefix, "discovery.action_1"]);
    const give = playRows(pair.withScene, after.state).find((row) => row.id === "core.give")!;
    expect(give.reason).toBe(`Locked · ${gateText("discovery.gate_2")}`);
  });

  it("marks exactly the rows the approved influence's provenance binds", () => {
    const marked = playRows(pair.withScene, run.state).filter((row) => row.marked).map((row) => row.id);
    expect(marked).toEqual(["core.give", "discovery.action_1", "discovery.action_2"]);
    const without = runChoices(pair.withoutScene, pair.recordedPrefix);
    expect(playRows(pair.withoutScene, without.state).some((row) => row.marked)).toBe(false);
  });

  it("sets the transcript from the stored dialogue, verbatim", () => {
    const lines = transcriptOf(pair.withScene, { choices: pair.recordedPrefix, endingActionId: null })
      .filter((entry) => entry.kind === "line")
      .map((entry) => entry.text);
    const dialogue = [...stored.withScene.core.dialogue, ...moduleOf.dialogue];
    const text = (id: string) => dialogue.find((node) => node.id === id)!.text;
    expect(lines).toEqual([text("core.context_text"), text("core.inspect_text"), text("discovery.hook_line_1")]);
  });

  it("ends the scene in the Without version from the same two choices", () => {
    const without = runChoices(pair.withoutScene, pair.recordedPrefix);
    expect(playRows(pair.withoutScene, without.state).find((row) => row.id === "core.give")!.enabled).toBe(true);
    const entries = transcriptOf(pair.withoutScene, {
      choices: pair.recordedPrefix,
      endingActionId: "core.give",
    });
    expect(entries.at(-1)).toMatchObject({ kind: "ending", title: endingTitle("end.give") });
  });
});

describe("which point is compared", () => {
  it("uses the visitor's own choices when both versions allow them", () => {
    const point = comparisonPoint(pair, ["core.inspect"]);
    expect(point).toEqual({ prefix: ["core.inspect"], mine: true, fellBack: false });
  });

  it("falls back to the recorded point when a choice exists only with the influence", () => {
    const point = comparisonPoint(pair, ["discovery.action_1"]);
    expect(point).toEqual({ prefix: pair.recordedPrefix, mine: false, fellBack: true });
  });

  it("treats the opening position as the recorded point, not as the visitor's choices", () => {
    expect(comparisonPoint(pair, []).mine).toBe(false);
    expect(comparisonPoint(pair, pair.recordedPrefix)).toEqual({
      prefix: pair.recordedPrefix,
      mine: false,
      fellBack: false,
    });
  });

  it("says 'same next move' when nothing differs, rather than inventing a change", () => {
    const identical: CanonicalPair = { ...pair, withoutScene: pair.withScene };
    const comparison = compareAt(identical, identical.recordedPrefix);
    expect(comparison.changedCount).toBe(0);
    expect(comparison.rows.every((row) => row.kind === "unchanged")).toBe(true);
  });
});

describe("the causal note", () => {
  it("translates the stored witness into player words", () => {
    const text = phraseText(consequenceOf(pair));
    expect(text).toBe(
      `After the same two choices, ${actionLabel("core.give")} is locked with Halcyon Relay and open without it. ` +
        `With Halcyon Relay, two choices are added, and ${actionLabel("core.give")} needs both.`,
    );
  });

  it("shows the proposal's first sentence and marks that more follows", () => {
    const head = firstSentence(pair.causal.proposed.idea);
    expect(pair.causal.proposed.idea.startsWith(head.head)).toBe(true);
    expect(head.head.endsWith(".")).toBe(true);
    expect(head.truncated).toBe(true);
  });

  it("never exposes a raw id, hash, or validator term in judge-facing text", () => {
    const comparison = compareAt(pair, pair.recordedPrefix);
    const strings = [
      phraseText(consequenceOf(pair)),
      causalSummary(pair),
      ...comparison.prefixLabels,
      ...comparison.rows.flatMap((row) => [row.label, row.with.note, row.without.note]),
      ...playRows(pair.withScene, runChoices(pair.withScene, pair.recordedPrefix).state).flatMap(
        (row) => [row.label, row.reason ?? ""],
      ),
    ];
    for (const text of strings) expect(text).not.toMatch(RAW_ID);
  });

  it("joins requirement lists the way the handoff specifies", () => {
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b"])).toBe("a, and b");
    expect(listOf(["a", "b", "c"])).toBe("a, b, and c");
  });
});
