import { describe, expect, it } from "vitest";
import type { AuditionState } from "../../src/domain/audition";
import {
  AGENT_INSTRUCTIONS,
  agentInput,
  AgentPlanSchema,
  applyPlan,
  MAX_AGENT_ACTIONS,
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
    for (const extra of [{ affinity: 0.9 }, { rank: 1 }, { score: "high" }]) {
      expect(AgentPlanSchema.safeParse({ actions: [{ ...base, ...extra }], clarification: null }).success).toBe(false);
    }
    expect(AgentPlanSchema.safeParse({ actions: [base], clarification: null, winner: "Arrival" }).success).toBe(false);
    expect(AgentPlanSchema.safeParse({ actions: [base], clarification: null }).success).toBe(true);
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
      clarification: null,
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
      clarification: null,
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
    const result = applyPlan(STATE, { actions: [{ op: "remove", kind: null, slot_id: "s1", query: null }], clarification: null });
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
      clarification: null,
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
    const result = applyPlan({ slots: [] }, { actions, clarification: null });
    expect(result.state.slots).toHaveLength(4);
    expect(result.skipped.at(-1)).toMatch(/Only the first/);
  });
});
