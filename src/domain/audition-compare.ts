/**
 * The one deterministic comparison layer of the comp audition.
 *
 * Pure: no I/O, no clock, no randomness, no model. Given the confirmed comps
 * of **one domain** and the affinities Qloo returned for two audiences, it
 * produces an ordering per audience, the close calls, and the reversals.
 *
 * Semantics, exactly:
 *
 *   * **Ordering.** Within one audience and one domain, comps are sorted by
 *     returned affinity, descending. Equal affinities fall back to the
 *     creator's own comp order, so the result never depends on anything but
 *     its inputs. A comp Qloo returned no score for is listed as unscored and
 *     is never placed in the order.
 *   * **Close.** Two affinities are close when their gap is smaller than
 *     {@link AUDITION_CLOSE_THRESHOLD} (0.03). That is a product display rule,
 *     not statistical significance and not a Qloo-provided confidence
 *     threshold. A close pair names no leader.
 *   * **Clear.** A gap of at least the threshold. Only a clear gap names a
 *     leader.
 *   * **Reversal.** A pair (X, Y) reverses only when X clearly beats Y for
 *     audience A *and* Y clearly beats X for audience B. If either side is
 *     close, or either score is missing, it is not a reversal.
 *
 * What this module deliberately does not compute: a baseline lift,
 * complementarity, diversity, audience coverage, an average, or any score
 * that spans movies and videogames. A movie affinity and a videogame affinity
 * are never compared; mixing domains is an error, not a coercion.
 */

import { AUDITION_CLOSE_THRESHOLD } from "./audition";
import type { QlooDomain } from "./qloo";

export class AuditionDomainError extends Error {
  constructor(detail: string) {
    super(`AUDITION_DOMAIN_MISMATCH: ${detail}`);
    this.name = "AuditionDomainError";
  }
}

export type ComparedComp = {
  entity_id: string;
  name: string;
  domain: QlooDomain;
};

/** One audience's returned affinities for one domain. */
export type AudienceScores = {
  audience_entity_id: string;
  audience_name: string;
  domain: QlooDomain;
  /** Keyed by upper-case entity id. Absent or null means Qloo returned no score. */
  affinities: ReadonlyMap<string, number | null>;
};

export type RankedComp = {
  entity_id: string;
  name: string;
  affinity: number;
  /** 1-based position in this audience's order. */
  position: number;
  /** Gap to the next scored comp, or null for the last one. */
  gap_to_next: number | null;
  /** Whether that gap is under the display threshold. */
  close_to_next: boolean;
};

export type TopStatus =
  /** One comp leads every other by at least the threshold. */
  | "clear"
  /** Two or more comps sit within the threshold of the top value. */
  | "close"
  /** Only one comp was scored, so there is nothing to order it against. */
  | "single"
  /** Nothing was scored. */
  | "none";

export type AudienceRanking = {
  audience_entity_id: string;
  audience_name: string;
  ordered: RankedComp[];
  unscored: { entity_id: string; name: string }[];
  top: { status: TopStatus; leaders: string[] };
};

export type PairRelation =
  | { status: "clear"; leader: string; gap: number }
  | { status: "close"; leader: null; gap: number }
  | { status: "missing"; leader: null; gap: null };

export type PairVerdict =
  /** Clear for both audiences, with opposite leaders. */
  | "reversal"
  /** Clear for both audiences, with the same leader. */
  | "holds"
  /** At least one audience sees the pair as close. */
  | "close"
  /** At least one score is missing. */
  | "incomplete";

export type PairComparison = {
  a: string;
  b: string;
  relations: [PairRelation, PairRelation];
  verdict: PairVerdict;
};

export type DomainComparison = {
  domain: QlooDomain;
  threshold: number;
  comps: ComparedComp[];
  rankings: [AudienceRanking, AudienceRanking];
  pairs: PairComparison[];
  reversals: number;
};

/**
 * Removes floating-point dust from a difference of two returned values, so a
 * gap that is exactly 0.03 in the data is not read as 0.0299999.
 */
function cleanGap(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** True when the gap between two affinities is under the display threshold. */
export function isClose(x: number, y: number): boolean {
  return Math.abs(cleanGap(x - y)) < AUDITION_CLOSE_THRESHOLD;
}

function scoreOf(scores: AudienceScores, entityId: string): number | null {
  const value = scores.affinities.get(entityId.toUpperCase());
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertDomain(domain: QlooDomain, comps: readonly ComparedComp[], scores: readonly AudienceScores[]): void {
  for (const comp of comps) {
    if (comp.domain !== domain) {
      throw new AuditionDomainError(`${comp.name} is a ${comp.domain}, not a ${domain}`);
    }
  }
  for (const audience of scores) {
    if (audience.domain !== domain) {
      throw new AuditionDomainError(
        `scores for ${audience.audience_name} are ${audience.domain} scores, not ${domain} scores`,
      );
    }
  }
}

/** Orders one audience's scored comps, descending, and finds the close calls. */
export function rankForAudience(
  domain: QlooDomain,
  comps: readonly ComparedComp[],
  scores: AudienceScores,
): AudienceRanking {
  assertDomain(domain, comps, [scores]);

  const scored: { comp: ComparedComp; affinity: number; order: number }[] = [];
  const unscored: { entity_id: string; name: string }[] = [];
  comps.forEach((comp, order) => {
    const affinity = scoreOf(scores, comp.entity_id);
    if (affinity === null) unscored.push({ entity_id: comp.entity_id, name: comp.name });
    else scored.push({ comp, affinity, order });
  });

  // Descending affinity. A tie keeps the creator's order, never anything else.
  scored.sort((x, y) => y.affinity - x.affinity || x.order - y.order);

  const ordered: RankedComp[] = scored.map((entry, index) => {
    const next = scored[index + 1];
    const gap = next === undefined ? null : cleanGap(entry.affinity - next.affinity);
    return {
      entity_id: entry.comp.entity_id,
      name: entry.comp.name,
      affinity: entry.affinity,
      position: index + 1,
      gap_to_next: gap,
      close_to_next: next !== undefined && isClose(entry.affinity, next.affinity),
    };
  });

  const first = scored[0];
  let top: AudienceRanking["top"];
  if (first === undefined) {
    top = { status: "none", leaders: [] };
  } else if (scored.length === 1) {
    top = { status: "single", leaders: [first.comp.entity_id] };
  } else {
    // Measured from the top value, not chained, so "close at the top" never
    // grows to include a comp that is clearly behind the leader.
    const leaders = scored
      .filter((entry) => isClose(first.affinity, entry.affinity))
      .map((entry) => entry.comp.entity_id);
    top = { status: leaders.length > 1 ? "close" : "clear", leaders };
  }

  return {
    audience_entity_id: scores.audience_entity_id,
    audience_name: scores.audience_name,
    ordered,
    unscored,
    top,
  };
}

/** How one audience sees one pair. */
export function relate(a: ComparedComp, b: ComparedComp, scores: AudienceScores): PairRelation {
  const x = scoreOf(scores, a.entity_id);
  const y = scoreOf(scores, b.entity_id);
  if (x === null || y === null) return { status: "missing", leader: null, gap: null };
  const gap = Math.abs(cleanGap(x - y));
  if (isClose(x, y)) return { status: "close", leader: null, gap };
  return { status: "clear", leader: x > y ? a.entity_id : b.entity_id, gap };
}

export function verdictOf(first: PairRelation, second: PairRelation): PairVerdict {
  if (first.status === "missing" || second.status === "missing") return "incomplete";
  if (first.status === "close" || second.status === "close") return "close";
  return first.leader === second.leader ? "holds" : "reversal";
}

/**
 * The A/B comparison for one domain.
 *
 * Throws {@link AuditionDomainError} if any comp or either audience's scores
 * belong to another domain: a movie affinity and a videogame affinity are
 * never placed side by side.
 */
export function compareAudiences(
  domain: QlooDomain,
  comps: readonly ComparedComp[],
  audienceA: AudienceScores,
  audienceB: AudienceScores,
): DomainComparison {
  assertDomain(domain, comps, [audienceA, audienceB]);

  const seen = new Set<string>();
  for (const comp of comps) {
    const key = comp.entity_id.toUpperCase();
    if (seen.has(key)) throw new AuditionDomainError(`${comp.name} is listed twice`);
    seen.add(key);
  }

  const pairs: PairComparison[] = [];
  for (let i = 0; i < comps.length; i += 1) {
    for (let j = i + 1; j < comps.length; j += 1) {
      const a = comps[i]!;
      const b = comps[j]!;
      const relations: [PairRelation, PairRelation] = [
        relate(a, b, audienceA),
        relate(a, b, audienceB),
      ];
      pairs.push({ a: a.entity_id, b: b.entity_id, relations, verdict: verdictOf(...relations) });
    }
  }

  return {
    domain,
    threshold: AUDITION_CLOSE_THRESHOLD,
    comps: [...comps],
    rankings: [
      rankForAudience(domain, comps, audienceA),
      rankForAudience(domain, comps, audienceB),
    ],
    pairs,
    reversals: pairs.filter((pair) => pair.verdict === "reversal").length,
  };
}
