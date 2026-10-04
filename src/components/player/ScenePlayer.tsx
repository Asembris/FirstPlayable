"use client";

/**
 * A local player for one validated scene.
 *
 * Once the scene JSON has arrived, gameplay is entirely local: every choice,
 * every blocked explanation, every ending, and every reset is a state
 * transition over the same pure Phase 1 engine the server validated the scene
 * with. There is no `fetch` in this file, no provider, no database, and no
 * second interpreter — `availableActions` and `step` are imported from
 * `src/engine/interpreter.ts` exactly as the tests and the validator import
 * them.
 *
 * That is why a complete playthrough after generation costs zero OpenAI calls,
 * zero Qloo calls, and no gameplay server write: there is nothing here that
 * could make one.
 */

import { useCallback, useMemo, useState } from "react";
import type { Id, Scene } from "../../domain/scene";
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

export function ScenePlayer({
  scene,
  testIdPrefix = "scene",
}: {
  scene: Scene;
  /** So a page with two players can address each one in a browser test. */
  testIdPrefix?: string;
}): React.JSX.Element {
  const fresh = useCallback(
    (): Play => ({ state: initialState(scene), transcript: [], endingId: null }),
    [scene],
  );
  const [play, setPlay] = useState<Play>(fresh);
  const [sequence, setSequence] = useState(0);

  const reset = useCallback(() => {
    // A reset is a new run from the initial state. No flag is migrated and no
    // request is made.
    setPlay(fresh());
  }, [fresh]);

  const choices = useMemo(
    () => (play.endingId === null ? availableActions(scene, play.state) : []),
    [scene, play.state, play.endingId],
  );

  /**
   * The ending as the *composed* view has it, not as `core.endings` declares it.
   *
   * A creator ending-copy override replaces one ending's text during
   * composition (`composeScene`), so reading `core.endings` directly would show
   * the wording the override was applied to replace.
   */
  const ending = useMemo(
    () => (play.endingId === null ? null : (viewOf(scene).endingById.get(play.endingId) ?? null)),
    [scene, play.endingId],
  );

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

  return (
    <section className="scene" aria-label="Playable scene">
      <div className="room">
        <h3 className="room__name">{scene.world.room.name}</h3>
        <p className="room__description">{scene.world.room.description}</p>
        <p className="room__role">
          You are the {scene.world.player_role.toLowerCase()}. {npc.name} — {npc.role.toLowerCase()}.
        </p>
      </div>

      <div className="object" data-testid={`${testIdPrefix}-object`}>
        <h4 className="object__name">{scene.world.object.name}</h4>
        <p className="object__description">{scene.world.object.description}</p>
      </div>

      <ol className="transcript" data-testid={`${testIdPrefix}-transcript`}>
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
        <div className="ending" data-testid={`${testIdPrefix}-ending`}>
          <h4 className="ending__title">{ending.title}</h4>
          <p className="line__text">{ending.text}</p>
          <p>
            <button
              type="button"
              className="button button--primary"
              data-testid={`${testIdPrefix}-reset`}
              onClick={reset}
            >
              Play it again
            </button>
          </p>
        </div>
      ) : (
        <div className="choices" data-testid={`${testIdPrefix}-choices`}>
          <h4 className="choices__heading">What do you do?</h4>
          {choices.length === 0 ? (
            <p className="line__text">Nothing is left to do here.</p>
          ) : null}
          {choices.map((choice) => (
            <button
              key={choice.action_id}
              type="button"
              className={`button choice${choice.enabled ? "" : " choice--locked"}`}
              data-testid={`${testIdPrefix}-choice-${choice.action_id}`}
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
          <p>
            <button
              type="button"
              className="button"
              data-testid={`${testIdPrefix}-reset`}
              onClick={reset}
            >
              Start over
            </button>
          </p>
        </div>
      )}
    </section>
  );
}
