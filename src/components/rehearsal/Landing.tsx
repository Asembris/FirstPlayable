/**
 * The judge-facing entry. Two doors styled as action rows, and a specimen of
 * the synthetic demonstration comparison in the margin. Every specimen string is read from the
 * canonical pair.
 */

import Link from "next/link";
import { CANONICAL_PAIR } from "../../presentation/canonical-pair";
import { compareAt, numberWord, requirementsOf, runChoices } from "../../presentation/rehearsal";

const pair = CANONICAL_PAIR;

function Specimen(): React.ReactElement | null {
  const witness = pair.causal.witness;
  if (witness === null) return null;
  const comparison = compareAt(pair, witness.prefix);
  const row = comparison.rows.find((candidate) => candidate.id === witness.actionId);
  if (row === undefined || row.kind === "unchanged") return null;
  const needs =
    row.with.status === "locked"
      ? requirementsOf(pair.withScene, runChoices(pair.withScene, witness.prefix).state, row.id).length
      : 0;
  const reading = (status: string) =>
    status === "enabled" ? "Open" : status === "locked" ? "Locked" : "Not in this version";
  return (
    <figure className="rt-specimen" data-testid="rt-specimen">
      <figcaption className="rt-label rt-specimen__eyebrow">From the saved example</figcaption>
      <p className="rt-specimen__title">{pair.withScene.title}</p>
      <p className="rt-specimen__lede">After the same {numberWord(witness.prefix.length)} choices:</p>
      <div className="rt-specimen__split">
        <div className="rt-specimen__cell">
          <p className="rt-specimen__tag">Without</p>
          <p className="rt-specimen__label">{row.label}</p>
          <p className="rt-specimen__note">{reading(row.without.status)}</p>
        </div>
        <div className="rt-specimen__cell rt-specimen__cell--with">
          <span className="rt-specimen__mark" aria-hidden="true">
            *
          </span>
          <p className="rt-specimen__tag">With {pair.influenceName}</p>
          <p className="rt-specimen__label">{row.label}</p>
          <p className="rt-specimen__note">
            {reading(row.with.status)}
            {needs > 0 && row.without.status === "enabled"
              ? ` · ${needs} new requirement${needs === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
      </div>
      {comparison.sameWorld ? (
        <p className="rt-specimen__coda">
          Same room. Same {pair.withScene.world.characters[0].name}. Same{" "}
          {lastWord(pair.withScene.world.object.name)}. One approved influence changed what you
          can do.
        </p>
      ) : null}
    </figure>
  );
}

function lastWord(text: string): string {
  const words = text.trim().split(/\s+/);
  return (words[words.length - 1] ?? text).toLowerCase();
}

export function Landing(): React.ReactElement {
  return (
    <div className="rt rt-landing">
      <header className="rt-topbar rt-topbar--landing">
        <div className="rt-topbar__left">
          <Link href="/" className="rt-wordmark" aria-current="page">
            FirstPlayable
          </Link>
        </div>
        <div className="rt-topbar__centre" />
        <div className="rt-topbar__right rt-topbar__note">No sign-in needed</div>
      </header>

      <main className="rt-landing__stage">
        <div className="rt-landing__hero">
          <p className="rt-label rt-landing__eyebrow">A rehearsal table for playable scenes</p>
          <h1 className="rt-hero">
            <span className="rt-hero__line">Choose the influences.</span>{" "}
            <em className="rt-hero__line">Play the consequences.</em>
          </h1>
          <p className="rt-landing__lede">
            For narrative-game creators: test a cultural influence as a playable variation of
            your scene. Play it with and without, see exactly which choices it changed, then
            decide whether to keep it.
          </p>
        </div>

        <nav className="rt-doors" aria-labelledby="rt-doors-heading">
          <h2 id="rt-doors-heading" className="rt-label rt-doors__heading">
            What do you do?
          </h2>
          <ol className="rt-doors__list">
            <li>
              <Link href="/difference" className="rt-door" data-testid="rt-door-play">
                <span className="rt-door__num" aria-hidden="true">
                  01
                </span>
                <span className="rt-door__label">Play the difference</span>
                <span className="rt-door__aside">
                  <span className="rt-chip">Saved example · synthetic demonstration</span>
                  <span className="rt-door__sub">Plays instantly · nothing is generated live</span>
                </span>
              </Link>
            </li>
            <li>
              <Link href="/studio" className="rt-door" data-testid="rt-door-create">
                <span className="rt-door__num" aria-hidden="true">
                  02
                </span>
                <span className="rt-door__label">Create your scene</span>
                <span className="rt-door__aside">
                  <span className="rt-door__sub">Brief · artist · influences · build · review</span>
                </span>
              </Link>
            </li>
          </ol>
        </nav>

        <aside className="rt-landing__margin" aria-label="From the saved example">
          <Specimen />
        </aside>
      </main>
    </div>
  );
}
