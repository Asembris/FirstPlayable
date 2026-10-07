import Link from 'next/link';
import { savedAuditionResult, SAVED_AUDITION } from '@/presentation/saved-audition';

/** Public entry: every specimen position comes from the saved deterministic result. */
export function AudienceLanding(): React.ReactElement {
  const result = savedAuditionResult();
  const movies = result.domains.movie!;
  const pair = movies.comparison.pairs.find((p) => p.verdict === 'reversal')!;
  const names = new Map(movies.comps.map((c) => [c.entity_id, c.name]));
  return (
    <div className="rt rt-landing">
      <header className="rt-topbar rt-topbar--landing">
        <div className="rt-topbar__left"><Link href="/" className="rt-wordmark" aria-current="page">FirstPlayable</Link></div>
        <div className="rt-topbar__centre" />
        <div className="rt-topbar__right rt-topbar__note">No sign-in needed</div>
      </header>
      <main className="rt-landing__stage">
        <div className="rt-landing__hero">
          <p className="rt-label rt-landing__eyebrow">Audience comp audition</p>
          <h1 className="rt-hero"><span className="rt-hero__line">Choose the comps.</span>{' '}<span className="rt-hero__line">Switch the audience.</span>{' '}<em className="rt-hero__line">See what changes.</em></h1>
          <p className="rt-landing__lede">For game creators: you choose the comps that represent your project. FirstPlayable shows how Qloo’s taste data orders those same titles for different artist audiences.</p>
        </div>
        <nav className="rt-doors" aria-labelledby="rt-doors-heading">
          <h2 id="rt-doors-heading" className="rt-label rt-doors__heading">Start with the comparison</h2>
          <ol className="rt-doors__list">
            <li><Link href="/audition" className="rt-door" data-testid="rt-door-play">
              <span className="rt-door__num" aria-hidden="true">01</span>
              <span className="rt-door__label">Switch the audience</span>
              <span className="rt-door__aside"><span className="rt-chip">Saved example · synthetic demonstration</span><span className="rt-door__sub">Opens instantly · no live calls</span></span>
            </Link></li>
            <li><Link href="/audition?mode=live" className="rt-door" data-testid="rt-door-create">
              <span className="rt-door__num" aria-hidden="true">02</span>
              <span className="rt-door__label">Try your own</span>
              <span className="rt-door__aside"><span className="rt-door__sub">Choose comps · confirm identities · compare audiences</span></span>
            </Link></li>
          </ol>
        </nav>
        <aside className="rt-landing__margin" aria-label="From the saved example">
          <figure className="rt-specimen" data-testid="rt-specimen">
            <figcaption className="rt-label rt-specimen__eyebrow">From the saved example</figcaption>
            <p className="rt-specimen__title">{SAVED_AUDITION.title}</p>
            <p className="rt-specimen__lede">Same movie comps. Different audience.</p>
            <div className="rt-specimen__split">
              {movies.comparison.rankings.map((ranking, index) => <div key={ranking.audience_entity_id} className={`rt-specimen__cell ${index === 1 ? 'rt-specimen__cell--with' : ''}`}>
                <p className="rt-specimen__tag">{ranking.audience_name} fans</p>
                {ranking.ordered.map((row) => <p key={row.entity_id} className="rt-specimen__label">{row.position}. {row.name}</p>)}
              </div>)}
            </div>
            <p className="rt-specimen__coda">{names.get(pair.a)} / {names.get(pair.b)}: reversed. Movies and games are compared separately.</p>
          </figure>
        </aside>
      </main>
    </div>
  );
}
