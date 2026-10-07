import type { Metadata } from 'next';
import { AuditionClient } from '@/components/audition/AuditionClient';
import { savedAuditionResult, SAVED_AUDITION } from '@/presentation/saved-audition';
import '../rehearsal/audition.css';
export const metadata: Metadata = { title: 'Audience comp audition · FirstPlayable', description: 'Choose the comps. Switch the audience. See what changes.' };
export default async function AuditionPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const { mode } = await searchParams;
  return <AuditionClient savedResult={savedAuditionResult()} example={SAVED_AUDITION} startLive={mode === 'live'} />;
}
