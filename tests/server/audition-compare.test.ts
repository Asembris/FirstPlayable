import { describe, expect, it } from "vitest";
import { AUDITION_CLOSE_THRESHOLD } from "../../src/domain/audition";
import {
  type AudienceScores,
  AuditionDomainError,
  type ComparedComp,
  compareAudiences,
  isClose,
  rankForAudience,
} from "../../src/domain/audition-compare";

const MOON: ComparedComp = { entity_id: "00000000-0000-4000-8000-00000000000A", name: "Moon", domain: "movie" };
const ARRIVAL: ComparedComp = { entity_id: "00000000-0000-4000-8000-00000000000B", name: "Arrival", domain: "movie" };
const BROTHER: ComparedComp = { entity_id: "00000000-0000-4000-8000-00000000000C", name: "O Brother, Where Art Thou?", domain: "movie" };
const OUTER_WILDS: ComparedComp = { entity_id: "00000000-0000-4000-8000-00000000000D", name: "Outer Wilds", domain: "videogame" };

function scores(
  name: string,
  values: Record<string, number | null>,
  domain: "movie" | "videogame" = "movie",
): AudienceScores {
  return {
    audience_entity_id: `AUD-${name}`,
    audience_name: name,
    domain,
    affinities: new Map(Object.entries(values)),
  };
}

describe("the close threshold", () => {
  it("is the fixed 0.03 display rule", () => {
    expect(AUDITION_CLOSE_THRESHOLD).toBe(0.03);
  });

  it("treats a gap under 0.03 as close and a gap of exactly 0.03 as clear", () => {
    expect(isClose(0.52, 0.5)).toBe(true);
    expect(isClose(0.53, 0.5)).toBe(false); // 0.030000000000000027 in floating point
    expect(isClose(0.8, 0.77)).toBe(false); // 0.030000000000000027 the other way round
    expect(isClose(0.5, 0.529)).toBe(true);
  });
});

describe("one audience, one domain", () => {
  it("orders by affinity descending, whatever order the comps came in", () => {
    const ranking = rankForAudience(
      "movie",
      [BROTHER, MOON, ARRIVAL],
      scores("Radiohead", { [MOON.entity_id]: 0.91, [ARRIVAL.entity_id]: 0.7, [BROTHER.entity_id]: 0.4 }),
    );
    expect(ranking.ordered.map((row) => row.name)).toEqual(["Moon", "Arrival", "O Brother, Where Art Thou?"]);
    expect(ranking.ordered.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(ranking.top).toEqual({ status: "clear", leaders: [MOON.entity_id] });
  });

  it("is deterministic on ties, falling back to the creator's comp order", () => {
    const tied = scores("A", { [MOON.entity_id]: 0.6, [ARRIVAL.entity_id]: 0.6 });
    expect(rankForAudience("movie", [ARRIVAL, MOON], tied).ordered.map((r) => r.name)).toEqual(["Arrival", "Moon"]);
    expect(rankForAudience("movie", [MOON, ARRIVAL], tied).ordered.map((r) => r.name)).toEqual(["Moon", "Arrival"]);
  });

  it("groups the top as close instead of naming a winner", () => {
    const ranking = rankForAudience(
      "movie",
      [MOON, ARRIVAL, BROTHER],
      scores("A", { [MOON.entity_id]: 0.62, [ARRIVAL.entity_id]: 0.6, [BROTHER.entity_id]: 0.2 }),
    );
    expect(ranking.top.status).toBe("close");
    expect(ranking.top.leaders).toEqual([MOON.entity_id, ARRIVAL.entity_id]);
    expect(ranking.ordered[0]?.close_to_next).toBe(true);
    expect(ranking.ordered[1]?.close_to_next).toBe(false);
  });

  it("measures closeness from the top value rather than chaining", () => {
    // 0.50 → 0.48 → 0.46: each step is close, but 0.46 is clearly behind 0.50.
    const ranking = rankForAudience(
      "movie",
      [MOON, ARRIVAL, BROTHER],
      scores("A", { [MOON.entity_id]: 0.5, [ARRIVAL.entity_id]: 0.48, [BROTHER.entity_id]: 0.46 }),
    );
    expect(ranking.top.leaders).toEqual([MOON.entity_id, ARRIVAL.entity_id]);
  });

  it("lists a comp with no returned score as unscored and never ranks it", () => {
    const ranking = rankForAudience(
      "movie",
      [MOON, ARRIVAL],
      scores("A", { [MOON.entity_id]: 0.4, [ARRIVAL.entity_id]: null }),
    );
    expect(ranking.ordered.map((r) => r.name)).toEqual(["Moon"]);
    expect(ranking.unscored).toEqual([{ entity_id: ARRIVAL.entity_id, name: "Arrival" }]);
    expect(ranking.top.status).toBe("single");
  });

  it("reports nothing scored as none rather than inventing an order", () => {
    const ranking = rankForAudience("movie", [MOON], scores("A", {}));
    expect(ranking.top).toEqual({ status: "none", leaders: [] });
    expect(ranking.ordered).toEqual([]);
  });
});

describe("audience A against audience B", () => {
  it("finds a reversal only when both sides are clear and opposite", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL],
      scores("Radiohead", { [MOON.entity_id]: 0.8, [ARRIVAL.entity_id]: 0.6 }),
      scores("Kendrick Lamar", { [MOON.entity_id]: 0.3, [ARRIVAL.entity_id]: 0.5 }),
    );
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.verdict).toBe("reversal");
    expect(result.pairs[0]?.relations[0]).toMatchObject({ status: "clear", leader: MOON.entity_id });
    expect(result.pairs[0]?.relations[1]).toMatchObject({ status: "clear", leader: ARRIVAL.entity_id });
    expect(result.reversals).toBe(1);
  });

  it("reports a clear order that holds for both audiences", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL],
      scores("A", { [MOON.entity_id]: 0.8, [ARRIVAL.entity_id]: 0.6 }),
      scores("B", { [MOON.entity_id]: 0.7, [ARRIVAL.entity_id]: 0.5 }),
    );
    expect(result.pairs[0]?.verdict).toBe("holds");
    expect(result.reversals).toBe(0);
  });

  it("is not a reversal when audience A sees the pair as close", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL],
      scores("A", { [MOON.entity_id]: 0.61, [ARRIVAL.entity_id]: 0.6 }),
      scores("B", { [MOON.entity_id]: 0.3, [ARRIVAL.entity_id]: 0.5 }),
    );
    expect(result.pairs[0]?.verdict).toBe("close");
    expect(result.pairs[0]?.relations[0]).toEqual({ status: "close", leader: null, gap: 0.01 });
    expect(result.reversals).toBe(0);
  });

  it("is not a reversal when audience B sees the pair as close", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL],
      scores("A", { [MOON.entity_id]: 0.8, [ARRIVAL.entity_id]: 0.6 }),
      scores("B", { [MOON.entity_id]: 0.49, [ARRIVAL.entity_id]: 0.5 }),
    );
    expect(result.pairs[0]?.verdict).toBe("close");
    expect(result.reversals).toBe(0);
  });

  it("is incomplete, never a verdict, when a score is missing", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL],
      scores("A", { [MOON.entity_id]: 0.8, [ARRIVAL.entity_id]: 0.2 }),
      scores("B", { [MOON.entity_id]: 0.1 }),
    );
    expect(result.pairs[0]?.verdict).toBe("incomplete");
    expect(result.pairs[0]?.relations[1]).toEqual({ status: "missing", leader: null, gap: null });
  });

  it("compares every pair of three comps exactly once", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL, BROTHER],
      scores("A", { [MOON.entity_id]: 0.9, [ARRIVAL.entity_id]: 0.5, [BROTHER.entity_id]: 0.1 }),
      scores("B", { [MOON.entity_id]: 0.1, [ARRIVAL.entity_id]: 0.5, [BROTHER.entity_id]: 0.9 }),
    );
    expect(result.pairs.map((p) => [p.a, p.b])).toEqual([
      [MOON.entity_id, ARRIVAL.entity_id],
      [MOON.entity_id, BROTHER.entity_id],
      [ARRIVAL.entity_id, BROTHER.entity_id],
    ]);
    expect(result.reversals).toBe(3);
  });

  it("carries no field beyond ordering, closeness and reversals", () => {
    const result = compareAudiences(
      "movie",
      [MOON, ARRIVAL],
      scores("A", { [MOON.entity_id]: 0.8, [ARRIVAL.entity_id]: 0.6 }),
      scores("B", { [MOON.entity_id]: 0.3, [ARRIVAL.entity_id]: 0.5 }),
    );
    const text = JSON.stringify(result).toLowerCase();
    for (const invented of ["lift", "baseline", "coverage", "diversity", "complement", "average", "overall", "winner"]) {
      expect(text).not.toContain(invented);
    }
  });
});

describe("same-domain enforcement", () => {
  it("refuses a videogame comp inside a movie comparison", () => {
    expect(() =>
      compareAudiences(
        "movie",
        [MOON, OUTER_WILDS],
        scores("A", { [MOON.entity_id]: 0.5, [OUTER_WILDS.entity_id]: 0.9 }),
        scores("B", { [MOON.entity_id]: 0.5, [OUTER_WILDS.entity_id]: 0.1 }),
      ),
    ).toThrow(AuditionDomainError);
  });

  it("refuses videogame scores inside a movie comparison", () => {
    expect(() =>
      compareAudiences(
        "movie",
        [MOON, ARRIVAL],
        scores("A", { [MOON.entity_id]: 0.5, [ARRIVAL.entity_id]: 0.4 }),
        scores("B", { [MOON.entity_id]: 0.5, [ARRIVAL.entity_id]: 0.4 }, "videogame"),
      ),
    ).toThrow(AuditionDomainError);
    expect(() =>
      rankForAudience("videogame", [OUTER_WILDS], scores("A", { [OUTER_WILDS.entity_id]: 0.5 })),
    ).toThrow(AuditionDomainError);
  });

  it("refuses the same title twice", () => {
    expect(() =>
      compareAudiences("movie", [MOON, MOON], scores("A", {}), scores("B", {})),
    ).toThrow(AuditionDomainError);
  });
});
