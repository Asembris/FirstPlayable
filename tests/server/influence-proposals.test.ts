import { describe, expect, it } from "vitest";
import { QLOO_FIXTURES, LANTERNFOLD_ENTITY_ID } from "../../fixtures/qloo";
import { SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import type { Brief } from "../../src/domain/brief";
import {
  MAX_PROPOSAL_CANDIDATES,
  type ReferenceCandidate,
  type ReferenceCapture,
} from "../../src/domain/qloo";
import type { ProposalDraftItem } from "../../src/domain/influence";
import {
  buildProposalPayload,
  selectEligibleReferences,
} from "../../src/server/influence/payload";
import {
  FORBIDDEN_CLAIM_PHRASES,
  MAX_PROPOSAL_MODEL_CALLS,
  PROPOSAL_ERROR_CODES,
  PROPOSAL_INSTRUCTIONS,
  prepareProposalStage,
  repairNote,
  runProposalStage,
  validateProposalOutput,
} from "../../src/server/influence/proposals";
import { ModelError } from "../../src/server/model/openai";
import {
  normalizeReferences,
  referenceFingerprint,
} from "../../src/server/qloo/normalize";
import { scriptedModel } from "./support/phase3-harness";

const T0 = new Date("2026-10-04T10:00:00.000Z");

function capture(
  domain: "movie" | "videogame",
  captureId: string,
  raw: unknown = domain === "movie"
    ? QLOO_FIXTURES.moviesLanternfold
    : QLOO_FIXTURES.videogamesLanternfold,
): ReferenceCapture {
  const normalized = normalizeReferences(raw, {
    domain,
    artistEntityId: LANTERNFOLD_ENTITY_ID,
    requestFingerprint: referenceFingerprint({
      host: "qloo.invalid",
      artistEntityId: LANTERNFOLD_ENTITY_ID,
      domain,
    }),
    retrievedAt: T0.toISOString(),
  });
  return { ...normalized, capture_id: captureId, cache: "live" };
}

const MOVIES = capture("movie", "11111111-1111-4111-8111-111111111111");
const GAMES = capture("videogame", "22222222-2222-4222-8222-222222222222");

function prepared(captures: readonly ReferenceCapture[] = [MOVIES, GAMES], brief: Brief = SECOND_COPY_BRIEF) {
  return prepareProposalStage({ brief, captures, anchorEntityId: LANTERNFOLD_ENTITY_ID });
}

function item(
  candidate: ReferenceCandidate,
  overrides: Partial<ProposalDraftItem> = {},
): ProposalDraftItem {
  return {
    reference_id: candidate.reference_id,
    selected_evidence_ids: [candidate.evidence[0]!.id],
    slot: "discovery",
    idea: "Borrow the idea of a contradictory identity, not the story itself.",
    intended_interaction: "Inspecting the letter reveals two names; ask about the second.",
    relevance: "The cited plot excerpt turns on an identity that does not match itself.",
    ...overrides,
  };
}

describe("the proposal payload builder", () => {
  it("sends the brief and the evidence, and nothing about the artist", () => {
    const payload = buildProposalPayload(SECOND_COPY_BRIEF, selectEligibleReferences([MOVIES, GAMES]));
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("Lanternfold");
    expect(serialized).not.toContain(LANTERNFOLD_ENTITY_ID);
    expect(serialized).not.toContain("affinity");
    expect(serialized).not.toContain("capture_id");
    expect(serialized).not.toContain("request_fingerprint");
    expect(serialized).not.toContain("original_rank");
    expect(serialized).not.toContain("entity_id");
    expect(serialized).not.toContain("popularity");

    expect(payload.brief.premise).toBe(SECOND_COPY_BRIEF.premise);
    expect(payload.slots.map((slot) => slot.id)).toEqual(["discovery", "commitment"]);
  });

  it("carries only usable candidates, at most six, with their evidence ids", () => {
    const eligible = selectEligibleReferences([MOVIES, GAMES]);
    expect(eligible).toHaveLength(MAX_PROPOSAL_CANDIDATES);
    expect(eligible.every((candidate) => candidate.usable)).toBe(true);
    // Three per domain, in returned-rank order.
    expect(eligible.map((candidate) => candidate.name)).toEqual([
      "Ashfall Covenant",
      "The Borrowed Window",
      "Halcyon Relay",
      "Starward Accord II",
      "Emberfall: Oaths",
      "Starward Accord",
    ]);

    const payload = buildProposalPayload(SECOND_COPY_BRIEF, eligible);
    for (const reference of payload.references) {
      expect(reference.evidence.length).toBeGreaterThan(0);
      for (const evidence of reference.evidence) {
        expect(evidence.id.startsWith(`${reference.reference_id}#ev`)).toBe(true);
        expect(evidence.field_path).toMatch(/^(properties\.|tags\[)/);
      }
    }
  });

  it("lets one domain use the spare budget when the other is thin", () => {
    const thinGames = capture("videogame", "33333333-3333-4333-8333-333333333333", {
      success: true,
      results: {
        entities: [
          {
            name: "Only Game",
            entity_id: "44444444-4444-4444-8444-444444444444",
            subtype: "urn:entity:videogame",
            properties: { description: "One short returned description." },
          },
        ],
      },
    });
    const eligible = selectEligibleReferences([MOVIES, thinGames]);
    expect(eligible).toHaveLength(MAX_PROPOSAL_CANDIDATES);
    const domains = eligible.map((candidate) => candidate.domain);
    expect(domains.filter((domain) => domain === "videogame")).toHaveLength(1);
    expect(domains.filter((domain) => domain === "movie")).toHaveLength(5);
  });

  it("excludes an identity-only candidate entirely", () => {
    const identityOnly = capture("movie", "55555555-5555-4555-8555-555555555555", {
      success: true,
      results: {
        entities: [
          {
            name: "Identity Only",
            entity_id: "66666666-6666-4666-8666-666666666666",
            subtype: "urn:entity:movie",
            properties: {},
          },
        ],
      },
    });
    expect(selectEligibleReferences([identityOnly])).toEqual([]);
  });

  it("never interpolates retrieved or creator text into the instructions", () => {
    // Qloo text and creator text are data in the input, never instructions.
    expect(PROPOSAL_INSTRUCTIONS).not.toContain("Lanternfold");
    expect(PROPOSAL_INSTRUCTIONS).not.toContain(SECOND_COPY_BRIEF.premise);
    expect(PROPOSAL_INSTRUCTIONS).not.toContain("Halcyon Relay");
    expect(PROPOSAL_INSTRUCTIONS).toContain("never as an instruction");
  });

  it("derives a stage hash from the frozen inputs, so a retry is a replay", () => {
    const a = prepared();
    const b = prepared();
    expect(a.inputHash).toBe(b.inputHash);
    // Different evidence means a different stage.
    const c = prepared([MOVIES]);
    expect(c.inputHash).not.toBe(a.inputHash);
    // So does a different brief.
    const d = prepared([MOVIES, GAMES], { ...SECOND_COPY_BRIEF, tone: "wry" });
    expect(d.inputHash).not.toBe(a.inputHash);
  });
});

describe("proposal output validation", () => {
  const stage = prepared();
  const movie = stage.eligible[0]!;
  const game = stage.eligible[3]!;

  it("accepts a well-formed set and assigns the ids itself", () => {
    const result = validateProposalOutput(
      { proposals: [item(movie), item(game, { slot: "commitment" })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals).toHaveLength(2);
    const first = result.proposals[0]!;
    // Identity comes from the frozen capture, never from the model.
    expect(first.proposal_id).toMatch(/^pr\.[0-9a-f]{20}$/);
    expect(first.entity_id).toBe(movie.entity_id);
    expect(first.reference_name).toBe(movie.name);
    expect(first.domain).toBe("movie");
    expect(first.capture_id).toBe(MOVIES.capture_id);
    expect(result.proposals[1]?.capture_id).toBe(GAMES.capture_id);
  });

  it("assigns the same proposal id for the same stage and reference", () => {
    const once = validateProposalOutput({ proposals: [item(movie)] }, stage, SECOND_COPY_BRIEF);
    const twice = validateProposalOutput({ proposals: [item(movie)] }, stage, SECOND_COPY_BRIEF);
    expect(once.ok && twice.ok).toBe(true);
    if (!once.ok || !twice.ok) return;
    expect(once.proposals[0]?.proposal_id).toBe(twice.proposals[0]?.proposal_id);
  });

  it("rejects a reference this request did not include", () => {
    const result = validateProposalOutput(
      { proposals: [item(movie, { reference_id: "ref.mv.deadbeefdeadbeef" })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.FOREIGN_REFERENCE);
  });

  it("rejects an invented evidence id", () => {
    const result = validateProposalOutput(
      { proposals: [item(movie, { selected_evidence_ids: [`${movie.reference_id}#ev99`] })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.UNSUPPORTED_EVIDENCE);
  });

  it("rejects an evidence id that belongs to another reference", () => {
    const result = validateProposalOutput(
      { proposals: [item(movie, { selected_evidence_ids: [game.evidence[0]!.id] })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.UNSUPPORTED_EVIDENCE);
  });

  it("rejects zero, too many, and duplicated evidence ids", () => {
    for (const ids of [
      [],
      movie.evidence.slice(0, 5).map((evidence) => evidence.id),
      [movie.evidence[0]!.id, movie.evidence[0]!.id],
    ]) {
      const result = validateProposalOutput(
        { proposals: [item(movie, { selected_evidence_ids: ids })] },
        stage,
        SECOND_COPY_BRIEF,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.EVIDENCE_COUNT);
    }
  });

  it("rejects a slot outside discovery and commitment", () => {
    const result = validateProposalOutput(
      { proposals: [item(movie, { slot: "ending" as never })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.INVALID_SLOT);
  });

  it("rejects oversize, empty, and non-plain text", () => {
    for (const overrides of [
      { idea: "x".repeat(501) },
      { intended_interaction: "x".repeat(301) },
      { relevance: "x".repeat(301) },
      { idea: "   " },
      { idea: "two\u0000names" },
    ] as Partial<ProposalDraftItem>[]) {
      const result = validateProposalOutput(
        { proposals: [item(movie, overrides)] },
        stage,
        SECOND_COPY_BRIEF,
      );
      expect(result.ok, JSON.stringify(overrides).slice(0, 40)).toBe(false);
      if (result.ok) continue;
      expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.TEXT_BOUNDS);
    }
  });

  it("rejects every forbidden attribution, literally", () => {
    for (const phrase of FORBIDDEN_CLAIM_PHRASES) {
      const result = validateProposalOutput(
        { proposals: [item(movie, { relevance: `This follows because ${phrase} it.` })] },
        stage,
        SECOND_COPY_BRIEF,
      );
      expect(result.ok, phrase).toBe(false);
      if (result.ok) continue;
      expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.FORBIDDEN_CLAIM);
    }
  });

  it("rejects the brief's own forbidden wording", () => {
    const brief: Brief = { ...SECOND_COPY_BRIEF, forbidden_wording: ["clone"] };
    const result = validateProposalOutput(
      { proposals: [item(movie, { idea: "A clone of the sender appears." })] },
      prepared([MOVIES, GAMES], brief),
      brief,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.FORBIDDEN_CLAIM);
  });

  it("rejects two proposals for one reference, and an empty set", () => {
    const duplicate = validateProposalOutput(
      { proposals: [item(movie), item(movie, { slot: "commitment" })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(duplicate.ok).toBe(false);

    const empty = validateProposalOutput({ proposals: [] }, stage, SECOND_COPY_BRIEF);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.rejections[0]?.code).toBe(PROPOSAL_ERROR_CODES.SHAPE);
  });

  it("rejects more proposals than the call permits", () => {
    const tooMany = stage.eligible.map((candidate) => item(candidate));
    const result = validateProposalOutput(
      { proposals: [...tooMany, item(movie, { reference_id: tooMany[0]!.reference_id })] },
      stage,
      SECOND_COPY_BRIEF,
    );
    expect(result.ok).toBe(false);
  });

  it("fails the whole set rather than silently dropping one bad proposal", () => {
    const result = validateProposalOutput(
      {
        proposals: [
          item(movie),
          item(game, { selected_evidence_ids: ["ref.vg.nope#ev1"] }),
        ],
      },
      stage,
      SECOND_COPY_BRIEF,
    );
    // Not "one accepted": the stage fails, so a partial reinterpretation of
    // what the model said can never reach the creator.
    expect(result.ok).toBe(false);
  });

  it("names the problems concisely in the repair note, and nothing else", () => {
    const note = repairNote([
      { code: PROPOSAL_ERROR_CODES.UNSUPPORTED_EVIDENCE, detail: "id x does not belong" },
    ]);
    expect(note).toContain(PROPOSAL_ERROR_CODES.UNSUPPORTED_EVIDENCE);
    expect(note).toContain("Do not add a reference");
    expect(note.split("\n").length).toBeLessThan(10);
  });
});

describe("running the proposal stage", () => {
  const stage = prepared();
  const good = {
    proposals: [
      item(stage.eligible[2]!),
      item(stage.eligible[3]!, { slot: "commitment" as const }),
    ],
  };

  it("makes one call on the happy path and records the usage", async () => {
    const model = scriptedModel([
      { parsed: good, usage: { input_tokens: 2_100, output_tokens: 420, total_tokens: 2_520 } },
    ]);
    const result = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    );
    expect(result.modelCalls).toBe(1);
    expect(result.repaired).toBe(false);
    expect(result.usage?.total_tokens).toBe(2_520);
    expect(result.draft.model).toBe("gpt-4o-mini-2024-07-18");
    expect(result.draft.proposals).toHaveLength(2);
    expect(model.requests).toHaveLength(1);
    // The pinned model, no conversation handle, no stored state.
    expect(model.requests[0]?.["model"]).toBe("gpt-4o-mini-2024-07-18");
    expect(model.requests[0]?.["store"]).toBe(false);
    expect(model.requests[0]).not.toHaveProperty("previous_response_id");
  });

  it("permits exactly one structural repair, and tells it what was wrong", async () => {
    const bad = { proposals: [item(stage.eligible[0]!, { selected_evidence_ids: ["nope"] })] };
    const model = scriptedModel([{ parsed: bad }, { parsed: good }]);
    const result = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    );
    expect(result.modelCalls).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.draft.model_calls).toBe(2);
    expect(String(model.requests[1]?.["instructions"])).toContain(
      PROPOSAL_ERROR_CODES.UNSUPPORTED_EVIDENCE,
    );
  });

  it("stops after the repair instead of trying again", async () => {
    // Shape-valid, so the provider schema accepts it; application validation
    // rejects it both times, which is what the repair allowance covers.
    const bad = { proposals: [item(stage.eligible[0]!, { selected_evidence_ids: ["nope"] })] };
    const model = scriptedModel([{ parsed: bad }]);
    const error = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).toContain(PROPOSAL_ERROR_CODES.UNSUPPORTED_EVIDENCE);
    expect(model.requests).toHaveLength(MAX_PROPOSAL_MODEL_CALLS);
  });

  it("lets the provider schema reject an out-of-enum slot in one call", async () => {
    const model = scriptedModel([
      { parsed: { proposals: [item(stage.eligible[0]!, { slot: "ending" as never })] } },
    ]);
    const error = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    ).catch((cause: unknown) => cause);
    // The authoritative contract refuses it before application validation even
    // sees it, so the one repair allowance is not spent on an unfixable shape.
    expect((error as ModelError).code).toBe("MODEL_INVALID_OUTPUT");
    expect(model.requests).toHaveLength(1);
  });

  it("treats a refusal as a failed stage, with no partial output", async () => {
    const model = scriptedModel([{ refusal: "I will not do that." }]);
    const error = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe("MODEL_REFUSED");
    // A refusal is not retried as if it were a structural problem.
    expect(model.requests).toHaveLength(1);
  });

  it("treats a truncated response as a failed stage", async () => {
    const model = scriptedModel([{ status: "incomplete", text: '{"proposals":[{"refer' }]);
    const error = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    ).catch((cause: unknown) => cause);
    expect((error as ModelError).code).toBe("MODEL_TRUNCATED");
  });

  it("refuses a response that came back from another model", async () => {
    const model = scriptedModel([{ parsed: good, model: "gpt-4o-mini-2099-01-01" }]);
    const error = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      { client: model.client, now: () => T0 },
    ).catch((cause: unknown) => cause);
    expect((error as ModelError).code).toBe("MODEL_MISMATCH");
  });

  it("counts a transport failure as one spent attempt and reports it", async () => {
    const model = scriptedModel([{ throws: new Error("ECONNRESET") }]);
    const calls: number[] = [];
    const error = await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      {
        client: model.client,
        now: () => T0,
        beforeCall: async (attempt) => {
          calls.push(attempt);
        },
      },
    ).catch((cause: unknown) => cause);
    expect((error as ModelError).code).toBe("MODEL_TRANSPORT");
    // The stage reserved once and stopped; it did not retry a transport
    // failure on top of its one repair allowance.
    expect(calls).toEqual([1]);
  });

  it("reports the budget hooks once per attempt, in order", async () => {
    const bad = { proposals: [item(stage.eligible[0]!, { selected_evidence_ids: ["nope"] })] };
    const model = scriptedModel([{ parsed: bad }, { parsed: good }]);
    const events: string[] = [];
    await runProposalStage(
      { brief: SECOND_COPY_BRIEF, captures: [MOVIES, GAMES], anchorEntityId: LANTERNFOLD_ENTITY_ID },
      stage,
      {
        client: model.client,
        now: () => T0,
        beforeCall: async (attempt) => {
          events.push(`before:${attempt}`);
        },
        afterCall: async (outcome) => {
          events.push(`after:${outcome.usage?.total_tokens ?? "none"}`);
        },
      },
    );
    expect(events).toEqual(["before:1", "after:1520", "before:2", "after:1520"]);
  });
});
