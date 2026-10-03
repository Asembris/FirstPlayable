import Link from "next/link";

export default function HomePage() {
  return (
    <main className="cover">
      <p className="cover__eyebrow">FirstPlayable · Phase 2 persistent shell</p>
      <h1 className="cover__title">Choose the influences. Play the consequences.</h1>
      <p className="cover__lede">
        One hand-authored encounter, one creator-approved influence, and the
        mechanical consequence of changing it. The saved example is static and
        plays with no database and no model call. Creating your own brief saves
        it against an anonymous owner session in this browser.
      </p>
      <div className="studio__actions">
        <Link className="button button--primary" href="/example">
          Play saved example
        </Link>
        <Link className="button" href="/studio">
          Create your scene
        </Link>
      </div>
      <p className="cover__note">
        Saved example · pre-generated design fixture. No references have been
        retrieved and no scene has been generated on this build.
      </p>
    </main>
  );
}
