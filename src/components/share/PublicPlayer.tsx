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
 * Phase 6 sets it as the Rehearsal Table's public player, designed for a phone
 * first: the room strip, the title, and the scene as a play script with ruled
 * action rows. No tabs, no version control, no marks. Only when the creator
 * chose to include it, the approved source chain follows the scene, set in the
 * four causal materials; its fourth line is the engine's own witness sentence.
 * A revoked or unknown link produces one clean unavailable screen that reveals
 * nothing about whether the link ever existed.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PublicReadResponse, PublicSnapshot } from "@/domain/publish";
import { PUBLIC_UNAVAILABLE_MESSAGE } from "@/domain/publish";
import { labelActionIds } from "@/presentation/revision";
import { shortVersion, whenLabel } from "@/presentation/share";
import { ScenePlayer } from "../player/ScenePlayer";

type State =
  | { status: "loading" }
  | { status: "loaded"; snapshot: PublicSnapshot; publishedAt: string }
  | { status: "unavailable" };

const DOMAIN_NAME: Readonly<Record<string, string>> = {
  movie: "film",
  videogame: "video game",
};

function PublicPage({ testId, children }: { testId?: string; children: ReactNode }) {
  return (
    <div className="rt rt-public" data-testid={testId}>
      <header className="rt-topbar rt-topbar--public">
        <div className="rt-topbar__left">
          <span className="rt-wordmark">FirstPlayable</span>
          <span className="rt-topbar__crumb">Shared playable</span>
        </div>
        <div className="rt-topbar__centre" />
        <div className="rt-topbar__right rt-topbar__note">Play only</div>
      </header>
      <main className="rt-public__stage">{children}</main>
    </div>
  );
}

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
      <PublicPage>
        <p className="rt-studio__note rt-public__loading" aria-live="polite">
          Loading this playable…
        </p>
      </PublicPage>
    );
  }

  if (state.status === "unavailable") {
    return (
      <PublicPage>
        <section className="rt-public__gone">
          <h1 className="rt-public__title rt-public__title--gone">{PUBLIC_UNAVAILABLE_MESSAGE}</h1>
          <p className="rt-public__lede" data-testid="public-unavailable">
            This link is not available. It may have been withdrawn by whoever made
            it, or it may never have existed.
          </p>
          <div className="rt-public__links">
            <Link className="rt-button rt-button--primary" href="/example">
              Play the saved example
            </Link>
          </div>
        </section>
      </PublicPage>
    );
  }

  const { snapshot } = state;
  const world = snapshot.scene.world;
  return (
    <PublicPage testId="public-player">
      <p className="rt-strip rt-public__strip">
        <span className="rt-label rt-strip__room">{world.room.name}</span>
        <span className="rt-strip__desc">{world.room.description}</span>
      </p>
      <h1 className="rt-public__title" data-testid="public-title">
        {snapshot.title}
      </h1>
      <p className="rt-public__meta">
        One fixed version · shared {whenLabel(state.publishedAt)} · every choice runs in your
        browser
      </p>

      <div className="rt-player rt-public__player">
        <ScenePlayer scene={snapshot.scene} testIdPrefix="public" />
      </div>

      {snapshot.provenance_included && snapshot.provenance.length > 0 ? (
        <section
          className="rt-public__sources"
          data-testid="public-provenance"
          aria-labelledby="public-sources-heading"
        >
          <h2 className="rt-label rt-public__sources-heading" id="public-sources-heading">
            Where these ideas came from
          </h2>
          <ul className="rt-public__chains">
            {snapshot.provenance.map((line) => (
              <li
                key={line.approval_id}
                className="rt-public__chain"
                data-testid={`public-provenance-${line.slot}`}
              >
                {line.retrieved === null ? null : (
                  <div className="rt-public__layer">
                    <p className="rt-label rt-public__layer-label">Source · Qloo returned</p>
                    <p className="rt-public__slip">
                      {line.retrieved.reference_name} ·{" "}
                      {DOMAIN_NAME[line.retrieved.domain] ?? line.retrieved.domain}
                    </p>
                  </div>
                )}
                {line.proposed === null ? null : (
                  <div className="rt-public__layer">
                    <p className="rt-label rt-public__layer-label">
                      Suggestion · FirstPlayable proposed
                    </p>
                    <p className="rt-suggestion">{line.proposed}</p>
                  </div>
                )}
                <div className="rt-public__layer">
                  <p className="rt-label rt-public__layer-label rt-public__layer-label--ink">
                    Decision · the creator approved
                    {line.approved.edited_by_creator ? ", after editing it" : ""}
                  </p>
                  <p className="rt-decision">{line.approved.text}</p>
                </div>
                {line.scene_changed === null ? null : (
                  <div className="rt-public__layer">
                    <p className="rt-label rt-public__layer-label">
                      Consequence · the engine observed
                    </p>
                    <p className="rt-public__observed">
                      {labelActionIds(line.scene_changed, [snapshot.scene])}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="rt-studio__note">
            The last line of each chain is the engine&rsquo;s own observation from
            replaying this version against the same version without that
            influence. It says what changed, not that it is better or that it
            could only have been reached this way.
          </p>
        </section>
      ) : null}

      <footer className="rt-public__foot">
        <p className="rt-public__made">Made with FirstPlayable · play only</p>
        <div className="rt-public__links">
          <Link className="rt-button" href="/example">
            Play the saved example
          </Link>
          <Link className="rt-button" href="/studio">
            Make your own
          </Link>
        </div>
        <details className="rt-record-details">
          <summary>About this link</summary>
          <p>
            This link names one fixed version and never changes to a newer one. Version{" "}
            <span className="rt-record-id" data-testid="public-version-id">
              {shortVersion(snapshot.version_id)}
            </span>
            . Playing it makes no request after this page has loaded.
          </p>
        </details>
      </footer>
    </PublicPage>
  );
}
