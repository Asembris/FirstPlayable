"use client";

/**
 * The saved example on the Rehearsal Table: the real With-Moon / Without-Moon
 * pair, played in the browser against the same pure engine the validator
 * uses. No fetch, no API route, no provider, no database.
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { Id } from "../../domain/scene";
import { CANONICAL_PAIR } from "../../presentation/canonical-pair";
import {
  lineNumber,
  playRows,
  runChoices,
  transcriptOf,
} from "../../presentation/rehearsal";
import type { Side, Taken, TranscriptEntry } from "../../presentation/rehearsal";
import { CausalNote } from "./CausalNote";
import { SceneShell } from "./SceneShell";

const pair = CANONICAL_PAIR;

const SAVED_LABEL = "Saved example · generated from a real build";

function sceneOf(side: Side) {
  return side === "with" ? pair.withScene : pair.withoutScene;
}

function Transcript({ entries }: { entries: readonly TranscriptEntry[] }): React.ReactElement {
  const object = pair.withScene.world.object;
  return (
    <ol className="rt-script" aria-label="What has happened so far" data-testid="rt-transcript">
      {entries.length === 0 ? (
        <li className="rt-script__line rt-script__line--narration">
          <span className="rt-script__cue">Prop</span>
          <span className="rt-script__text">
            {object.name}. {object.description}
          </span>
        </li>
      ) : null}
      {entries.map((entry) => {
        if (entry.kind === "choice") {
          return (
            <li key={entry.key} className="rt-script__line rt-script__line--choice">
              <span className="rt-script__cue">You</span>
              <span className="rt-script__text">
                <span aria-hidden="true">▸ </span>
                {entry.text}
              </span>
            </li>
          );
        }
        if (entry.kind === "ending") {
          return (
            <li key={entry.key} className="rt-script__line rt-script__line--ending">
              <span className="rt-script__cue">End</span>
              <span className="rt-script__text">
                <span className="rt-script__ending-title">{entry.title}</span>
                <span className="rt-script__ending-text">{entry.text}</span>
              </span>
            </li>
          );
        }
        return (
          <li
            key={entry.key}
            className={`rt-script__line${entry.narration ? " rt-script__line--narration" : ""}`}
          >
            <span className="rt-script__cue">{entry.speaker}</span>
            <span className="rt-script__text">{entry.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function RehearsalScene(): React.ReactElement {
  const [side, setSide] = useState<Side>("with");
  const [taken, setTaken] = useState<Taken>({
    choices: pair.recordedPrefix,
    endingActionId: null,
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const uid = useId();

  const scene = sceneOf(side);
  const run = useMemo(() => runChoices(scene, taken.choices), [scene, taken.choices]);
  const transcript = useMemo(() => transcriptOf(scene, taken), [scene, taken]);
  const ended = taken.endingActionId !== null;
  const rows = useMemo(() => (ended ? [] : playRows(scene, run.state)), [ended, scene, run.state]);
  const markedLines = rows.flatMap((row, index) => (row.marked ? [lineNumber(index)] : []));

  const take = useCallback(
    (id: Id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined || !row.enabled) return;
      const result = runChoices(scene, [...taken.choices, id]);
      setNotice("");
      if (result.legal) {
        setTaken({ choices: [...taken.choices, id], endingActionId: null });
      } else {
        // The only legal step that `runChoices` refuses is one that ends the scene.
        setTaken({ choices: taken.choices, endingActionId: id });
      }
    },
    [rows, scene, taken.choices],
  );

  const restart = useCallback(() => {
    setTaken({ choices: [], endingActionId: null });
    setNotice("");
  }, []);

  const switchSide = useCallback(
    (next: Side) => {
      if (next === side) return;
      // Choices are replayed in the other version; flags never migrate.
      const legal = runChoices(sceneOf(next), taken.choices).legal;
      setSide(next);
      setNoteOpen(false);
      setTaken({ choices: legal ? taken.choices : [], endingActionId: null });
      setNotice(
        legal
          ? taken.choices.length > 0
            ? "Same choices, replayed in this version."
            : ""
          : `One of your choices only exists with ${pair.influenceName}, so this version started over.`,
      );
    },
    [side, taken.choices],
  );

  const versions = (
    <div className="rt-seg" role="group" aria-label="Version">
      {(["with", "without"] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          className="rt-seg__option"
          aria-pressed={side === candidate}
          data-testid={`rt-version-${candidate}`}
          onClick={() => switchSide(candidate)}
        >
          {candidate === "with" ? `With ${pair.influenceName}` : "Without"}
        </button>
      ))}
    </div>
  );

  const playFootNote =
    notice !== ""
      ? notice
      : side === "with"
        ? "Lines marked * exist because of the influence you approved. Click one to see why."
        : "Without the influence: no marks, nothing added.";

  return (
    <SceneShell
      scene={pair.withScene}
      view="play"
      crumb="/ saved example"
      noteOpen={noteOpen}
      modes={null}
      status={
        <>
          {versions}
          <span className="rt-chip" data-testid="rt-saved-chip">
            {SAVED_LABEL}
          </span>
        </>
      }
      compactStatus={<span className="rt-chip">{SAVED_LABEL}</span>}
      band={
        <div className="rt-band__play" data-testid="rt-band-play">
          <Transcript entries={transcript} />
        </div>
      }
      header={
        <p className="rt-label rt-head__play" id={`${uid}-what`}>
          {ended ? "Scene ended" : "What do you do?"}
        </p>
      }
      rows={
        <ol className="rt-rowlist" aria-labelledby={`${uid}-what`} data-testid="rt-rowlist">
          {rows.map((row, index) => {
            const labelId = `${uid}-label-${index}`;
            const reasonId = `${uid}-reason-${index}`;
            return (
              <li
                key={row.id}
                className="rt-row"
                data-action={row.id}
                data-enabled={row.enabled}
                data-testid={`rt-row-${row.id}`}
              >
                <span className="rt-row__num" aria-hidden="true">
                  {lineNumber(index)}
                </span>
                {row.marked ? (
                  <button
                    type="button"
                    className="rt-mark"
                    aria-label={`Why line ${lineNumber(index)} exists`}
                    aria-expanded={noteOpen}
                    aria-controls="rt-note"
                    data-testid={`rt-mark-${row.id}`}
                    onClick={() => setNoteOpen((open) => !open)}
                  >
                    <span aria-hidden="true">*</span>
                  </button>
                ) : null}
                <div className="rt-row__single">
                  <span id={labelId} className="rt-action-label rt-row__label">
                    {row.label}
                  </span>
                  {row.reason === null ? null : (
                    <span id={reasonId} className="rt-requirement rt-row__reason">
                      {row.reason}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="rt-row__hit"
                  aria-labelledby={labelId}
                  aria-describedby={row.reason === null ? undefined : reasonId}
                  aria-disabled={row.enabled ? undefined : true}
                  data-testid={`rt-choice-${row.id}`}
                  onClick={() => take(row.id)}
                />
              </li>
            );
          })}
        </ol>
      }
      foot={
        <div className="rt-foot__play">
          <button type="button" className="rt-button" data-testid="rt-restart" onClick={restart}>
            {ended ? "Play it again" : "Start over"}
          </button>
          <p className="rt-foot__note" role="status">
            {playFootNote}
          </p>
        </div>
      }
      note={
        side === "with" ? (
          <CausalNote pair={pair} lines={markedLines} hidden={!noteOpen} />
        ) : null
      }
    />
  );
}
