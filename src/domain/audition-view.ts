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

// ---------------------------------------------------------------------------
// Replay provenance
// ---------------------------------------------------------------------------

/**
 * Where a replayed comparison's evidence came from.
 *
 *   * `recorded_qloo` — real Qloo search and insights evidence, retrieved once
 *     through the production client and stored under `evidence/qloo/`. Every
 *     identity and affinity is Qloo's; nothing about it is authored.
 *   * `synthetic` — invented values written in Qloo's response shapes, for
 *     tests and for the offline demonstration. Never Qloo data.
 *
 * A live scoring run carries no provenance of this kind: it is neither
 * replayed nor recorded, and the surface labels it from the capture's own
 * `cache` status instead.
 */
export type ReplayKind = "recorded_qloo" | "synthetic";

export type ReplayProvenance = {
  kind: ReplayKind;
  /** Retrieval time for recorded evidence; authoring time for synthetic. */
  captured_at: string;
};

/** One replayable comparison: the concept it belongs to and its evidence. */
export type AuditionReplay = {
  provenance: ReplayProvenance;
  title: string;
  concept: string;
  /** How the comps were chosen. A creative note, never a Qloo claim. */
  selection: string;
  result: ScoreResponse;
};
