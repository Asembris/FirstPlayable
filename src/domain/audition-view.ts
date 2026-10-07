/**
 * What `POST /api/audition/score` returns, shared with the browser.
 *
 * Every `name` below was copied by the server from a stored Qloo search
 * capture the creator confirmed a result from. Every affinity inside
 * `comparison` is a value a stored Qloo insights capture returned.
 */

import type { DomainComparison } from "./audition-compare";
import type { DecisionResult } from "./audition-decision";
import type { QlooDomain } from "./qloo";

export type ConfirmedEntityView = {
  slot_id: string;
  entity_id: string;
  name: string;
  /** The search capture the creator confirmed this result from. */
  search_capture_id: string;
  /** The 1-based rank at which that search returned it. */
  original_rank: number;
};

/** One `/v2/insights` capture behind a ranking, for the evidence drawer. */
export type ScoreEvidenceView = {
  audience_entity_id: string;
  capture_id: string | null;
  retrieved_at: string;
  cache: "live" | "cached" | "stale";
  /** The request shape, with ids but without host or credential. */
  request: string;
  missing_entity_ids: string[];
};

export type DomainAuditionView = {
  domain: QlooDomain;
  comps: ConfirmedEntityView[];
  comparison: DomainComparison;
  evidence: ScoreEvidenceView[];
};

export type ScoreResponse = {
  audiences: [ConfirmedEntityView, ConfirmedEntityView];
  domains: Record<QlooDomain, DomainAuditionView | null>;
  /** Comps the creator has not confirmed. They were not scored. */
  unconfirmed: { slot_id: string; kind: string; query: string }[];
  /** The answer to the creator's decision question, computed from `domains`. */
  decision: DecisionResult | null;
  upstream_calls: number;
};
