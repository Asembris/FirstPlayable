/** Real Qloo captures are bundled server-side. Replay makes no provider call. */
import record from '../../fixtures/qloo/audition/canonical.json';
import { CompScoreCaptureSchema } from '../domain/audition';
import { domainAuditionView } from '../domain/audition-result';
import type { ConfirmedEntityView, ScoreResponse } from '../domain/audition-view';
const entityView = (entity: (typeof record.comps)[number] | (typeof record.audiences)[number]): ConfirmedEntityView => ({
  slot_id: entity.slot_id, entity_id: entity.entity_id, name: entity.name,
  search_capture_id: entity.search_capture_id, original_rank: entity.original_rank,
});
export const SAVED_AUDITION = { title: record.title, concept: record.concept, captured_at: record.captured_at };
export function savedAuditionResult(): ScoreResponse {
  const audiences: [ConfirmedEntityView, ConfirmedEntityView] = [entityView(record.audiences[0]!), entityView(record.audiences[1]!)];
  const domains: ScoreResponse['domains'] = { movie: null, videogame: null };
  for (const domain of ['movie', 'videogame'] as const) {
    const comps = record.comps.filter((c) => c.domain === domain).map(entityView);
    const captures = audiences.map((a) => CompScoreCaptureSchema.parse(record.captures.find((c) => c.domain === domain && c.audience_entity_id === a.entity_id)));
    domains[domain] = domainAuditionView(domain, comps, audiences, [captures[0]!, captures[1]!]);
  }
  return { audiences, domains, unconfirmed: [], upstream_calls: 0 };
}
