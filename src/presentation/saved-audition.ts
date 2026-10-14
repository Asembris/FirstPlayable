/**
 * The SYNTHETIC audition replay, kept for tests and for `/audition?mode=synthetic`.
 *
 * Every title, artist, entity id, affinity and timestamp in
 * `fixtures/qloo/audition/canonical.json` is invented and written in Qloo's
 * response shapes. None of it was returned by Qloo. The real recorded
 * comparison, which is what `/audition` serves by default, is
 * `recorded-audition.ts`.
 *
 * Replay makes no provider call. The comparison and the decision come from the
 * same production functions the live path uses.
 */
import record from '../../fixtures/qloo/audition/canonical.json';
import { CompScoreCaptureSchema } from '../domain/audition';
import { decideForeground } from '../domain/audition-decision';
import { domainAuditionView } from '../domain/audition-result';
import type { AuditionReplay, ConfirmedEntityView, ScoreResponse } from '../domain/audition-view';
const entityView = (entity: (typeof record.comps)[number] | (typeof record.audiences)[number]): ConfirmedEntityView => ({
  slot_id: entity.slot_id, entity_id: entity.entity_id, name: entity.name,
  search_capture_id: entity.search_capture_id, original_rank: entity.original_rank,
});
export function savedAuditionResult(): ScoreResponse {
  const audiences: [ConfirmedEntityView, ConfirmedEntityView] = [entityView(record.audiences[0]!), entityView(record.audiences[1]!)];
  const domains: ScoreResponse['domains'] = { movie: null, videogame: null };
  for (const domain of ['movie', 'videogame'] as const) {
    const comps = record.comps.filter((c) => c.domain === domain).map(entityView);
    const captures = audiences.map((a) => CompScoreCaptureSchema.parse(record.captures.find((c) => c.domain === domain && c.audience_entity_id === a.entity_id)));
    domains[domain] = domainAuditionView(domain, comps, audiences, [captures[0]!, captures[1]!]);
  }
  // A fixed example question, answered by the same deterministic code as the live path.
  const decision = decideForeground({ action: 'foreground_comp', domain: 'movie', audience_slot_id: audiences[0].slot_id }, domains.movie, audiences[0]);
  return { audiences, domains, unconfirmed: [], decision, upstream_calls: 0 };
}
/** The synthetic replay, labelled as synthetic wherever it is shown. */
export function syntheticAuditionReplay(): AuditionReplay {
  return {
    provenance: { kind: 'synthetic', captured_at: record.captured_at },
    title: record.title,
    concept: record.concept,
    selection: record.selection,
    result: savedAuditionResult(),
  };
}
