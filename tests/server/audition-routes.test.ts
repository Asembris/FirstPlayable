import { describe, expect, it } from "vitest";
import { QLOO_FIXTURES } from "../../fixtures/qloo";
import {
  ARRIVAL_ID,
  AUDITION_FIXTURES,
  DEATH_STRANDING_ID,
  insights,
  KENDRICK_ENTITY_ID,
  METALLICA_ENTITY_ID,
  MOON_ID,
  MOON_SEQUEL_ID,
  O_BROTHER_ID,
  OUTER_WILDS_ID,
  LANTERNFOLD_ENTITY_ID,
} from "../../fixtures/qloo/audition";
import { clarificationSlotContext, type AuditionState, type InterpretResponse } from "../../src/domain/audition";
import type { ScoreResponse } from "../../src/domain/audition-view";
import { handleInterpret, handleScore } from "../../src/server/api/audition";
import { CREATOR_COMMAND_BODY_LIMIT_BYTES } from "../../src/server/security/request";
import {
  body,
  envelope,
  harness,
  type Harness,
  jsonResponse,
  type ModelScript,
  mutation,
  owner,
  type Transport,
} from "./support/phase3-harness";

/**
 * Synthetic affinities, per audience and domain. The insights stand-in returns
 * exactly the requested ids that appear here, as the candidate filter should.
 */
const AFFINITY: Record<string, Record<string, number | null>> = {
  [LANTERNFOLD_ENTITY_ID]: { [MOON_ID]: 0.81, [ARRIVAL_ID]: 0.62, [O_BROTHER_ID]: 0.6, [OUTER_WILDS_ID]: 0.7, [DEATH_STRANDING_ID]: 0.69 },
  [KENDRICK_ENTITY_ID]: { [MOON_ID]: 0.31, [ARRIVAL_ID]: 0.55, [O_BROTHER_ID]: 0.54, [OUTER_WILDS_ID]: 0.4, [DEATH_STRANDING_ID]: 0.6 },
  [METALLICA_ENTITY_ID]: { [MOON_ID]: 0.5, [ARRIVAL_ID]: 0.49 },
};

const NAMES: Record<string, string> = {
  [MOON_ID]: "Moon",
  [ARRIVAL_ID]: "Arrival",
  [O_BROTHER_ID]: "O Brother, Where Art Thou?",
  [OUTER_WILDS_ID]: "Outer Wilds",
  [DEATH_STRANDING_ID]: "Death Stranding",
};

type Overrides = { insights?: (url: URL) => Response };

function auditionTransport(overrides: Overrides = {}): Transport {
  const calls: Transport["calls"] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: {} });
    if (url.pathname === "/search") {
      const query = url.searchParams.get("query")?.toLowerCase() ?? "";
      const type = url.searchParams.get("types");
      const table: Record<string, unknown> = {
        "urn:entity:artist|lanternfold": QLOO_FIXTURES.searchLanternfold,
        "urn:entity:artist|kendrick lamar": AUDITION_FIXTURES.searchKendrick,
        "urn:entity:artist|metallica": AUDITION_FIXTURES.searchMetallica,
        "urn:entity:movie|dune": { results: [] },
        "urn:entity:movie|alien": { results: [] },
        "urn:entity:videogame|alien": { results: [] },
        "urn:entity:movie|moon": AUDITION_FIXTURES.searchMoon,
        "urn:entity:movie|arrival": AUDITION_FIXTURES.searchArrival,
        "urn:entity:movie|o brother, where art thou?": AUDITION_FIXTURES.searchOBrother,
        "urn:entity:videogame|outer wilds": AUDITION_FIXTURES.searchOuterWilds,
        "urn:entity:videogame|death stranding": AUDITION_FIXTURES.searchDeathStranding,
      };
      const payload = table[`${type}|${query}`];
      if (payload === undefined) throw new Error(`unrouted search ${type}|${query}`);
      return jsonResponse(payload);
    }
    if (url.pathname === "/v2/insights") {
      if (overrides.insights !== undefined) return overrides.insights(url);
      const audience = url.searchParams.get("signal.interests.entities")!;
      const type = url.searchParams.get("filter.type") as "urn:entity:movie" | "urn:entity:videogame";
      const ids = url.searchParams.get("filter.results.entities")!.split(",");
      const rows = ids
        .filter((id) => id in (AFFINITY[audience] ?? {}))
        .map((id) => [id, NAMES[id]!, AFFINITY[audience]![id]!] as [string, string, number | null]);
      return jsonResponse(insights(type, rows));
    }
    throw new Error(`unroutable ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function plan(actions: unknown[], clarification: string | null = null, deferred_action: unknown = null): ModelScript {
  return { parsed: { actions, clarification, deferred_action } };
}

const ADD = (kind: string, query: string) => ({ op: "add", kind, slot_id: null, query });

const OPENING = plan([
  ADD("movie", "Moon"),
  ADD("movie", "Arrival"),
  ADD("movie", "O Brother, Where Art Thou?"),
  ADD("audience", "Lanternfold"),
  ADD("audience", "Kendrick Lamar"),
]);

function setup(model: ModelScript[] = [OPENING], overrides: Overrides = {}): Harness {
  return harness({ transport: auditionTransport(overrides), model });
}

async function interpret(h: Harness, cookie: string, message: string, state: AuditionState) {
  return handleInterpret(
    mutation("/api/audition/interpret", { cookie, body: JSON.stringify({ message, state }) }),
    h.deps,
  );
}

async function score(h: Harness, cookie: string, state: AuditionState) {
  return handleScore(mutation("/api/audition/score", { cookie, body: JSON.stringify({ state }) }), h.deps);
}

/** Confirms the first returned result of every searched slot, as a creator clicking would. */
function confirmFirst(response: InterpretResponse): AuditionState {
  const first = new Map(response.searches.map((s) => [s.slot_id, s.candidates[0]?.entity_id ?? null]));
  return {
    slots: response.state.slots.map((slot) => ({
      ...slot,
      confirmed_entity_id: slot.confirmed_entity_id ?? first.get(slot.slot_id) ?? null,
    })),
  };
}

async function opened(h: Harness) {
  const cookie = await owner(h);
  const response = await interpret(h, cookie, "Compare Moon, Arrival and O Brother for Lanternfold and Kendrick Lamar fans.", { slots: [] });
  expect(response.status).toBe(200);
  return { cookie, interpreted: await body<InterpretResponse>(response) };
}

describe("POST /api/audition/interpret", () => {
  it("keeps Dune while resolving the pending Alien request, then clears it", async () => {
    const message = "Add Alien, but ask me whether I mean the film or the game before searching.";
    const question = "Do you mean the film or the game?";
    const h = setup([plan([ADD("movie", "Dune")]), plan([], question, { op: "add", slot_id: null, query: "Alien" }), plan([ADD("movie", "Arrival")])]);
    const cookie = await owner(h);
    const initial = await body<InterpretResponse>(await interpret(h, cookie, "Add the film Dune", { slots: [] }));
    const dune = initial.state.slots[0]!;
    expect(dune.confirmed_entity_id).toBeNull();
    const before = h.transport.calls.length;
    const asked = await body<InterpretResponse>(await interpret(h, cookie, message, initial.state));
    expect(asked.applied).toEqual([]);
    expect(asked.state.slots).toEqual([dune]);
    expect(asked.state.pending_clarification).toMatchObject({ action: { op: "add", slot_id: null, query: "Alien" }, ambiguity: "media_type", choices: ["movie", "videogame"], question });
    expect(asked.model_calls).toBe(1);
    expect(h.transport.calls).toHaveLength(before);

    // JSON round trip is the browser's state handoff between independent calls.
    const returnedState = JSON.parse(JSON.stringify(asked.state)) as AuditionState;
    const resolved = await body<InterpretResponse>(await interpret(h, cookie, "The film", returnedState));
    const input = JSON.parse(String(h.model!.requests[1]!["input"]));
    expect(input.message).toBe(message);
    expect(Object.keys(input)).toEqual(["message", "slots"]);
    expect(h.model!.requests).toHaveLength(2);
    expect(resolved.model_calls).toBe(0);
    expect(Object.keys(input.slots[0]).sort()).toEqual(["confirmed", "kind", "query", "slot_id"]);
    expect(JSON.stringify(input)).not.toMatch(/affinity|score|rank|capture_id|entity_id/);
    expect(resolved.applied).toEqual([{ op: "add", slot_id: "s2", kind: "movie", query: "Alien" }]);
    expect(resolved.state.slots[0]).toEqual(dune);
    expect(resolved.state.slots.map(({ kind, query }) => [kind, query])).toEqual([["movie", "Dune"], ["movie", "Alien"]]);
    expect(resolved.state.pending_clarification).toBeUndefined();
    expect(resolved.clarification).toBeNull();
    const searches = h.transport.calls.slice(before).map(({ url }) => new URL(url));
    expect(searches).toHaveLength(1);
    expect(searches[0]!.pathname).toBe("/search");
    expect(searches[0]!.searchParams.get("query")).toBe("Alien");
    expect(searches[0]!.searchParams.get("types")).toBe("urn:entity:movie");

    const later = await body<InterpretResponse>(await interpret(h, cookie, "Add the movie Arrival", resolved.state));
    expect(JSON.parse(String(h.model!.requests[2]!["input"])).pending_clarification).toBeUndefined();
    expect(later.model_calls).toBe(1);
    expect(h.model!.requests).toHaveLength(3);
    expect(later.applied).toEqual([{ op: "add", slot_id: "s3", kind: "movie", query: "Arrival" }]);
    expect(later.state.slots.slice(0, 2)).toEqual(resolved.state.slots);
  });

  it("keeps unrelated free text pending and resolves the game without any model call", async () => {
    const h = setup([]); // Any accidental model call fails: no scripted responses exist.
    const cookie = await owner(h);
    const slots: AuditionState["slots"] = [{ slot_id: "s1", kind: "movie", query: "Dune", search_capture_id: null, confirmed_entity_id: null }];
    const state: AuditionState = { slots, pending_clarification: {
      action: { op: "add", slot_id: null, query: "Alien" }, ambiguity: "media_type", choices: ["movie", "videogame"],
      question: "Do you mean the film or the game?", slot_context: clarificationSlotContext(slots),
    } };
    const held = await body<InterpretResponse>(await interpret(h, cookie, "Remove Dune and add Arrival", state));
    expect(held.state).toEqual(state);
    expect(held.applied).toEqual([]);
    expect(held.clarification).toBe(state.pending_clarification!.question);
    expect(held.model_calls).toBe(0);
    expect(held.upstream_calls).toBe(0);
    const resolved = await body<InterpretResponse>(await interpret(h, cookie, "the game", held.state));
    expect(resolved.state.slots[0]).toEqual(slots[0]); // Even unsearched Dune is untouched.
    expect(resolved.applied).toEqual([{ op: "add", slot_id: "s2", kind: "videogame", query: "Alien" }]);
    expect(resolved.state.pending_clarification).toBeUndefined();
    expect(resolved.model_calls).toBe(0);
    expect(h.model!.requests).toHaveLength(0);
    expect(h.transport.calls).toHaveLength(1);
    expect(new URL(h.transport.calls[0]!.url).searchParams.get("types")).toBe("urn:entity:videogame");
  });

  it("rejects malformed or stale clarification before any model or Qloo call", async () => {
    const h = setup([]);
    const cookie = await owner(h);
    for (const pending_clarification of [
      { question: "Film or game?" },
      { action: { op: "add", slot_id: null, query: "Alien" }, ambiguity: "media_type", choices: ["movie", "videogame"], question: "Film or game?", slot_context: "stale" },
      { action: { op: "replace", slot_id: "s1", query: "Alien" }, ambiguity: "media_type", choices: ["movie", "videogame"], question: "Film or game?", slot_context: "[]" },
      { action: { op: "add", slot_id: "s1", query: "Alien" }, ambiguity: "media_type", choices: ["movie", "videogame"], question: "Film or game?", slot_context: "[]" },
      { action: { op: "add", slot_id: null, query: "Alien", score: 0.9 }, ambiguity: "media_type", choices: ["movie", "videogame"], question: "Film or game?", slot_context: "[]" },
    ]) {
      const response = await interpret(h, cookie, "The film", { slots: [], pending_clarification } as AuditionState);
      expect(response.status).toBe(422);
    }
    expect(h.model!.requests).toHaveLength(0);
    expect(h.transport.calls).toHaveLength(0);
  });
  it("turns a sentence into searched slots, and confirms nothing", async () => {
    const h = setup();
    const { interpreted } = await opened(h);

    expect(interpreted.state.slots.map((s) => [s.kind, s.query])).toEqual([
      ["movie", "Moon"],
      ["movie", "Arrival"],
      ["movie", "O Brother, Where Art Thou?"],
      ["audience", "Lanternfold"],
      ["audience", "Kendrick Lamar"],
    ]);
    expect(interpreted.state.slots.every((s) => s.search_capture_id !== null)).toBe(true);
    expect(interpreted.state.slots.every((s) => s.confirmed_entity_id === null)).toBe(true);
    // Candidates come from Qloo, in returned order: "Moon" offers two films.
    expect(interpreted.searches[0]?.candidates.map((c) => c.name)).toEqual(["Moon", "Moonrise Kingdom"]);
    expect(interpreted.model_calls).toBe(1);
    expect(interpreted.upstream_calls).toBe(5);
    // Five searches, no insights call: nothing is scored before confirmation.
    expect(h.transport.calls.every((c) => new URL(c.url).pathname === "/search")).toBe(true);
  });

  it("never shows the model a score, even after scoring has happened", async () => {
    const h = setup([OPENING, plan([{ op: "replace", kind: null, slot_id: "s5", query: "Metallica" }])]);
    const { cookie, interpreted } = await opened(h);
    const confirmed = confirmFirst(interpreted);
    expect((await score(h, cookie, confirmed)).status).toBe(200);

    const follow = await interpret(h, cookie, "replace Kendrick with Metallica", confirmed);
    expect(follow.status).toBe(200);
    // The data the model receives, and the whole request for the values.
    const sent = String(h.model!.requests[1]?.["input"]);
    expect(sent).not.toContain("affinity");
    expect(JSON.stringify(h.model!.requests[1])).not.toMatch(/0\.81|0\.31|0\.62/);
    expect(sent).not.toContain(MOON_ID);
  });

  it("follows up: replaces Kendrick with Metallica and searches only the new slot", async () => {
    const h = setup([OPENING, plan([{ op: "replace", kind: null, slot_id: "s5", query: "Metallica" }])]);
    const { cookie, interpreted } = await opened(h);
    const confirmed = confirmFirst(interpreted);
    const before = h.transport.calls.length;

    const response = await interpret(h, cookie, "replace Kendrick with Metallica", confirmed);
    const result = await body<InterpretResponse>(response);
    const audiences = result.state.slots.filter((s) => s.kind === "audience");
    expect(audiences.map((s) => s.query)).toEqual(["Lanternfold", "Metallica"]);
    expect(audiences[0]?.confirmed_entity_id).toBe(LANTERNFOLD_ENTITY_ID);
    expect(audiences[1]?.confirmed_entity_id).toBeNull();
    expect(h.transport.calls.length - before).toBe(1);
    expect(result.searches.map((s) => s.slot_id)).toEqual([audiences[1]!.slot_id]);
  });

  it("passes a clarifying question through and adds nothing it was unsure of", async () => {
    const h = setup([plan([], "Do you mean the Halo film or the Halo game?", { op: "add", slot_id: null, query: "Halo" })]);
    const cookie = await owner(h);
    const result = await body<InterpretResponse>(await interpret(h, cookie, "add Halo", { slots: [] }));
    expect(result.clarification).toMatch(/Halo/);
    expect(result.state.slots).toEqual([]);
    expect(h.transport.calls).toHaveLength(0);
  });

  it("answers a repeated search from the capture with zero upstream calls", async () => {
    const h = setup([OPENING, OPENING]);
    const cookie = await owner(h);
    await interpret(h, cookie, "first", { slots: [] });
    const calls = h.transport.calls.length;
    const again = await body<InterpretResponse>(await interpret(h, cookie, "again", { slots: [] }));
    expect(h.transport.calls.length).toBe(calls);
    expect(again.upstream_calls).toBe(0);
    expect(again.searches.every((s) => s.cache === "cached")).toBe(true);
  });

  it("rejects a model output that carries a score, and changes nothing", async () => {
    const h = setup([{ parsed: { actions: [{ ...ADD("movie", "Moon"), affinity: 0.99 }], clarification: null, deferred_action: null } }]);
    const cookie = await owner(h);
    const response = await interpret(h, cookie, "Moon is the best", { slots: [] });
    expect(response.status).toBe(429);
    expect((await envelope(response)).message).toMatch(/unchanged/);
    expect(h.transport.calls).toHaveLength(0);
  });

  it("reports a failed Qloo search for one slot and keeps the others", async () => {
    const h = harness({
      transport: (() => {
        const base = auditionTransport();
        return {
          calls: base.calls,
          fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
            String(input).includes("Arrival") ? new Response("{}", { status: 401 }) : base.fetchImpl(input, init)) as typeof fetch,
        };
      })(),
      model: [plan([ADD("movie", "Moon"), ADD("movie", "Arrival")])],
    });
    const cookie = await owner(h);
    const result = await body<InterpretResponse>(await interpret(h, cookie, "Moon and Arrival", { slots: [] }));
    expect(result.state.slots.map((s) => s.search_capture_id !== null)).toEqual([true, false]);
    expect(result.skipped.join(" ")).toMatch(/Arrival.*QLOO_UNAUTHORIZED/);
  });
});

describe("POST /api/audition/score", () => {
  it("scores confirmed comps per audience and per domain, and finds the reversal", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const response = await score(h, cookie, confirmFirst(interpreted));
    expect(response.status).toBe(200);
    const result = await body<ScoreResponse>(response);

    expect(result.audiences.map((a) => a.name)).toEqual(["Lanternfold", "Kendrick Lamar"]);
    expect(result.domains.videogame).toBeNull();
    const movie = result.domains.movie!;
    const [lanternfold, kendrick] = movie.comparison.rankings;
    expect(lanternfold.ordered.map((r) => r.name)).toEqual(["Moon", "Arrival", "O Brother, Where Art Thou?"]);
    expect(kendrick.ordered.map((r) => r.name)).toEqual(["Arrival", "O Brother, Where Art Thou?", "Moon"]);
    expect(lanternfold.top).toEqual({ status: "clear", leaders: [MOON_ID] });
    // Arrival and O Brother sit within 0.03 for Kendrick Lamar: close, not a winner.
    expect(kendrick.top.status).toBe("close");

    const verdicts = Object.fromEntries(movie.comparison.pairs.map((p) => [`${NAMES[p.a]}|${NAMES[p.b]}`, p.verdict]));
    expect(verdicts).toEqual({
      "Moon|Arrival": "reversal",
      "Moon|O Brother, Where Art Thou?": "reversal",
      "Arrival|O Brother, Where Art Thou?": "close",
    });

    // Two insights calls: one per audience, movies only, exactly the confirmed ids.
    const scored = h.transport.calls.map((c) => new URL(c.url)).filter((u) => u.pathname === "/v2/insights");
    expect(scored).toHaveLength(2);
    for (const url of scored) {
      expect(url.searchParams.get("filter.type")).toBe("urn:entity:movie");
      expect(url.searchParams.get("filter.results.entities")?.split(",").sort()).toEqual([MOON_ID, ARRIVAL_ID, O_BROTHER_ID].sort());
    }
    expect(movie.evidence.map((e) => e.request)).toEqual([
      expect.stringContaining(`signal.interests.entities=${LANTERNFOLD_ENTITY_ID}`),
      expect.stringContaining(`signal.interests.entities=${KENDRICK_ENTITY_ID}`),
    ]);
    expect(JSON.stringify(result)).not.toContain("qloo.invalid");
  });

  it("keeps movies and videogames in separate requests and separate comparisons", async () => {
    const h = setup([
      plan([
        ADD("movie", "Moon"),
        ADD("movie", "Arrival"),
        ADD("videogame", "Outer Wilds"),
        ADD("videogame", "Death Stranding"),
        ADD("audience", "Lanternfold"),
        ADD("audience", "Kendrick Lamar"),
      ]),
    ]);
    const { cookie, interpreted } = await opened(h);
    const result = await body<ScoreResponse>(await score(h, cookie, confirmFirst(interpreted)));
    const scored = h.transport.calls.map((c) => new URL(c.url)).filter((u) => u.pathname === "/v2/insights");
    expect(scored).toHaveLength(4);
    for (const url of scored) {
      const ids = url.searchParams.get("filter.results.entities")!.split(",");
      const type = url.searchParams.get("filter.type");
      expect(ids.every((id) => (type === "urn:entity:movie" ? [MOON_ID, ARRIVAL_ID] : [OUTER_WILDS_ID, DEATH_STRANDING_ID]).includes(id))).toBe(true);
    }
    expect(result.domains.movie?.comparison.comps.every((c) => c.domain === "movie")).toBe(true);
    expect(result.domains.videogame?.comparison.comps.every((c) => c.domain === "videogame")).toBe(true);
    // Outer Wilds 0.70 vs Death Stranding 0.69 for Lanternfold is close; no reversal claimed.
    expect(result.domains.videogame?.comparison.pairs[0]?.verdict).toBe("close");
  });

  it("scores only confirmed comps and lists the rest as unconfirmed", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    state.slots[2] = { ...state.slots[2]!, confirmed_entity_id: null };
    const result = await body<ScoreResponse>(await score(h, cookie, state));
    expect(result.domains.movie?.comps.map((c) => c.name)).toEqual(["Moon", "Arrival"]);
    expect(result.unconfirmed.map((u) => u.query)).toEqual(["O Brother, Where Art Thou?"]);
  });

  it("uses the creator's confirmed choice, not Qloo's first result", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    state.slots[0] = { ...state.slots[0]!, confirmed_entity_id: MOON_SEQUEL_ID };
    const result = await body<ScoreResponse>(await score(h, cookie, state));
    expect(result.domains.movie?.comps[0]).toMatchObject({ name: "Moonrise Kingdom", original_rank: 2 });
    // Qloo returned no score for it here, so it is unscored, never ranked.
    expect(result.domains.movie?.comparison.rankings[0].unscored.map((u) => u.name)).toEqual(["Moonrise Kingdom"]);
  });

  it("takes every displayed name from the capture, never from the request", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    state.slots[0] = { ...state.slots[0]!, query: "The Best Film Ever Made" };
    const text = JSON.stringify(await body<ScoreResponse>(await score(h, cookie, state)));
    expect(text).toContain('"name":"Moon"');
    expect(text).not.toMatch(/"name":"The Best Film/);
  });

  it("refuses a forged entity id that is not in the named search capture", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    state.slots[0] = { ...state.slots[0]!, confirmed_entity_id: OUTER_WILDS_ID };
    const response = await score(h, cookie, state);
    expect(response.status).toBe(422);
    expect((await envelope(response)).code).toBe("REQUEST_REFUSED");
    expect(h.transport.calls.some((c) => c.url.includes("/v2/insights"))).toBe(false);
  });

  it("refuses a capture id that does not exist, or belongs to another slot kind", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    const audienceCapture = state.slots[3]!.search_capture_id;
    const forged = structuredClone(state);
    forged.slots[0] = { ...forged.slots[0]!, search_capture_id: "99999999-9999-4999-8999-999999999999" };
    expect((await score(h, cookie, forged)).status).toBe(422);
    // An artist search capture cannot stand in for a movie search.
    const crossed = structuredClone(state);
    crossed.slots[0] = { ...crossed.slots[0]!, search_capture_id: audienceCapture, confirmed_entity_id: LANTERNFOLD_ENTITY_ID };
    expect((await score(h, cookie, crossed)).status).toBe(422);
    // A movie search capture cannot stand in for a videogame comp.
    const wrongDomain = structuredClone(state);
    wrongDomain.slots[0] = { ...wrongDomain.slots[0]!, kind: "videogame" };
    expect((await score(h, cookie, wrongDomain)).status).toBe(422);
  });

  it("refuses scoring without two different confirmed audiences or any confirmed comp", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    const oneAudience = structuredClone(state);
    oneAudience.slots[4] = { ...oneAudience.slots[4]!, confirmed_entity_id: null };
    expect((await envelope(await score(h, cookie, oneAudience))).message).toMatch(/two audiences/);
    const noComps = { slots: state.slots.filter((s) => s.kind === "audience") };
    expect((await envelope(await score(h, cookie, noComps))).message).toMatch(/at least one comp/);
  });

  it("refuses the whole score when Qloo returns an entity that was not requested", async () => {
    const h = setup([OPENING], {
      insights: () => jsonResponse(insights("urn:entity:movie", [[OUTER_WILDS_ID, "Outer Wilds", 0.99]])),
    });
    const { cookie, interpreted } = await opened(h);
    const response = await score(h, cookie, confirmFirst(interpreted));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await envelope(response))).not.toContain("Outer Wilds");
  });

  it("maps a Qloo rate limit to a retryable refusal and records no comparison", async () => {
    const h = setup([OPENING], { insights: () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }) });
    const { cookie, interpreted } = await opened(h);
    const response = await score(h, cookie, confirmFirst(interpreted));
    expect(response.status).toBe(429);
    expect((await envelope(response)).retryable).toBe(true);
  });

  it("answers a repeated score from captures with zero upstream calls", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    await score(h, cookie, state);
    const calls = h.transport.calls.length;
    const again = await body<ScoreResponse>(await score(h, cookie, state));
    expect(h.transport.calls.length).toBe(calls);
    expect(again.upstream_calls).toBe(0);
    expect(again.domains.movie?.evidence.every((e) => e.cache === "cached")).toBe(true);
  });
});

describe("route security and validation", () => {
  const routes = [
    ["interpret", (h: Harness, request: Request) => handleInterpret(request, h.deps), "/api/audition/interpret", { message: "hi", state: { slots: [] } }],
    ["score", (h: Harness, request: Request) => handleScore(request, h.deps), "/api/audition/score", { state: { slots: [] } }],
  ] as const;

  for (const [name, handle, path, valid] of routes) {
    describe(name, () => {
      it("requires the same origin", async () => {
        const h = setup();
        const cookie = await owner(h);
        const missing = await handle(h, mutation(path, { cookie, origin: null, body: JSON.stringify(valid) }));
        expect((await envelope(missing)).code).toBe("ORIGIN_REQUIRED");
        const foreign = await handle(h, mutation(path, { cookie, origin: "https://evil.example", body: JSON.stringify(valid) }));
        expect((await envelope(foreign)).code).toBe("ORIGIN_MISMATCH");
      });

      it("requires JSON and caps the body", async () => {
        const h = setup();
        const cookie = await owner(h);
        const text = await handle(h, mutation(path, { cookie, contentType: "text/plain", body: JSON.stringify(valid) }));
        expect((await envelope(text)).code).toBe("CONTENT_TYPE_UNSUPPORTED");
        const big = await handle(h, mutation(path, { cookie, body: "x".repeat(CREATOR_COMMAND_BODY_LIMIT_BYTES + 1) }));
        expect((await envelope(big)).code).toBe("BODY_TOO_LARGE");
      });

      it("requires an owner session", async () => {
        const h = setup();
        const response = await handle(h, mutation(path, { body: JSON.stringify(valid) }));
        expect((await envelope(response)).code).toBe("SESSION_REQUIRED");
        expect(h.model?.requests ?? []).toHaveLength(0);
        expect(h.transport.calls).toHaveLength(0);
      });

      it("rejects unknown fields and malformed state before any upstream call", async () => {
        const h = setup();
        const cookie = await owner(h);
        for (const bad of [
          { ...valid, affinity: { Moon: 0.9 } },
          { ...valid, state: { slots: [{ slot_id: "s1", kind: "book", query: "x", search_capture_id: null, confirmed_entity_id: null }] } },
          { ...valid, state: { slots: [{ slot_id: "s1", kind: "movie", query: "x", search_capture_id: null, confirmed_entity_id: MOON_ID }] } },
          { ...valid, state: { slots: [{ slot_id: "s1", kind: "movie", query: "x", search_capture_id: null, confirmed_entity_id: null, score: 1 }] } },
        ]) {
          const response = await handle(h, mutation(path, { cookie, body: JSON.stringify(bad) }));
          expect((await envelope(response)).code).toBe("VALIDATION_FAILED");
        }
        expect(h.model?.requests ?? []).toHaveLength(0);
        expect(h.transport.calls).toHaveLength(0);
      });
    });
  }

  it("refuses a model call when the spend cap is exhausted", async () => {
    const h = harness({ transport: auditionTransport(), model: [OPENING], budget: { modelCostCapMicros: 0 } });
    const cookie = await owner(h);
    const response = await interpret(h, cookie, "Moon for Lanternfold fans", { slots: [] });
    expect((await envelope(response)).code).toBe("BUDGET_EXHAUSTED");
    expect(h.model!.requests).toHaveLength(0);
  });
});


describe("audition capture refresh provenance", () => {
  it("refetches expired comp searches with new IDs, retaining old confirmations and fresh cache hits", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const ids = interpreted.state.slots.map((slot) => slot.search_capture_id!);
    const before = await h.gateway.findQlooCapturesByIds(ids);
    const calls = h.transport.calls.length;
    h.advance(24 * 60 * 60 * 1000 + 1000);
    const response = await interpret(h, cookie, "Compare the same references again", { slots: [] });
    expect(response.status).toBe(200);
    const fresh = await body<InterpretResponse>(response);
    expect(fresh.state.slots.every((slot) => !ids.includes(slot.search_capture_id!))).toBe(true);
    expect(fresh.upstream_calls).toBe(5);
    expect(await h.gateway.findQlooCapturesByIds(ids)).toEqual(before);
    const rows = await h.gateway.findQlooCapturesByIds(fresh.state.slots.map((slot) => slot.search_capture_id!));
    for (const row of rows) {
      expect(row.captured_at).toBe((row.results as { retrieved_at: string }).retrieved_at);
      expect(Date.parse(row.cache_expires_at)).toBeGreaterThan(h.now().getTime());
      expect((await h.gateway.findQlooCaptureByFingerprint(row.request_fingerprint))?.id).toBe(row.id);
    }
    const repeated = await body<InterpretResponse>(await interpret(h, cookie, "Compare again", { slots: [] }));
    expect(repeated.upstream_calls).toBe(0);
    expect(repeated.state.slots.map((slot) => slot.search_capture_id)).toEqual(fresh.state.slots.map((slot) => slot.search_capture_id));
    expect(h.transport.calls).toHaveLength(calls + 5);
    expect((await score(h, cookie, confirmFirst(interpreted))).status).toBe(200);
  });

  it("refetches expired scores into their own rows and reuses them without Qloo calls", async () => {
    const h = setup();
    const { cookie, interpreted } = await opened(h);
    const state = confirmFirst(interpreted);
    const first = await body<ScoreResponse>(await score(h, cookie, state));
    const ids = first.domains.movie!.evidence.map((e) => e.capture_id!);
    const before = await h.gateway.findQlooCapturesByIds(ids);
    h.advance(7 * 24 * 60 * 60 * 1000 + 1000);
    const response = await score(h, cookie, state);
    expect(response.status).toBe(200);
    const fresh = await body<ScoreResponse>(response);
    expect(fresh.upstream_calls).toBe(2);
    expect(fresh.domains.movie!.evidence.every((e) => !ids.includes(e.capture_id!))).toBe(true);
    expect(await h.gateway.findQlooCapturesByIds(ids)).toEqual(before);
    for (const evidence of fresh.domains.movie!.evidence) {
      const [row] = await h.gateway.findQlooCapturesByIds([evidence.capture_id!]);
      expect(row?.captured_at).toBe(evidence.retrieved_at);
      expect(Date.parse(row!.cache_expires_at)).toBeGreaterThan(h.now().getTime());
      expect((await h.gateway.findQlooCaptureByFingerprint(row!.request_fingerprint))?.id).toBe(row?.id);
    }
    const calls = h.transport.calls.length;
    const repeat = await body<ScoreResponse>(await score(h, cookie, state));
    expect(repeat.upstream_calls).toBe(0);
    expect(repeat.domains.movie!.evidence.map((e) => e.capture_id)).toEqual(fresh.domains.movie!.evidence.map((e) => e.capture_id));
    expect(h.transport.calls).toHaveLength(calls);
  });
});
