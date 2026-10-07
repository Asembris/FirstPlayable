import { compareAudiences } from './audition-compare';
import type { CompScoreCapture } from './audition';
import type { ConfirmedEntityView, DomainAuditionView } from './audition-view';
import { QLOO_DOMAIN_FILTER_TYPE, type QlooDomain } from './qloo';

/** Shared projection for live captures and saved captures. No ordering in the UI. */
export function domainAuditionView(domain: QlooDomain, comps: ConfirmedEntityView[], audiences: [ConfirmedEntityView, ConfirmedEntityView], captures: [CompScoreCapture, CompScoreCapture]): DomainAuditionView {
  for (const [index, capture] of captures.entries()) {
    if (capture.domain !== domain || capture.audience_entity_id !== audiences[index]!.entity_id) throw new Error('Capture identity mismatch');
    const expected = comps.map((c) => c.entity_id).sort();
    if (JSON.stringify([...capture.requested_entity_ids].sort()) !== JSON.stringify(expected)) throw new Error('Capture candidate mismatch');
  }
  const scores = captures.map((capture, index) => ({
    domain: capture.domain, audience_entity_id: capture.audience_entity_id, audience_name: audiences[index]!.name,
    affinities: new Map(capture.scores.map((score) => [score.entity_id, score.affinity])),
  }));
  return {
    domain, comps,
    comparison: compareAudiences(domain, comps.map((c) => ({ ...c, domain })), scores[0]!, scores[1]!),
    evidence: captures.map((capture) => ({
      audience_entity_id: capture.audience_entity_id, capture_id: capture.capture_id,
      retrieved_at: capture.retrieved_at, cache: capture.cache,
      request: `GET /v2/insights?filter.type=${QLOO_DOMAIN_FILTER_TYPE[domain]}&signal.interests.entities=${capture.audience_entity_id}&filter.results.entities=${capture.requested_entity_ids.join(',')}&take=${capture.requested_entity_ids.length}`,
      missing_entity_ids: capture.missing_entity_ids,
    })),
  };
}
