import { describe, expect, it } from "vitest";
import { clarificationSlotContext, type AuditionState } from "../../src/domain/audition";
import {
  AGENT_INSTRUCTIONS,
  agentInput,
  AgentPlanSchema,
  applyPlan,
  MAX_AGENT_ACTIONS,
  resolveClarification,
} from "../../src/server/audition/agent";

const STATE: AuditionState = {
  slots: [
    { slot_id: "s1", kind: "movie", query: "Moon", search_capture_id: "11111111-1111-4111-8111-111111111111", confirmed_entity_id: "B0000000-0000-4000-8000-0000000000B1" },
    { slot_id: "s2", kind: "audience", query: "Radiohead", search_capture_id: null, confirmed_entity_id: null },
    { slot_id: "s3", kind: "audience", query: "Kendrick Lamar", search_capture_id: null, confirmed_entity_id: null },
  ],
};

describe("the agent's output contract", () => {
  it("has no numeric field anywhere, so it cannot carry a score or a rank", () => {
    const schema = JSON.stringify(AgentPlanSchema.toJSONSchema());
    expect(schema).not.toMatch(/"type":"(number|integer)"/);
  });

  it("rejects an output that tries to add a score, a rank, or a winner", () => {
    const base = { op: "add", kind: "movie", slot_id: null, query: "Arrival" };
    expect(AgentPlanSchema.safeParse({ actions: [], clarification: "Film or game?", deferred_action: null, decision: null }).success).toBe(false);
    expect(AgentPlanSchema.safeParse({ actions: [], clarification: null, deferred_action: { op: "add", slot_id: null, query: "Alien" } }).success).toBe(false);
    for (const extra of [{ affinity: 0.9 }, { rank: 1 }, { score: "high" }]) {
      expect(AgentPlanSchema.safeParse({ actions: [{ ...base, ...extra }], clarification: null, deferred_action: null, decision: null }).success).toBe(false);
    }
    expect(AgentPlanSchema.safeParse({ actions: [base], clarification: null, deferred_action: null, decision: null, winner: "Arrival" }).success).toBe(false);
    expect(AgentPlanSchema.safeParse({ actions: [base], clarification: null, deferred_action: null, decision: null }).success).toBe(true);
    for (const extra of [{ affinity: 0.9 }, { rank: 1 }, { score: "high" }]) {
      expect(AgentPlanSchema.safeParse({ actions: [], clarification: "Film or game?", deferred_action: { op: "add", slot_id: null, query: "Alien", ...extra } }).success).toBe(false);
    }
  });

  it("tells the model it cannot rank, judge fit, recommend, or describe demographics", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/Never rank, score, compare, or judge comps/);
    expect(AGENT_INSTRUCTIONS).toMatch(/Never recommend, suggest, or invent comps/);
    expect(AGENT_INSTRUCTIONS).toMatch(/Never describe demographics or personas/);
  });

  it("shows the model only slot ids, kinds, wording, and a confirmed flag", () => {
    const payload = JSON.parse(agentInput("compare them", STATE)) as {
      slots: Record<string, unknown>[];
    };
    expect(Object.keys(payload.slots[0]!).sort()).toEqual(["confirmed", "kind", "query", "slot_id"]);
    const text = agentInput("compare them", STATE);
    expect(text).not.toContain("11111111-1111");
    expect(text).not.toContain("B0000000");
    expect(text).not.toContain("affinity");
  });
});

describe("applyPlan", () => {
  it("adds comps and audiences as unsearched, unconfirmed slots", () => {
    const result = applyPlan({ slots: [] }, {
      actions: [
        { op: "add", kind: "movie", slot_id: null, query: "Moon" },
        { op: "add", kind: "movie", slot_id: null, query: " Arrival  " },
        { op: "add", kind: "audience", slot_id: null, query: "Radiohead" },
      ],
      clarification: null, deferred_action: null, decision: null,
    });
    expect(result.state.slots).toEqual([
      { slot_id: "s1", kind: "movie", query: "Moon", search_capture_id: null, confirmed_entity_id: null },
      { slot_id: "s2", kind: "movie", query: "Arrival", search_capture_id: null, confirmed_entity_id: null },
      { slot_id: "s3", kind: "audience", query: "Radiohead", search_capture_id: null, confirmed_entity_id: null },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("replaces Kendrick with Metallica in a fresh slot, dropping the old confirmation", () => {
    const confirmed: AuditionState = {
      slots: STATE.slots.map((slot) =>
        slot.slot_id === "s3"
          ? { ...slot, search_capture_id: "22222222-2222-4222-8222-222222222222", confirmed_entity_id: "A0000000-0000-4000-8000-0000000000A1" }
          : slot,
      ),
    };
    const result = applyPlan(confirmed, {
      actions: [{ op: "replace", kind: null, slot_id: "s3", query: "Metallica" }],
      clarification: null, deferred_action: null, decision: null,
    });
    const audiences = result.state.slots.filter((slot) => slot.kind === "audience");
    expect(audiences.map((slot) => slot.query)).toEqual(["Radiohead", "Metallica"]);
    const metallica = audiences[1]!;
    expect(metallica.slot_id).not.toBe("s3");
    expect(metallica.search_capture_id).toBeNull();
    expect(metallica.confirmed_entity_id).toBeNull();
    // The untouched movie keeps its confirmation.
    expect(result.state.slots[0]?.confirmed_entity_id).toBe("B0000000-0000-4000-8000-0000000000B1");
  });

  it("removes a slot by id", () => {
    const result = applyPlan(STATE, { actions: [{ op: "remove", kind: null, slot_id: "s1", query: null }], clarification: null, deferred_action: null, decision: null });
    expect(result.state.slots.map((slot) => slot.slot_id)).toEqual(["s2", "s3"]);
  });

  it("skips edits that name unknown slots, lack wording, duplicate, or exceed caps", () => {
    const result = applyPlan(STATE, {
      actions: [
        { op: "remove", kind: null, slot_id: "s9", query: null },
        { op: "replace", kind: null, slot_id: "x';drop", query: "Arrival" },
        { op: "add", kind: "movie", slot_id: null, query: null },
        { op: "add", kind: null, slot_id: null, query: "Halo" },
        { op: "add", kind: "movie", slot_id: null, query: "moon" },
        { op: "add", kind: "audience", slot_id: null, query: "Metallica" },
      ],
      clarification: null, deferred_action: null, decision: null,
    });
    expect(result.state).toEqual(STATE);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(6);
  });

  it("caps comps per domain and the number of edits per message", () => {
    const actions = Array.from({ length: MAX_AGENT_ACTIONS + 3 }, (_, i) => ({
      op: "add" as const,
      kind: "videogame" as const,
      slot_id: null,
      query: `Game ${i}`,
    }));
    const result = applyPlan({ slots: [] }, { actions, clarification: null, deferred_action: null, decision: null });
    expect(result.state.slots).toHaveLength(4);
    expect(result.skipped.at(-1)).toMatch(/Only the first/);
  });
});


describe("deterministic media clarification", () => {
  const pending = (op: "add" | "replace" = "add"): AuditionState => ({
    ...STATE,
    pending_clarification: {
      action: { op, slot_id: op === "add" ? null : "s1", query: "Alien" },
      ambiguity: "media_type", choices: ["movie", "videogame"],
      question: "Do you mean the film or the game?", slot_context: clarificationSlotContext(STATE.slots),
    },
  });
  it("normalizes only the supported media answers and preserves unrelated slots", () => {
    for (const [answer, kind] of [
      ["film", "movie"], ["movie", "movie"], ["the film", "movie"], ["The movie.", "movie"],
      ["game", "videogame"], ["videogame", "videogame"], ["video game", "videogame"], ["the game", "videogame"],
    ]) {
      const result = resolveClarification(answer!, pending());
      expect(result.applied).toEqual([{ op: "add", slot_id: "s4", kind, query: "Alien" }]);
      expect(result.state.slots.slice(0, 3)).toEqual(STATE.slots);
      expect(result.state.pending_clarification).toBeUndefined();
    }
    const state = pending();
    expect(resolveClarification("remove Moon and add Arrival", state)).toEqual({ state, applied: [], skipped: [], decision: null, clarification: state.pending_clarification!.question });
  });
  it("replaces only the stored original target", () => {
    const result = resolveClarification("the game", pending("replace"));
    expect(result.applied).toEqual([{ op: "replace", slot_id: "s4", kind: "videogame", query: "Alien" }]);
    expect(result.state.slots.slice(1)).toEqual(STATE.slots.slice(1));
    expect(result.state.pending_clarification).toBeUndefined();
  });
});

describe("bounded decision questions", () => {
  const ask = (domain: "movie" | "videogame" | null, audience_query: string | null) =>
    ({ actions: [], clarification: null, deferred_action: null, decision: { action: "foreground_comp" as const, domain, audience_query } });

  it("can record only a question: a winner, rank, affinity, or comp cannot ride in it", () => {
    const decision = { action: "foreground_comp", domain: "movie", audience_query: "Radiohead" };
    const base = { actions: [], clarification: null, deferred_action: null };
    expect(AgentPlanSchema.safeParse({ ...base, decision }).success).toBe(true);
    for (const extra of [{ winner: "Moon" }, { entity_id: "B0000000-0000-4000-8000-0000000000B1" }, { rank: 1 }, { affinity: 0.8 }, { lead: "Moon" }]) {
      expect(AgentPlanSchema.safeParse({ ...base, decision: { ...decision, ...extra } }).success).toBe(false);
    }
    expect(AgentPlanSchema.safeParse({ ...base, decision: { ...decision, action: "pick_best" } }).success).toBe(false);
    expect(AGENT_INSTRUCTIONS).toMatch(/You only record the question\. Never answer it/);
  });

  it("resolves the audience wording to a slot, including one added in the same plan", () => {
    const result = applyPlan(STATE, ask("movie", "radiohead"));
    expect(result.decision).toEqual({ action: "foreground_comp", domain: "movie", audience_slot_id: "s2" });
    expect(result.state.decision_request).toEqual(result.decision);
    const fresh = applyPlan({ slots: [] }, { ...ask("videogame", "Metallica"), actions: [{ op: "add", kind: "audience", slot_id: null, query: "Metallica" }] });
    expect(fresh.state.decision_request).toEqual({ action: "foreground_comp", domain: "videogame", audience_slot_id: "s1" });
  });

  it("records nothing when the domain or audience is unstated or unknown", () => {
    for (const plan of [ask(null, "Radiohead"), ask("movie", null), ask("movie", "Metallica")]) {
      const result = applyPlan(STATE, plan);
      expect(result.decision).toBeNull();
      expect(result.state.decision_request).toBeUndefined();
      expect(result.skipped).toHaveLength(1);
    }
  });

  it("keeps the question through later edits and clarification, and drops it with its audience", () => {
    const asked = applyPlan(STATE, ask("movie", "Radiohead")).state;
    const later = applyPlan(asked, { actions: [{ op: "add", kind: "movie", slot_id: null, query: "Arrival" }], clarification: null, deferred_action: null, decision: null });
    expect(later.state.decision_request).toEqual(asked.decision_request);
    expect(later.decision).toBeNull();
    const pending = applyPlan(asked, { actions: [], clarification: "Film or game?", deferred_action: { op: "add", slot_id: null, query: "Alien" }, decision: null }).state;
    expect(pending.pending_clarification).toBeDefined();
    const resolved = resolveClarification("the film", pending);
    expect(resolved.state.decision_request).toEqual(asked.decision_request);
    expect(resolved.state.pending_clarification).toBeUndefined();
    const replaced = applyPlan(asked, { actions: [{ op: "replace", kind: null, slot_id: "s2", query: "Metallica" }], clarification: null, deferred_action: null, decision: null });
    expect(replaced.state.decision_request).toBeUndefined();
  });
});
