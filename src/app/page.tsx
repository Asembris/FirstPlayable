import Link from "next/link";

export default function HomePage() {
  return (
    <main className="cover">
      <p className="cover__eyebrow">FirstPlayable · Phase 1 vertical slice</p>
      <h1 className="cover__title">Choose the influences. Play the consequences.</h1>
      <p className="cover__lede">
        One hand-authored encounter, one creator-approved influence, and the
        mechanical consequence of changing it. Everything on this build runs
        locally: no accounts, no retrieval, no model calls.
      </p>
      <Link className="button button--primary" href="/example">
        Play saved example
      </Link>
      <p className="cover__note">
        Saved example · pre-generated design fixture.
      </p>
    </main>
  );
}
