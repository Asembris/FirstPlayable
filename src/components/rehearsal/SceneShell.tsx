/**
 * The Rehearsal Table's persistent scene shell.
 *
 * One layout for every mode of the scene page. The top bar, world strip,
 * title, band, header rule, row grid, and "In this scene" list are the same
 * elements in Play and in Compare, at the same coordinates; a mode change only
 * swaps what is inside the band, the header rule, the rows, and the footer.
 * That is what lets unchanged things not move.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { Scene } from "../../domain/scene";

export type SceneView = "play" | "compare";

export type SceneShellProps = {
  readonly scene: Scene;
  readonly view: SceneView;
  readonly crumb: string;
  /** Centre of the top bar: the Play | Compare tabs. */
  readonly modes: ReactNode;
  /** Right of the top bar: the version control and the status chip. */
  readonly status: ReactNode;
  /** Shown under the title only where the top bar has no room for `status`. */
  readonly compactStatus?: ReactNode;
  readonly band: ReactNode;
  readonly header: ReactNode;
  readonly rows: ReactNode;
  readonly foot: ReactNode;
  /** The contextual "Why this changed" note, level with the header rule. */
  readonly note?: ReactNode;
  readonly motion?: "on" | "off";
  readonly noteOpen?: boolean;
};

export function SceneShell(props: SceneShellProps): React.ReactElement {
  const { scene } = props;
  const npc = scene.world.characters[0];
  const object = scene.world.object;
  return (
    <div
      className="rt rt-scene"
      data-view={props.view}
      data-motion={props.motion ?? "on"}
      data-note={props.noteOpen === true ? "open" : "closed"}
    >
      <header className="rt-topbar" data-testid="rt-topbar">
        <div className="rt-topbar__left">
          <Link href="/" className="rt-wordmark">
            FirstPlayable
          </Link>
          <span className="rt-topbar__crumb">{props.crumb}</span>
        </div>
        <div className="rt-topbar__centre">{props.modes}</div>
        <div className="rt-topbar__right">{props.status}</div>
      </header>

      <main className="rt-stage">
        <p className="rt-strip" data-testid="rt-strip">
          <span className="rt-label rt-strip__room">{scene.world.room.name}</span>
          <span className="rt-strip__desc">{scene.world.room.description}</span>
        </p>
        <h1 className="rt-title" data-testid="rt-title">
          {scene.title}
        </h1>
        {props.compactStatus === undefined ? null : (
          <div className="rt-compact-status">{props.compactStatus}</div>
        )}

        <div className="rt-band" data-testid="rt-band">
          {props.band}
        </div>
        <div className="rt-head" data-testid="rt-head">
          {props.header}
        </div>
        <div className="rt-rows" data-testid="rt-rows">
          {props.rows}
        </div>
        <div className="rt-foot" data-testid="rt-foot">
          {props.foot}
        </div>

        <aside className="rt-cast" aria-labelledby="rt-cast-heading" data-testid="rt-cast">
          <h2 id="rt-cast-heading" className="rt-label rt-cast__heading">
            In this scene
          </h2>
          <dl className="rt-cast__list">
            <div>
              <dt>{npc.name}</dt>
              <dd>{npc.role}</dd>
            </div>
            <div>
              <dt>{object.name}</dt>
              <dd>{object.description}</dd>
            </div>
            <div>
              <dt>You</dt>
              <dd>{scene.world.player_role}</dd>
            </div>
          </dl>
        </aside>

        <div className="rt-note-anchor">{props.note}</div>
      </main>
    </div>
  );
}
