import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import record from "../../evidence/qloo/audition/recorded-2026-10-07.json";
import { AUDITION_NORMALIZER_VERSION, CompScoreCaptureSchema } from "../../src/domain/audition";
import { compareAudiences } from "../../src/domain/audition-compare";
import { decideForeground } from "../../src/domain/audition-decision";
import { domainAuditionView } from "../../src/domain/audition-result";
import {
  evidenceDigest,
  RECORDED_AUDITION,
  recordedAuditionReplay,
  recordedAuditionResult,
} from "../../src/presentation/recorded-audition";
import {
  compScoreFingerprint,
  compSearchFingerprint,
} from "../../src/server/qloo/audition";
import { artistSearchFingerprint } from "../../src/server/qloo/normalize";

/**
 * The gate on the one piece of real Qloo evidence this repository publishes.
 *
 * Three separate claims are checked, because each one can fail on its own:
 *
 *   1. **It is Qloo's, unedited.** Every stored request fingerprint is
 *      recomputed by the production fingerprint functions from the stored
 *      host, domain, audience and candidate ids. Those digests were produced
 *      by the live client at retrieval time, so a changed id, domain or
 *      candidate set cannot keep its fingerprint. The record's own
 *      `content_digest` then covers everything the fingerprints do not,
 *      affinities included.
 *   2. **The outcome is derived, not stored.** The pinned rankings, verdicts
 *      and decision below are recomputed here from the affinities through
 *      `compareAudiences` and `decideForeground`. Nothing in the record names
 *      a winner.
 *   3. **Nothing was republished that should not be.** No raw response body,
 *      no credential, no provider metadata beyond the identity and affinity
 *      fields the product displays.
 */

const HOST = "hackathon.api.qloo.com";
const RETRIEVED = "2026-10-07";

/** Qloo's own ids for the recorded run. Pinned: a change here is a new capture. */
const ENTITY = {
  moon: "6BBB34F4-9345-4459-82AE-10991FA35CD2",
  arrival: "C7EC4CA9-1CCC-4991-B738-55F075441B3F",
  interstellar: "057DA9D9-399B-437E-8BCA-A80E499125EF",
  outerWilds: "EA0D6B19-199B-439B-809D-B60B4412E405",
  deathStranding: "B061B95F-B940-4871-B80A-C12365E7A2A1",
  massEffect: "DB003E13-0C9F-4011-B928-43ADC2A59F26",
  radiohead: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
  kendrick: "C915A918-39C5-47A3-A101-D9FA1DECBD9C",
} as const;

/** The affinities Qloo returned, to full returned precision. */
const AFFINITY: Record<string, Record<string, number>> = {
  [ENTITY.radiohead]: {
    [ENTITY.moon]: 0.9277100856231865,
    [ENTITY.arrival]: 0.8355442500541155,
    [ENTITY.interstellar]: 0.8118546029570369,
    [ENTITY.massEffect]: 0.8809011942786064,
    [ENTITY.outerWilds]: 0.6703367393438057,
    [ENTITY.deathStranding]: 0.537879723429959,
  },
  [ENTITY.kendrick]: {
    [ENTITY.arrival]: 0.8226596028849298,
    [ENTITY.interstellar]: 0.7558787030186511,
    [ENTITY.moon]: 0.7220932085293376,
    [ENTITY.deathStranding]: 0.6392810706221489,
    [ENTITY.massEffect]: 0.612591001814321,
    [ENTITY.outerWilds]: 0.5180356788147933,
  },
};

const recordedText = readFileSync(
  fileURLToPath(new URL("../../evidence/qloo/audition/recorded-2026-10-07.json", import.meta.url)),
  "utf8",
);

describe("the recorded Qloo evidence is Qloo's, and unedited", () => {
  it("declares one recorded run of twelve upstream calls", () => {
    expect(record.evidence).toBe("recorded_qloo");
    expect(record.provider.name).toBe("Qloo");
    expect(record.provider.host).toBe(HOST);
    expect(record.normalizer_version).toBe(AUDITION_NORMALIZER_VERSION);
    expect(record.retrieval.upstream_calls).toBe(12);
    expect(record.retrieval.first_at.slice(0, 10)).toBe(RETRIEVED);
    expect(record.retrieval.last_at.slice(0, 10)).toBe(RETRIEVED);
    expect(record.comps).toHaveLength(6);
    expect(record.audiences).toHaveLength(2);
    expect(record.captures).toHaveLength(4);
  });

  it("recomputes every stored request fingerprint from the stored identities", () => {
    for (const comp of record.comps) {
      expect(
        compSearchFingerprint({
          host: HOST,
          domain: comp.domain as "movie" | "videogame",
          normalizedQuery: comp.search_normalized_query,
        }),
        `${comp.name} search fingerprint`,
      ).toBe(comp.search_request_fingerprint);
    }
    for (const audience of record.audiences) {
      expect(
        artistSearchFingerprint({ host: HOST, normalizedQuery: audience.search_normalized_query }),
        `${audience.name} search fingerprint`,
      ).toBe(audience.search_request_fingerprint);
    }
    for (const { capture } of record.captures) {
      expect(
        compScoreFingerprint({
          host: HOST,
          domain: capture.domain as "movie" | "videogame",
          audienceEntityId: capture.audience_entity_id,
          candidateIds: capture.requested_entity_ids,
        }),
        `${capture.domain} score fingerprint for ${capture.audience_entity_id}`,
      ).toBe(capture.request_fingerprint);
    }
  });

  it("recomputes the record's own content digest", () => {
    const { content_digest: digest, ...contents } = record;
    expect(evidenceDigest(contents)).toBe(digest);
    expect(RECORDED_AUDITION.content_digest).toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  /**
   * The digest pins affinities to twelve decimals, because a bundler may
   * re-emit a sixteen-digit literal as the neighbouring double. That window
   * is twelve orders of magnitude below the 0.03 display threshold, so it can
   * never hide a change to an ordering, a close call or a shown value.
   */
  it("still catches an affinity edit far smaller than the display threshold", () => {
    const { content_digest: digest, ...contents } = record;
    const nudged = structuredClone(contents) as typeof contents;
    nudged.captures[0]!.capture.scores[0]!.affinity += 1e-11;
    expect(evidenceDigest(nudged)).not.toBe(digest);
  });

  it("holds exactly the identities and affinities Qloo returned", () => {
    const ids = Object.fromEntries(Object.entries(ENTITY).map(([key, id]) => [id, key]));
    for (const entity of [...record.comps, ...record.audiences]) {
      expect(ids[entity.entity_id], `${entity.name} is a pinned recorded identity`).toBeDefined();
      expect(entity.original_rank).toBeGreaterThan(0);
      expect(entity.search_retrieved_at.slice(0, 10)).toBe(RETRIEVED);
      expect(entity.response_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const { capture } of record.captures) {
      expect(capture.kind).toBe("comp_scores");
      expect(capture.missing_entity_ids).toEqual([]);
      expect(capture.scores).toHaveLength(3);
      for (const score of capture.scores) {
        expect(score.affinity, `${score.name} for ${capture.audience_entity_id}`).toBe(
          AFFINITY[capture.audience_entity_id]![score.entity_id],
        );
      }
      // Each insights request named exactly the confirmed comps of its domain.
      expect([...capture.requested_entity_ids].sort()).toEqual(
        record.comps
          .filter((comp) => comp.domain === capture.domain)
          .map((comp) => comp.entity_id)
          .sort(),
      );
      expect(CompScoreCaptureSchema.parse({ ...capture, capture_id: null, cache: "cached" }).scores)
        .toHaveLength(3);
    }
  });

  it("republishes no raw response, credential or unused provider metadata", () => {
    expect(recordedText).not.toMatch(/x-api-key/i);
    expect(recordedText).not.toMatch(/authorization/i);
    // The wire bodies stay private; only their hashes are provenance.
    for (const forbidden of [
      "subtype",
      "properties",
      "images.qloo.com",
      "short_description",
      "identity_hints",
      "external",
      "imdb",
      "metacritic",
      "rottentomatoes",
      "wikidata",
      "audience_identity",
      "player_demographics",
      "websites",
      "\"tags\"",
    ]) {
      expect(recordedText.includes(forbidden), `the record retains ${forbidden}`).toBe(false);
    }
    expect(Object.keys(record.captures[0]!).sort()).toEqual([
      "capture",
      "capture_id",
      "response_sha256",
    ]);
    // No stored ordering, verdict, winner or reversal anywhere in the record.
    for (const stored of ["position", "verdict", "reversal", "leader", "lead", "rank_", "ordered"]) {
      expect(recordedText.includes(stored), `the record stores ${stored}`).toBe(false);
    }
  });
});

describe("the recorded comparison is derived by the production logic", () => {
  const replay = recordedAuditionReplay();

  it("replays with zero provider calls and recorded provenance", () => {
    expect(replay.provenance).toEqual({ kind: "recorded_qloo", captured_at: record.retrieval.last_at });
    expect(replay.result.upstream_calls).toBe(0);
    expect(replay.title).toBe("The Last Signal");
  });

  it("produces the same view as a direct domainAuditionView call", () => {
    const result = recordedAuditionResult();
    for (const domain of ["movie", "videogame"] as const) {
      const view = result.domains[domain]!;
      const captures = result.audiences.map((audience) =>
        CompScoreCaptureSchema.parse({
          ...record.captures.find(
            (row) =>
              row.capture.domain === domain &&
              row.capture.audience_entity_id === audience.entity_id,
          )!.capture,
          capture_id: record.captures.find(
            (row) =>
              row.capture.domain === domain &&
              row.capture.audience_entity_id === audience.entity_id,
          )!.capture_id,
          cache: "cached",
        }),
      );
      expect(domainAuditionView(domain, view.comps, result.audiences, [captures[0]!, captures[1]!]))
        .toEqual(view);
    }
  });

  it("orders Qloo's real affinities into the audience reversal the demo shows", () => {
    const result = replay.result;
    expect(result.audiences.map((audience) => audience.name)).toEqual([
      "Radiohead",
      "Kendrick Lamar",
    ]);
    const movies = result.domains.movie!;
    expect(movies.comparison.rankings.map((ranking) => ranking.ordered.map((row) => row.name)))
      .toEqual([
        ["Moon", "Arrival", "Interstellar"],
        ["Arrival", "Interstellar", "Moon"],
      ]);
    expect(movies.comparison.pairs.map((pair) => pair.verdict)).toEqual([
      "reversal",
      "reversal",
      "close",
    ]);
    expect(movies.comparison.reversals).toBe(2);

    const games = result.domains.videogame!;
    expect(games.comparison.rankings.map((ranking) => ranking.ordered.map((row) => row.name)))
      .toEqual([
        ["Mass Effect", "Outer Wilds", "Death Stranding"],
        ["Death Stranding", "Mass Effect", "Outer Wilds"],
      ]);
    expect(games.comparison.pairs.map((pair) => pair.verdict)).toEqual([
      "reversal",
      "holds",
      "close",
    ]);
    expect(games.comparison.rankings[0].top.status).toBe("clear");
    // Kendrick Lamar's top two games sit inside the display threshold, so the
    // tool declines to call it. Both outcomes are in one recorded example.
    expect(games.comparison.rankings[1].top.status).toBe("close");
  });

  it("recomputes every ranking straight from the stored affinities", () => {
    for (const domain of ["movie", "videogame"] as const) {
      const view = replay.result.domains[domain]!;
      const comps = view.comps.map((comp) => ({ ...comp, domain }));
      const scores = replay.result.audiences.map((audience) => ({
        domain,
        audience_entity_id: audience.entity_id,
        audience_name: audience.name,
        affinities: new Map(
          comps.map((comp) => [comp.entity_id, AFFINITY[audience.entity_id]![comp.entity_id]!]),
        ),
      }));
      expect(compareAudiences(domain, comps, scores[0]!, scores[1]!)).toEqual(view.comparison);
    }
  });

  it("answers the fixed example question from that comparison, never from the record", () => {
    const result = replay.result;
    const radiohead = result.audiences[0];
    expect(result.decision).toEqual(
      decideForeground(
        { action: "foreground_comp", domain: "movie", audience_slot_id: radiohead.slot_id },
        result.domains.movie,
        radiohead,
      ),
    );
    expect(result.decision).toMatchObject({
      domain: "movie",
      audience_entity_id: ENTITY.radiohead,
      audience_name: "Radiohead",
      outcome: { status: "clear_lead", lead: { entity_id: ENTITY.moon, name: "Moon" } },
      not_scored: [],
    });
    // The lead is the ranking's own leader, so the card can never disagree.
    expect(result.domains.movie!.comparison.rankings[0].top.leaders).toEqual([ENTITY.moon]);
  });

  it("exposes the request shape without a host or a credential", () => {
    for (const domain of ["movie", "videogame"] as const) {
      for (const item of replay.result.domains[domain]!.evidence) {
        expect(item.request).toContain("filter.results.entities=");
        expect(item.request).not.toContain(HOST);
        expect(item.request).not.toMatch(/https?:/);
        expect(item.cache).toBe("cached");
        expect(item.retrieved_at.slice(0, 10)).toBe(RETRIEVED);
      }
    }
  });
});

describe("a tampered record is refused, not rendered", () => {
  const MODULE = "../../src/presentation/recorded-audition";
  const EVIDENCE = "../../evidence/qloo/audition/recorded-2026-10-07.json";

  async function load(mutate: (draft: typeof record) => void): Promise<unknown> {
    const draft = structuredClone(record) as typeof record;
    mutate(draft);
    vi.resetModules();
    vi.doMock(EVIDENCE, () => ({ default: draft }));
    try {
      return await import(MODULE);
    } finally {
      vi.doUnmock(EVIDENCE);
      vi.resetModules();
    }
  }

  /** The digest gate: any edit at all, including one that stays well-formed. */
  it("refuses an affinity nudged into a different outcome", async () => {
    await expect(
      load((draft) => {
        // Enough to turn the Radiohead movie lead from clear into close.
        draft.captures[0]!.capture.scores[0]!.affinity = 0.84;
      }),
    ).rejects.toThrow(/RECORDED_EVIDENCE_REFUSED: the recorded evidence digest/);
  });

  it("refuses a swapped audience id", async () => {
    await expect(
      load((draft) => {
        draft.audiences[0]!.entity_id = draft.audiences[1]!.entity_id;
      }),
    ).rejects.toThrow(/RECORDED_EVIDENCE_REFUSED: the recorded evidence digest/);
  });

  /**
   * The second layer, with the digest recomputed so the first one passes: a
   * title that no longer matches the confirmed identity is still refused.
   */
  it("refuses a renamed title even with a freshly computed digest", async () => {
    await expect(
      load((draft) => {
        draft.captures[0]!.capture.scores[0]!.name = "Moonrise Kingdom";
        const { content_digest: _old, ...contents } = draft;
        draft.content_digest = evidenceDigest(contents);
      }),
    ).rejects.toThrow(/RECORDED_EVIDENCE_REFUSED: a movie score renames a confirmed comp/);
  });

  it("still loads the untouched record", async () => {
    const module = (await load(() => {})) as { recordedAuditionResult: () => { upstream_calls: number } };
    expect(module.recordedAuditionResult().upstream_calls).toBe(0);
  });
});
