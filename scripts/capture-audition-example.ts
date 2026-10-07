/** Fixed identities, one evidence run. Never part of a gate. */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { searchComps, resolveArtist, scoreComps } from '../src/server/qloo/client';
import { compareAudiences } from '../src/domain/audition-compare';
function redactResponse(body: any): unknown {
  const pick = (value: any, keys: string[]) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
  if (Array.isArray(body.results)) return { ...pick(body, ['success']), results: body.results.map((entity: any) => ({
    ...pick(entity, ['name', 'entity_id', 'types', 'disambiguation']),
    properties: pick(entity.properties, ['release_year', 'release_date', 'short_description', 'external']),
  })) };
  return { ...pick(body, ['success']), results: { entities: body.results.entities.map((entity: any) => pick(entity, ['name', 'entity_id', 'type', 'subtype', 'query'])) } };
}
async function main() {
  if (process.env.RUN_AUDITION_CAPTURE !== '1') throw new Error('Set RUN_AUDITION_CAPTURE=1 explicitly.');
  try { process.loadEnvFile('.env.local'); } catch {}
  try { process.loadEnvFile('.env'); } catch {}
  const destination = 'fixtures/qloo/audition/canonical.json';
  if (existsSync(destination) || existsSync('fixtures/qloo/audition/selection.json')) throw new Error('Selection already exists; refusing to resample.');
  mkdirSync('fixtures/qloo/audition', { recursive: true });
  const raw: { request: string; retrieved_at: string; sha256: string; response: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const response = await fetch(input, init);
    const body = await response.clone().text();
    raw.push({ request: String(input), retrieved_at: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex'), response: redactResponse(JSON.parse(body)) });
    return response;
  };
  const deps = { fetchImpl };
  const choices = [
    ['movie', 'Moon', 2009], ['movie', 'Arrival', 2016], ['movie', 'Interstellar', 2014],
    ['videogame', 'Outer Wilds', 2019], ['videogame', 'Death Stranding', 2019], ['videogame', 'Mass Effect', 2007],
  ] as const;
  const comps = [];
  for (const [domain, query, year] of choices) {
    const { snapshot } = await searchComps(domain, query, deps);
    const candidate = snapshot.candidates.find((c) => c.name.toLowerCase() === query.toLowerCase() && c.year === year);
    if (!candidate) throw new Error(`Exact identity not found: ${query} (${year}).`);
    comps.push({ ...candidate, slot_id: `s${comps.length + 1}`, search_capture_id: randomUUID(), search: snapshot });
    console.log(`Confirmed ${candidate.name} (${candidate.year}) ${candidate.entity_id}`);
  }
  const audiences: (Awaited<ReturnType<typeof resolveArtist>>['snapshot']['candidates'][number] & { slot_id: string; search_capture_id: string; search: Awaited<ReturnType<typeof resolveArtist>>['snapshot'] })[] = [];
  for (const query of ['Radiohead', 'Kendrick Lamar']) {
    const { snapshot } = await resolveArtist(query, deps);
    const candidate = snapshot.candidates.find((c) => c.name.toLowerCase() === query.toLowerCase());
    if (!candidate) throw new Error(`Exact artist not found: ${query}`);
    audiences.push({ ...candidate, slot_id: `s${audiences.length + 7}`, search_capture_id: randomUUID(), search: snapshot });
  }
  writeFileSync('fixtures/qloo/audition/selection.json', JSON.stringify({ choices, comps, audiences, frozen_at: new Date().toISOString(), policy: 'One fixed candidate set; one audience pair; no selection probe or resampling.' }, null, 2) + '\n');
  const captures = [];
  for (const domain of ['movie', 'videogame'] as const) {
    const selected = comps.filter((c) => c.domain === domain);
    for (const audience of audiences) {
      const { capture } = await scoreComps({ domain, audienceEntityId: audience.entity_id, candidateEntityIds: selected.map((c) => c.entity_id) }, deps);
      captures.push({ ...capture, capture_id: randomUUID(), cache: 'live' as const });
    }
    const scores = captures.filter((c) => c.domain === domain).map((c, i) => ({ audience_entity_id: c.audience_entity_id, audience_name: audiences[i]!.name, domain, affinities: new Map(c.scores.map((s) => [s.entity_id, s.affinity])) }));
    const comparison = compareAudiences(domain, selected, scores[0]!, scores[1]!);
    console.log(domain, JSON.stringify({ ranks: comparison.rankings.map((r) => r.ordered.map((x) => [x.name, x.affinity])), verdicts: comparison.pairs.map((p) => p.verdict) }));
  }
  writeFileSync(destination, JSON.stringify({ title: 'The Last Signal', concept: 'A small exploration game: decode a signal from an abandoned orbital station, deliver its final message, and piece together who sent it.', selection: 'Creator-selected comps for isolation, first contact, exploration and a journey through space. These are creative references, not Qloo project-fit claims.', comps, audiences, captures, raw, provider_calls: raw.length, captured_at: new Date().toISOString() }, null, 2) + '\n');
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Capture failed'); process.exitCode = 1; });
