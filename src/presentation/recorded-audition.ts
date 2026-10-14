/**
 * The recorded Qloo comparison behind the default `/audition` experience.
 *
 * This is **real Qloo evidence**, retrieved once on 7 October 2026 through the
 * production client in `src/server/qloo/`, normalized by the production
 * normalizers, and then stored under `evidence/qloo/audition/`. Replaying it
 * makes no provider call, needs no credential, and touches no database, so the
 * default demo opens instantly and offline — but every entity id, every title
 * and every affinity below is the value Qloo returned.
 *
 * What this module may not do, and structurally cannot:
 *
 *   * **Invent or adjust evidence.** Nothing here writes an affinity, a rank
 *     or a winner. The record is read, validated, and handed to the same
 *     `domainAuditionView` -> `compareAudiences` -> `decideForeground` path a
 *     live scoring run uses. No ordering, verdict or decision is stored.
 *   * **Serve a tampered record.** The record carries a SHA-256 over its own
 *     canonical contents. It is recomputed on load, and every capture is
 *     re-checked against the confirmed identities: a changed affinity, a
 *     renamed title, a swapped audience or an added row fails the load with
 *     {@link RecordedEvidenceError} rather than rendering.
 *
 * Raw Qloo response bodies are deliberately **not** part of the record. Only
 * the normalized identity and affinity evidence this product displays is
 * stored, plus the SHA-256 of each original wire body as provenance. See
 * `evidence/qloo/audition/README.md`.
 */

import record from "../../evidence/qloo/audition/recorded-2026-10-07.json";
import {
  AUDITION_NORMALIZER_VERSION,
  type CompScoreCapture,
  CompScoreCaptureSchema,
  DecisionRequestSchema,
} from "../domain/audition";
import { decideForeground } from "../domain/audition-decision";
import { domainAuditionView } from "../domain/audition-result";
import type { AuditionReplay, ConfirmedEntityView, ScoreResponse } from "../domain/audition-view";
import { QLOO_DOMAINS, type QlooDomain } from "../domain/qloo";
import { hashCanonical } from "../engine/hash";

export class RecordedEvidenceError extends Error {
  constructor(detail: string) {
    super(`RECORDED_EVIDENCE_REFUSED: ${detail}`);
    this.name = "RecordedEvidenceError";
  }
}

function insist(condition: boolean, detail: string): void {
  if (!condition) throw new RecordedEvidenceError(detail);
}

/** The record as imported, with its own digest set aside. */
const { content_digest: DIGEST, ...CONTENTS } = record;

/**
 * How many decimals of a returned affinity the digest covers.
 *
 * Qloo returns affinities at full double precision (sixteen significant
 * digits). A bundler is entitled to re-emit such a literal as the nearest
 * double it round-trips to, and Turbopack does: the last unit in the last
 * place of `0.9277100856231865` arrives in the browser bundle as
 * `0.9277100856231864`. A digest over the raw doubles would therefore pass
 * under the test runner and fail in the built application, for a difference
 * twelve orders of magnitude below the 0.03 display threshold.
 *
 * So the digest pins each affinity to twelve decimals. Anything that could
 * change an ordering, a close call, a reversal or a displayed value — which
 * is shown to three decimals — is far above that and is still caught. The
 * exact returned values stay in the record, and
 * `tests/presentation/recorded-audition.test.ts` pins them there to full
 * precision, where it reads the file rather than a bundle.
 */
const DIGEST_DECIMALS = 12;

/**
 * What the digest is taken over: the whole record, with every affinity
 * rendered at {@link DIGEST_DECIMALS}. Nothing else is transformed.
 */
export function evidenceDigest(contents: Omit<typeof record, "content_digest">): string {
  return hashCanonical({
    ...contents,
    captures: contents.captures.map((row) => ({
      ...row,
      capture: {
        ...row.capture,
        scores: row.capture.scores.map((score) => ({
          ...score,
          affinity: score.affinity === null ? null : score.affinity.toFixed(DIGEST_DECIMALS),
        })),
      },
    })),
  });
}

/**
 * The integrity gate. It runs once, at module load, before any view exists.
 *
 * The digest covers every field of the record except the digest itself, so it
 * fails on any edit at all — including one that would leave every shape valid,
 * such as nudging a single affinity to manufacture a reversal.
 */
function verifiedRecord(): typeof record {
  insist(record.evidence === "recorded_qloo", "the record does not declare recorded Qloo evidence");
  insist(
    record.schema === "firstplayable-recorded-audition-1",
    `unknown record schema ${record.schema}`,
  );
  insist(
    record.normalizer_version === AUDITION_NORMALIZER_VERSION,
    `the record was normalized by ${record.normalizer_version}, not ${AUDITION_NORMALIZER_VERSION}`,
  );
  const recomputed = evidenceDigest(CONTENTS);
  insist(recomputed === DIGEST, "the recorded evidence digest does not match its contents");
  insist(record.audiences.length === 2, "a comparison needs exactly two audiences");
  insist(record.comps.length > 0, "the record carries no confirmed comps");
  insist(
    record.captures.length === record.audiences.length * QLOO_DOMAINS.length,
    "one insights capture per audience and domain is required",
  );
  return record;
}

const VERIFIED = verifiedRecord();

function entityView(entity: {
  slot_id: string;
  entity_id: string;
  name: string;
  search_capture_id: string;
  original_rank: number;
}): ConfirmedEntityView {
  return {
    slot_id: entity.slot_id,
    entity_id: entity.entity_id,
    name: entity.name,
    search_capture_id: entity.search_capture_id,
    original_rank: entity.original_rank,
  };
}

/**
 * One stored insights capture, in the exact shape a live capture has.
 *
 * `cache` is `cached` because this is a stored capture being read back, which
 * is what the live path reports in the same situation. The surface labels the
 * replay as recorded Qloo evidence from the provenance, not from this field.
 */
function storedCapture(
  domain: QlooDomain,
  audienceEntityId: string,
  names: ReadonlyMap<string, string>,
): CompScoreCapture {
  const matches = VERIFIED.captures.filter(
    (row) => row.capture.domain === domain && row.capture.audience_entity_id === audienceEntityId,
  );
  insist(matches.length === 1, `expected exactly one ${domain} capture per audience`);
  const row = matches[0]!;
  const parsed = CompScoreCaptureSchema.safeParse({
    ...row.capture,
    capture_id: row.capture_id,
    cache: "cached",
  });
  if (!parsed.success) throw new RecordedEvidenceError(`a stored ${domain} capture is malformed`);
  const value = parsed.data;
  insist(
    value.normalizer_version === AUDITION_NORMALIZER_VERSION,
    `a ${domain} capture names another normalizer`,
  );
  // Qloo's own names, checked against the identity the creator confirmed. A
  // score whose title drifted from its confirmed entity is refused, not shown.
  for (const score of value.scores) {
    insist(names.get(score.entity_id) === score.name, `a ${domain} score renames a confirmed comp`);
    insist(
      value.requested_entity_ids.includes(score.entity_id),
      `a ${domain} capture scored an entity it did not request`,
    );
  }
  const scored = new Set(value.scores.map((score) => score.entity_id));
  insist(
    value.missing_entity_ids.every((id) => !scored.has(id)) &&
      value.requested_entity_ids.every(
        (id) => scored.has(id) || value.missing_entity_ids.includes(id),
      ),
    `the ${domain} capture's missing ids disagree with its scores`,
  );
  return value;
}

/** The recorded comparison, derived entirely by the production functions. */
export function recordedAuditionResult(): ScoreResponse {
  const audiences: [ConfirmedEntityView, ConfirmedEntityView] = [
    entityView(VERIFIED.audiences[0]!),
    entityView(VERIFIED.audiences[1]!),
  ];
  const names = new Map(VERIFIED.comps.map((comp) => [comp.entity_id, comp.name]));
  const domains: ScoreResponse["domains"] = { movie: null, videogame: null };
  for (const domain of QLOO_DOMAINS) {
    const comps = VERIFIED.comps.filter((comp) => comp.domain === domain).map(entityView);
    if (comps.length === 0) continue;
    const captures = audiences.map((audience) =>
      storedCapture(domain, audience.entity_id, names),
    );
    domains[domain] = domainAuditionView(domain, comps, audiences, [captures[0]!, captures[1]!]);
  }
  // One fixed example question, answered by the same deterministic rule as the
  // live path. The record names the question; it cannot name an answer.
  const request = DecisionRequestSchema.parse(VERIFIED.decision_example);
  const asked = audiences.find((audience) => audience.slot_id === request.audience_slot_id);
  insist(asked !== undefined, "the example decision names no recorded audience");
  return {
    audiences,
    domains,
    unconfirmed: [],
    decision: decideForeground(request, domains[request.domain], asked!),
    upstream_calls: 0,
  };
}

export function recordedAuditionReplay(): AuditionReplay {
  return {
    provenance: { kind: "recorded_qloo", captured_at: VERIFIED.retrieval.last_at },
    title: VERIFIED.title,
    concept: VERIFIED.concept,
    selection: VERIFIED.selection,
    result: recordedAuditionResult(),
  };
}

/**
 * The whole gate runs at load, not at render: a record that cannot produce a
 * comparison must never reach a surface, so the capture cross-checks and the
 * example decision are exercised here and the result is discarded.
 */
recordedAuditionResult();

/** Retrieval provenance, for the evidence note and the docs. */
export const RECORDED_AUDITION = {
  provider: VERIFIED.provider.name,
  first_at: VERIFIED.retrieval.first_at,
  last_at: VERIFIED.retrieval.last_at,
  upstream_calls: VERIFIED.retrieval.upstream_calls,
  content_digest: DIGEST,
} as const;
