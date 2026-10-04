"use client";

/**
 * The Phase 1 offline vertical slice.
 *
 * Everything on this page runs in the browser against the same pure engine the
 * tests and the validator use. There is no fetch, no API route, no provider,
 * and no database: switching version, playing, and resetting are local state
 * transitions over the bundled design fixtures.
 */

import { useCallback, useMemo, useState } from "react";
import {
  SECOND_COPY_VERSIONS,
  versionByKey,
} from "../../../fixtures/second-copy";
import type { VersionKey } from "../../../fixtures/second-copy";
import type { Id } from "../../domain/scene";
import { viewOf } from "../../engine/compose";
import {
  availableActions,
  initialState,
  speakerLabel,
  step,
} from "../../engine/interpreter";
import type { State } from "../../engine/interpreter";

type Entry =
  | { kind: "choice"; key: string; label: string }
  | { kind: "line"; key: string; speaker: string; text: string }
  | { kind: "blocked"; key: string; text: string };

type Play = {
  readonly state: State;
  readonly transcript: readonly Entry[];
  readonly endingId: Id | null;
};

export function ExamplePlayer(): React.ReactElement {
  const [versionKey, setVersionKey] = useState<VersionKey>("v1");
  const version = useMemo(() => versionByKey(versionKey), [versionKey]);
  const scene = version.scene;

  const freshPlay = useCallback(
    (): Play => ({ state: initialState(scene), transcript: [], endingId: null }),
    [scene],
  );
  const [play, setPlay] = useState<Play>(freshPlay);
  const [sequence, setSequence] = useState(0);

  const reset = useCallback(() => {
    setPlay(freshPlay());
  }, [freshPlay]);

  const switchVersion = useCallback(
    (key: VersionKey) => {
      // A revision starts a new run; flags are never migrated across versions.
      const next = versionByKey(key);
      setVersionKey(key);
      setPlay({ state: initialState(next.scene), transcript: [], endingId: null });
    },
    [],
  );

  const choices = useMemo(
    () => (play.endingId === null ? availableActions(scene, play.state) : []),
    [scene, play.state, play.endingId],
  );

  // The composed view, so a creator ending-copy override is what shows.
  const ending = useMemo(() => {
    if (play.endingId === null) return null;
    return viewOf(scene).endingById.get(play.endingId) ?? null;
  }, [scene, play.endingId]);

  const take = useCallback(
    (actionId: Id, label: string) => {
      const result = step(scene, play.state, actionId);
      const id = sequence + 1;
      setSequence(id);
      if (!result.ok) {
        setPlay((current) => ({
          ...current,
          transcript: [
            ...current.transcript,
            { kind: "blocked", key: `b${id}`, text: result.message },
          ],
        }));
        return;
      }
      const added: Entry[] = [
        { kind: "choice", key: `c${id}`, label },
        ...result.dialogue.map((line, index) => ({
          kind: "line" as const,
          key: `l${id}-${index}`,
          speaker: speakerLabel(scene, line.speaker_id),
          text: line.text,
        })),
      ];
      setPlay((current) => ({
        state: result.state,
        transcript: [...current.transcript, ...added],
        endingId: result.ending === null ? null : result.ending.id,
      }));
    },
    [scene, play.state, sequence],
  );

  const npc = scene.world.characters[0];
  const influence = scene.influences[0] ?? null;
  const provenance = scene.provenance[0] ?? null;

  return (
    <main className="player">
      <header className="topbar">
        <h1 className="topbar__title">{scene.title}</h1>
        <div className="versions" role="group" aria-label="Version">
          {SECOND_COPY_VERSIONS.map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              className="button version-button"
              data-testid={`version-${candidate.key}`}
              aria-pressed={candidate.key === versionKey}
              onClick={() => switchVersion(candidate.key)}
            >
              {candidate.label}
            </button>
          ))}
          <button
            type="button"
            className="button"
            data-testid="reset"
            onClick={reset}
          >
            Start over
          </button>
        </div>
        <p className="version-note" data-testid="current-version">
          Now playing: <strong>{version.label}</strong> · {version.note} Saved
          example · pre-generated design fixture.
        </p>
      </header>

      <div className="stage">
        <section className="scene" aria-label="Scene">
          <div className="room">
            <h2 className="room__name">{scene.world.room.name}</h2>
            <p className="room__description">{scene.world.room.description}</p>
            <p className="room__role">
              You are the {scene.world.player_role.toLowerCase()}. {npc.name} —{" "}
              {npc.role.toLowerCase()} — is waiting at the counter.
            </p>
          </div>

          <div className="object" data-testid="object">
            <h3 className="object__name">{scene.world.object.name}</h3>
            <p className="object__description">{scene.world.object.description}</p>
          </div>

          <ol className="transcript" data-testid="transcript">
            {play.transcript.map((entry) =>
              entry.kind === "choice" ? (
                <li key={entry.key} className="line line--choice">
                  <p className="line__text">&gt; {entry.label}</p>
                </li>
              ) : entry.kind === "blocked" ? (
                <li key={entry.key} className="line line--blocked">
                  <p className="line__text">{entry.text}</p>
                </li>
              ) : (
                <li key={entry.key} className="line">
                  <span className="line__speaker">{entry.speaker}</span>
                  <p className="line__text">{entry.text}</p>
                </li>
              ),
            )}
          </ol>

          {ending !== null ? (
            <div className="ending" data-testid="ending">
              <h3 className="ending__title">{ending.title}</h3>
              <p className="line__text">{ending.text}</p>
              <p>
                <button type="button" className="button button--primary" onClick={reset}>
                  Play it again
                </button>
              </p>
            </div>
          ) : (
            <div className="choices" data-testid="choices">
              <h3 className="choices__heading">What do you do?</h3>
              {choices.length === 0 ? (
                <p className="line__text">Nothing is left to do here.</p>
              ) : null}
              {choices.map((choice) => (
                <button
                  key={choice.action_id}
                  type="button"
                  className={`button choice${choice.enabled ? "" : " choice--locked"}`}
                  data-testid={`choice-${choice.action_id}`}
                  disabled={!choice.enabled}
                  onClick={() => take(choice.action_id, choice.label)}
                >
                  {choice.enabled ? null : (
                    <span className="choice__lock" aria-hidden="true">
                      {"— "}
                    </span>
                  )}
                  {choice.label}
                  {choice.blocked === null ? null : (
                    <span className="choice__reason">{choice.blocked.text}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="panel" aria-label="Influence">
          <h2 className="panel__heading">Influence</h2>
          {influence === null ? (
            <p className="line__text">
              No influence module is composed in this version. This is the clean
              brief-only foundation.
            </p>
          ) : (
            <>
              <span className="chip">
                {influence.reference_id} · {influence.source_kind}
              </span>
              <p className="line__text">{influence.approved_text}</p>
              <p className="line__text">{influence.intended_effect}</p>
              {provenance === null ? null : (
                <>
                  <h3 className="panel__heading">Where this appears</h3>
                  <ul className="panel__list">
                    {provenance.mechanic_ids.map((id) => (
                      <li key={id}>{id}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <h3 className="panel__heading">Fixed</h3>
          <ul className="panel__list">
            <li>{scene.world.room.name}</li>
            <li>{npc.name}</li>
            <li>{scene.world.object.name}</li>
            <li>Three endings · five verbs</li>
          </ul>
        </aside>
      </div>
    </main>
  );
}
