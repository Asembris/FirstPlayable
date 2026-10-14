import type { Metadata } from 'next';
import { AuditionClient } from '@/components/audition/AuditionClient';
import { recordedAuditionReplay } from '@/presentation/recorded-audition';
import { syntheticAuditionReplay } from '@/presentation/saved-audition';
import '../rehearsal/audition.css';
export const metadata: Metadata = { title: 'Audience comp audition · FirstPlayable', description: 'Choose the comps. Switch the audience. See what changes.' };
/**
 * Three ways in, one comparison engine.
 *
 *   * default — the recorded Qloo comparison: real Qloo identities and
 *     affinities, replayed from `evidence/qloo/`, no provider call.
 *   * `?mode=live` — the creator flow against live Qloo and the model.
 *   * `?mode=synthetic` — the invented demonstration record, for offline
 *     testing. Labelled as synthetic everywhere it appears.
 */
export default async function AuditionPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { mode } = await searchParams;
  const replay = mode === 'synthetic' ? syntheticAuditionReplay() : recordedAuditionReplay();
  return <AuditionClient replay={replay} startLive={mode === 'live'} />;
}
