import { describe, expect, it } from "vitest";
import type { DecisionRequest } from "../../src/domain/audition";
import { compareAudiences, type ComparedComp } from "../../src/domain/audition-compare";
import { decideForeground, decisionAnswer, decisionQuestion } from "../../src/domain/audition-decision";
import type { ConfirmedEntityView, DomainAuditionView } from "../../src/domain/audition-view";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RADIOHEAD = { slot_id: "s8", entity_id: id(100), name: "Radiohead", search_capture_id: id(900), original_rank: 1 } satisfies ConfirmedEntityView;
const KENDRICK = { slot_id: "s9", entity_id: id(101), name: "Kendrick Lamar", search_capture_id: id(901), original_rank: 1 } satisfies ConfirmedEntityView;
const MOVIES = ["Moon", "Arrival", "O Brother"].map((name, i) => ({ entity_id: id(i + 1), name, domain: "movie" as const }));
const GAMES = ["Outer Wilds", "Death Stranding"].map((name, i) => ({ entity_id: id(i + 11), name, domain: "videogame" as const }));

function view(comps: ComparedComp[], a: (number | null)[], b: (number | null)[]): DomainAuditionView {
  const domain = comps[0]!.domain;
  const scores = (audience: ConfirmedEntityView, values: (number | null)[]) => ({
    audience_entity_id: audience.entity_id, audience_name: audience.name, domain,
    affinities: new Map(comps.map((c, i) => [c.entity_id, values[i] ?? null])),
  });
  return {
    domain,
    comps: comps.map((c, i) => ({ slot_id: `s${i + 1}`, entity_id: c.entity_id, name: c.name, search_capture_id: id(800), original_rank: 1 })),
    comparison: compareAudiences(domain, comps, scores(RADIOHEAD, a), scores(KENDRICK, b)),
    evidence: [],
  };
}

const ask = (domain: "movie" | "videogame", audience = RADIOHEAD): DecisionRequest =>
  ({ action: "foreground_comp", domain, audience_slot_id: audience.slot_id });

describe("decideForeground", () => {
  it("names a clear movie lead only when it beats every other scored comp by the threshold", () => {
    const result = decideForeground(ask("movie"), view(MOVIES, [0.81, 0.62, 0.6], [0.31, 0.55, 0.54]), RADIOHEAD);
    expect(result.outcome).toEqual({ status: "clear_lead", lead: { entity_id: id(1), name: "Moon" } });
    expect(decisionQuestion(result)).toBe("Which movie comp should I foreground for Radiohead fans?");
    expect(decisionAnswer(result)).toBe("For this audience signal, Moon is the clear lead among your confirmed movie comps.");
  });

  it("calls a top movie pair under 0.03 too close, naming no leader", () => {
    const result = decideForeground(ask("movie", KENDRICK), view(MOVIES, [0.81, 0.62, 0.6], [0.31, 0.55, 0.54]), KENDRICK);
    expect(result.outcome).toEqual({ status: "too_close", close: [{ entity_id: id(2), name: "Arrival" }, { entity_id: id(3), name: "O Brother" }] });
    expect(decisionAnswer(result)).toBe("These top movie comps are too close for this tool to call: Arrival, O Brother.");
    expect(decisionAnswer(result)).not.toMatch(/best|fit|convert|demand|significan/i);
  });

  it("names a clear videogame lead from videogame scores alone", () => {
    const result = decideForeground(ask("videogame", KENDRICK), view(GAMES, [0.7, 0.69], [0.4, 0.6]), KENDRICK);
    expect(result.outcome).toEqual({ status: "clear_lead", lead: { entity_id: id(12), name: "Death Stranding" } });
    expect(decisionAnswer(result)).toBe("For this audience signal, Death Stranding is the clear lead among your confirmed game comps.");
  });

  it("never compares across domains", () => {
    expect(() => decideForeground(ask("movie"), view(GAMES, [0.7, 0.69], [0.4, 0.6]), RADIOHEAD)).toThrow("Decision domain mismatch");
    // Movie comps only, even when the games would score higher.
    const result = decideForeground(ask("movie"), view(MOVIES, [0.5, 0.2, 0.1], [0.5, 0.2, 0.1]), RADIOHEAD);
    expect(result.domain).toBe("movie");
    expect(result.outcome).toMatchObject({ lead: { name: "Moon" } });
  });

  it("makes no call without enough confirmed and scored evidence", () => {
    expect(decideForeground(ask("videogame"), null, RADIOHEAD).outcome).toEqual({ status: "insufficient_evidence", reason: "no_comps" });
    const single = decideForeground(ask("movie"), view(MOVIES, [0.5, null, null], [0.5, 0.4, 0.3]), RADIOHEAD);
    expect(single.outcome).toEqual({ status: "insufficient_evidence", reason: "single_comp" });
    expect(single.not_scored.map((c) => c.name)).toEqual(["Arrival", "O Brother"]);
    const none = decideForeground(ask("movie"), view(MOVIES, [null, null, null], [0.5, 0.4, 0.3]), RADIOHEAD);
    expect(none.outcome).toEqual({ status: "insufficient_evidence", reason: "no_scores" });
    for (const r of [single, none]) expect(decisionAnswer(r)).toMatch(/nothing to call|makes no call/);
  });

  it("matches the existing ranking's top status exactly, including the 0.03 boundary", () => {
    const cases: [number, number, number][] = [[0.53, 0.5, 0.1], [0.529, 0.5, 0.1], [0.8, 0.77, 0.76], [0.5, 0.5, 0.5], [0.9, 0.1, 0.89]];
    for (const values of cases) {
      const v = view(MOVIES, values, values);
      const { top } = v.comparison.rankings[0];
      const { outcome } = decideForeground(ask("movie"), v, RADIOHEAD);
      expect(outcome.status).toBe(top.status === "clear" ? "clear_lead" : "too_close");
      const named = outcome.status === "clear_lead" ? [outcome.lead.entity_id] : outcome.status === "too_close" ? outcome.close.map((c) => c.entity_id) : [];
      expect(named).toEqual(top.leaders);
    }
  });
});
