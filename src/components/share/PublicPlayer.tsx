"use client";

/**
 * The public share view (specification sections 3 and 13).
 *
 * It lives in `src/components/share/` rather than beside the renderer, and that
 * is a boundary rather than filing: `src/components/player/` is the trusted
 * renderer and a test asserts it contains no `fetch` at all. This component is
 * the one same-origin read that loads a published snapshot; once it has, every
 * choice runs through the same network-free {@link ScenePlayer} the studio uses.
 *
 * It is a *reader*. There is no control here that could mutate anything: no
 * build, no revise, no approve, no publish, no revoke, no export, and no link to
 * the owner's project — not because they are hidden, but because this component
 * renders a {@link PublicSnapshot}, which has no field for a project id, an
 * owner, a brief, a premise, an artist query, a proposal draft, a rejected idea,
 * a capture, or a token. The one request it makes is the read that loaded it.
 *
 * What it shows: the title, the stage, replay, and — only when the creator chose
 * to include it — the approved source chain, whose fourth line is the engine's
 * own witness sentence. A revoked or unknown link produces one clean
 * unavailable screen that reveals nothing about whether the link ever existed.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PublicReadResponse, PublicSnapshot } from "@/domain/publish";
import { PUBLIC_UNAVAILABLE_MESSAGE } from "@/domain/publish";
import { ScenePlayer } from "../player/ScenePlayer";

type State =
  | { status: "loading" }
  | { status: "loaded"; snapshot: PublicSnapshot; publishedAt: string }
  | { status: "unavailable" };

export function PublicPlayer({ token }: { token: string }): React.JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/public/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setState({ status: "unavailable" });
        return;
      }
      const body = (await response.json()) as PublicReadResponse;
      // Shape-checked rather than trusted: a stored document that no longer
      // carries a scene produces the unavailable screen, not a broken stage.
      if (body?.snapshot?.scene === undefined) {
        setState({ status: "unavailable" });
        return;
      }
      setState({
        status: "loaded",
        snapshot: body.snapshot,
        publishedAt: body.published_at,
      });
    } catch {
      setState({ status: "unavailable" });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <main className="studio">
        <p className="studio__note" aria-live="polite">
          Loading this playable…
        </p>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="studio">
        <h1 className="cover__title">{PUBLIC_UNAVAILABLE_MESSAGE}</h1>
        <p className="cover__lede" data-testid="public-unavailable">
          This link is not available. It may have been withdrawn by whoever made
          it, or it may never have existed.
        </p>
        <div className="studio__actions">
          <Link className="button button--primary" href="/example">
            Play the saved example
          </Link>
        </div>
      </main>
    );
  }

  const { snapshot } = state;
  return (
    <main className="studio" data-testid="public-player">
      <header className="studio__header">
        <p className="cover__eyebrow">Shared playable · read-only</p>
        <h1 className="cover__title" data-testid="public-title">
          {snapshot.title}
        </h1>
        <p className="studio__hint">
          Version <span data-testid="public-version-id">{snapshot.version_id}</span> ·
          shared {state.publishedAt}. This link names one fixed version; it never
          changes to a newer one.
        </p>
        <p className="studio__hint">
          Every choice below runs in your browser. Playing this costs no request
          after this page has loaded.
        </p>
      </header>

      <ScenePlayer scene={snapshot.scene} testIdPrefix="public" />

      {snapshot.provenance_included && snapshot.provenance.length > 0 ? (
        <section className="panel" data-testid="public-provenance">
          <h2 className="panel__heading">Where these ideas came from</h2>
          <ul className="panel__list">
            {snapshot.provenance.map((line) => (
              <li key={line.approval_id} data-testid={`public-provenance-${line.slot}`}>
                <span className="chip">{line.slot}</span>{" "}
                {line.retrieved === null ? null : (
                  <span className="studio__hint">
                    {line.retrieved.reference_name} · {line.retrieved.domain}
                  </span>
                )}
                {line.proposed === null ? null : (
                  <p className="line__text">
                    FirstPlayable proposed: {line.proposed}
                  </p>
                )}
                <p className="line__text">
                  The creator approved
                  {line.approved.edited_by_creator ? ", after editing it" : ""}:{" "}
                  {line.approved.text}
                </p>
                {line.scene_changed === null ? null : (
                  <p className="studio__hint">{line.scene_changed}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="studio__hint">
            The last line of each chain is the engine&rsquo;s own observation from
            replaying this version against the same version without that
            influence. It says what changed, not that it is better or that it
            could only have been reached this way.
          </p>
        </section>
      ) : null}

      <div className="studio__actions">
        <Link className="button" href="/example">
          Play the saved example
        </Link>
        <Link className="button" href="/studio">
          Make your own
        </Link>
      </div>
    </main>
  );
}
