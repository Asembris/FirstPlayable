import { describe, it, expect } from 'vitest';
import record from '../../fixtures/qloo/audition/canonical.json';
import frozen from '../../fixtures/qloo/audition/selection.json';
import { savedAuditionResult } from '../../src/presentation/saved-audition';
import { domainAuditionView } from '../../src/domain/audition-result';
import { CompScoreCaptureSchema } from '../../src/domain/audition';
import { normalizeCompScores, normalizeCompSearch } from '../../src/server/qloo/audition';
import { normalizeArtistSearch } from '../../src/server/qloo/normalize';

describe('synthetic saved audition', () => {
  it('freezes the same six identities and two audiences before the four final evidence calls', () => {
    expect(record.comps).toEqual(frozen.comps);
    expect(record.audiences).toEqual(frozen.audiences);
    expect(record.provider_calls).toBe(12);
    expect(record.raw).toHaveLength(12);
    expect(record.captures).toHaveLength(4);
    for (const capture of record.captures) {
      expect(Date.parse(capture.retrieved_at)).toBeGreaterThanOrEqual(Date.parse(frozen.frozen_at));
      expect(capture.missing_entity_ids).toEqual([]);
    }
  });
  it('every confirmed identity and affinity re-normalizes from its synthetic raw response', () => {
    for (const comp of record.comps) {
      const raw = record.raw.find((r) => new URL(r.request).searchParams.get('query') === comp.search.query)!;
      const normalized = normalizeCompSearch(raw.response, { domain: comp.domain as 'movie' | 'videogame', query: comp.search.query, requestFingerprint: comp.search.request_fingerprint, retrievedAt: comp.search.retrieved_at });
      expect(normalized).toEqual(comp.search);
      expect(normalized.candidates).toContainEqual({ entity_id: comp.entity_id, name: comp.name, domain: comp.domain, year: comp.year, disambiguation: comp.disambiguation, original_rank: comp.original_rank });
    }
    for (const audience of record.audiences) {
      const raw = record.raw.find((r) => new URL(r.request).searchParams.get('query') === audience.search.query)!;
      const normalized = normalizeArtistSearch(raw.response, { query: audience.search.query, normalizedQuery: audience.search.normalized_query, requestFingerprint: audience.search.request_fingerprint, retrievedAt: audience.search.retrieved_at });
      expect(normalized).toEqual(audience.search);
      expect(normalized.candidates.find((c) => c.entity_id === audience.entity_id)?.name).toBe(audience.name);
    }
    for (const capture of record.captures) {
      const raw = record.raw.find((r) => { const p = new URL(r.request).searchParams; return p.get('signal.interests.entities') === capture.audience_entity_id && p.get('filter.type') === `urn:entity:${capture.domain}`; })!;
      const normalized = normalizeCompScores(raw.response, { domain: capture.domain as 'movie' | 'videogame', audienceEntityId: capture.audience_entity_id, candidateIds: capture.requested_entity_ids, requestFingerprint: capture.request_fingerprint, retrievedAt: capture.retrieved_at });
      const { capture_id: _id, cache: _cache, ...stored } = capture;
      expect(normalized).toEqual(stored);
      expect(raw.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('saved and live-format captures use the identical deterministic projection', () => {
    const saved = savedAuditionResult();
    expect(saved.upstream_calls).toBe(0);
    for (const domain of ['movie', 'videogame'] as const) {
      const view = saved.domains[domain]!;
      const captures = saved.audiences.map((a) => CompScoreCaptureSchema.parse(record.captures.find((c) => c.domain === domain && c.audience_entity_id === a.entity_id)));
      expect(domainAuditionView(domain, view.comps, saved.audiences, [captures[0]!, captures[1]!])).toEqual(view);
    }
    expect(saved.domains.movie!.comparison.pairs.map((p) => p.verdict)).toEqual(['reversal', 'reversal', 'close']);
    expect(saved.domains.videogame!.comparison.pairs.map((p) => p.verdict)).toEqual(['reversal', 'holds', 'close']);
    expect(saved.domains.movie!.comparison.rankings.map((r) => r.ordered.map((c) => c.name))).toEqual([['Quiet Orbit', 'First Hello', 'Farther Than Light'], ['First Hello', 'Farther Than Light', 'Quiet Orbit']]);
    expect(saved.domains.videogame!.comparison.rankings[1].top.status).toBe('close');
  });
  it('rejects a capture for a different audience or candidate set', () => {
    const result = savedAuditionResult(); const view = result.domains.movie!;
    const captures = record.captures.filter((c) => c.domain === 'movie').map((c) => CompScoreCaptureSchema.parse(c));
    expect(() => domainAuditionView('movie', view.comps, result.audiences, [captures[1]!, captures[0]!])).toThrow('Capture identity mismatch');
    expect(() => domainAuditionView('movie', view.comps.slice(1), result.audiences, [captures[0]!, captures[1]!])).toThrow('Capture candidate mismatch');
  });
});

