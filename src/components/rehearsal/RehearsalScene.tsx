"use client";

/**
 * The saved example on the Rehearsal Table: the real With-Moon / Without-Moon
 * pair, played in the browser against the same pure engine the validator
 * uses. No fetch, no API route, no provider, no database.
 *
 * Play and Compare are one page. The shell never re-mounts; a mode change
 * flips `data-view` and the CSS choreography in compare.css does the rest:
 * the band and header quiet, changed rows split in place, unchanged rows only
 * change colour, the marks press in, and the causal note resolves last.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Id } from "../../domain/scene";
import { CANONICAL_PAIR } from "../../presentation/canonical-pair";
import {
  causalSummary,
  compareAt,
  lineNumber,
  lowerFirst,
  numberWord,
  playRows,
  runChoices,
  transcriptOf,
} from "../../presentation/rehearsal";
import type {
  CompareRow,
  PlayRow,
  Side,
  Taken,
  TranscriptEntry,
} from "../../presentation/rehearsal";
import { CausalNote } from "./CausalNote";
import { SceneShell } from "./SceneShell";
import type { SceneView } from "./SceneShell";

const pair = CANONICAL_PAIR;

const SAVED_LABEL = "Saved example · generated from a real build";

/** The pause before the saved example splits into Compare on first entry. */
const AUTO_SPLIT_MS = 1100;

/** Below this width the note folds into a one-line summary and a bottom sheet. */
const MOBILE_QUERY = "(max-width: 639.98px)";

/** P / C switch Play / Compare; W / O switch With / Without. */
const SHORTCUTS: Readonly<Record<string, "play" | "compare" | "with" | "without">> = {
  p: "play",
  c: "compare",
  w: "with",
  o: "without",
};

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

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

/** One table row, carrying its Play reading and its Compare reading. */
type TableRow = {
  readonly id: Id;
  readonly play: PlayRow | null;
  readonly compare: CompareRow | null;
};

/**
 * Play and Compare share row coordinates whenever the Play list is a prefix
 * of the Compare list (the Without list is always a prefix of the With list).
 * Then every row is one element in both modes and only its contents change.
 * Otherwise the player is somewhere else in the scene, and each mode shows
 * its own rows.
 */
function tableRows(
  view: SceneView,
  play: readonly PlayRow[],
  compare: readonly CompareRow[],
): TableRow[] {
  const aligned = play.every((row, index) => compare[index]?.id === row.id);
  if (aligned) {
    return compare.map((row, index) => ({ id: row.id, play: play[index] ?? null, compare: row }));
  }
  return view === "play"
    ? play.map((row) => ({ id: row.id, play: row, compare: null }))
    : compare.map((row) => ({ id: row.id, play: null, compare: row }));
}

function CompareCellView({
  row,
  side,
}: {
  row: CompareRow;
  side: Side;
}): React.ReactElement {
  const cell = side === "with" ? row.with : row.without;
  const absent = cell.status === "hidden";
  return (
    <div
      className={`rt-cell rt-cell--${side}`}
      data-status={cell.status}
      data-testid={`rt-cell-${side}-${row.id}`}
    >
      <div className="rt-cell__body">
        <span className="rt-cell__tag">
          {side === "with" ? `With ${pair.influenceName}` : "Without"}
          <span className="rt-sr-only">: </span>
        </span>
        <span className="rt-action-label rt-cell__label">
          {absent ? (
            <>
              <span aria-hidden="true">—</span>
              <span className="rt-sr-only">{row.label}</span>
            </>
          ) : (
            row.label
          )}
        </span>
        <span className="rt-requirement rt-cell__note" data-testid={`rt-note-${side}-${row.id}`}>
          {cell.note}
        </span>
      </div>
    </div>
  );
}

export type RehearsalSceneProps = {
  readonly initialView?: SceneView;
  /** Split into Compare by itself shortly after first entry. */
  readonly autoSplit?: boolean;
};

export function RehearsalScene(props: RehearsalSceneProps): React.ReactElement {
  const [view, setView] = useState<SceneView>(props.initialView ?? "play");
  const [side, setSide] = useState<Side>("with");
  const [taken, setTaken] = useState<Taken>({
    choices: pair.recordedPrefix,
    endingActionId: null,
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const uid = useId();
  const tabRefs = useRef<Record<SceneView, HTMLButtonElement | null>>({ play: null, compare: null });
  const sheetRef = useRef<HTMLDialogElement | null>(null);
  const userSwitch = useRef(false);

  const scene = sceneOf(side);
  const run = useMemo(() => runChoices(scene, taken.choices), [scene, taken.choices]);
  const transcript = useMemo(() => transcriptOf(scene, taken), [scene, taken]);
  const ended = taken.endingActionId !== null;
  const rows = useMemo(() => (ended ? [] : playRows(scene, run.state)), [ended, scene, run.state]);
  const comparison = useMemo(() => compareAt(pair, taken.choices), [taken.choices]);
  const table = useMemo(
    () => tableRows(view, rows, comparison.rows),
    [view, rows, comparison.rows],
  );

  const compareView = view === "compare";
  const changedLines = table.flatMap((row, index) =>
    row.compare !== null && row.compare.kind !== "unchanged" ? [lineNumber(index)] : [],
  );
  const markedLines = table.flatMap((row, index) =>
    row.play?.marked === true ? [lineNumber(index)] : [],
  );
  const noteVisible = compareView || (noteOpen && side === "with");

  const switchView = useCallback((next: SceneView, byUser: boolean) => {
    userSwitch.current = byUser;
    setView(next);
  }, []);

  // The saved example opens on Play at the recorded point, then splits into
  // Compare by itself, unless the visitor has already started doing something.
  useEffect(() => {
    if (props.autoSplit !== true) return;
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
    };
    window.addEventListener("pointerdown", cancel, { once: true });
    window.addEventListener("keydown", cancel, { once: true });
    const timer = window.setTimeout(() => {
      if (!cancelled) switchView("compare", false);
    }, AUTO_SPLIT_MS);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [props.autoSplit, switchView]);

  // Keep the mode in the address, so a reload or a shared link lands on it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("view") === view) return;
    if (url.searchParams.get("view") === null && view === (props.initialView ?? "play") && !userSwitch.current) {
      return;
    }
    url.searchParams.set("view", view);
    window.history.replaceState(window.history.state, "", url);
  }, [view, props.initialView]);

  // A user-driven mode change never strands keyboard focus inside the layer
  // that just went inert; it lands on the tab that is now current.
  useEffect(() => {
    if (!userSwitch.current) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest("[inert]") !== null) {
      tabRefs.current[view]?.focus();
    }
  }, [view]);

  const openSheet = useCallback(() => {
    const sheet = sheetRef.current;
    if (sheet !== null && !sheet.open) sheet.showModal();
  }, []);

  const toggleNote = useCallback(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) openSheet();
    else setNoteOpen((open) => !open);
  }, [openSheet]);

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

  /** Continue from the compared point, in one version. */
  const continueIn = useCallback(
    (next: Side) => {
      setSide(next);
      setTaken({ choices: comparison.prefix, endingActionId: null });
      setNoteOpen(false);
      setNotice("");
      switchView("play", true);
    },
    [comparison.prefix, switchView],
  );

  // Single-key shortcuts, ignored while typing, with a modifier, or under a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (typingInto(event.target) || sheetRef.current?.open === true) return;
      const command = SHORTCUTS[event.key.toLowerCase()];
      if (command === undefined) return;
      if (command === "play" || command === "compare") {
        switchView(command, true);
      } else if (view === "play") {
        switchSide(command);
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switchSide, switchView, view]);

  const modes = (
    <div className="rt-modes" role="group" aria-label="View">
      {(["play", "compare"] as const).map((candidate) => (
        <button
          key={candidate}
          ref={(element) => {
            tabRefs.current[candidate] = element;
          }}
          type="button"
          className="rt-modes__tab"
          aria-pressed={view === candidate}
          aria-keyshortcuts={candidate === "play" ? "P" : "C"}
          data-testid={`rt-tab-${candidate}`}
          onClick={() => switchView(candidate, true)}
        >
          {candidate === "play" ? "Play" : "Compare"}
        </button>
      ))}
    </div>
  );

  /** The With / Without control: in the top bar on desktop, pinned to the bottom on mobile. */
  const versionControl = (testPrefix: string, className: string) => (
    <div className={`rt-seg ${className}`} role="group" aria-label="Version" inert={compareView}>
      {(["with", "without"] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          className="rt-seg__option"
          aria-pressed={side === candidate}
          aria-keyshortcuts={candidate === "with" ? "W" : "O"}
          data-testid={`${testPrefix}-${candidate}`}
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

  const headline =
    comparison.changedCount > 0 ? "Same choices. Different next move." : "Same choices. Same next move.";
  const changedText = `${comparison.changedCount} choice${comparison.changedCount === 1 ? "" : "s"} changed`;
  const npc = pair.withScene.world.characters[0];
  const objectWord = (pair.withScene.world.object.name.trim().split(/\s+/).pop() ?? "").toLowerCase();

  return (
    <SceneShell
      scene={pair.withScene}
      view={view}
      crumb="/ saved example"
      noteOpen={noteVisible}
      modes={modes}
      status={
        <>
          {versionControl("rt-version", "rt-seg--topbar")}
          <span className="rt-chip" data-testid="rt-saved-chip">
            {SAVED_LABEL}
          </span>
        </>
      }
      compactStatus={<span className="rt-chip">{SAVED_LABEL}</span>}
      band={
        <>
          <div className="rt-band__play" data-testid="rt-band-play" inert={compareView}>
            <Transcript entries={transcript} />
          </div>
          <div className="rt-band__cmp" data-testid="rt-band-compare" inert={!compareView}>
            <p className="rt-label rt-cmp__prefix-head">
              {comparison.mine
                ? "After your choices, in both versions"
                : "After the same choices, in both versions"}
            </p>
            <p className="rt-cmp__prefix" data-testid="rt-compare-prefix">
              {comparison.prefixLabels.length === 0
                ? "At the start of the scene"
                : comparison.prefixLabels.join(" → ")}
            </p>
            <h2 className="rt-cmp__headline" data-testid="rt-compare-headline">
              {headline}
            </h2>
            <p className="rt-cmp__count" data-testid="rt-compare-count">
              <span className={comparison.changedCount > 0 ? "rt-cmp__changed" : undefined}>
                {changedText}
              </span>
              <span aria-hidden="true"> · </span>
              <span className="rt-sr-only">, </span>
              <span>{comparison.unchangedCount} unchanged</span>
              {comparison.sameWorld ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="rt-sr-only">, </span>
                  <span>
                    same room, same {npc.name}, same {objectWord}
                  </span>
                </>
              ) : null}
            </p>
            {comparison.fellBack ? (
              <p className="rt-cmp__fallback">
                One of your choices exists only with {pair.influenceName}, so this compares the
                recorded point instead.
              </p>
            ) : null}
          </div>
        </>
      }
      header={
        <>
          <p className="rt-label rt-head__play" id={`${uid}-what`} inert={compareView}>
            {ended ? "Scene ended" : "What do you do?"}
          </p>
          <div className="rt-head__cmp" aria-hidden="true" data-testid="rt-compare-heads">
            <span className="rt-label rt-head__without">Without this influence</span>
            <span className="rt-label rt-head__with">With {pair.influenceName} · you approved</span>
          </div>
        </>
      }
      rows={
        <>
          <p className="rt-sr-only" aria-live="polite" data-testid="rt-announce">
            {compareView
              ? `Comparing with and without ${pair.influenceName}: ${changedText}, ${comparison.unchangedCount} unchanged.`
              : ""}
          </p>
          <ol
            className="rt-rowlist"
            aria-label={compareView ? "Choices in both versions" : undefined}
            aria-labelledby={compareView ? undefined : `${uid}-what`}
            data-testid="rt-rowlist"
          >
            {table.map((row, index) => {
              const labelId = `${uid}-label-${index}`;
              const reasonId = `${uid}-reason-${index}`;
              const kind = row.compare?.kind ?? "none";
              const changed = kind !== "none" && kind !== "unchanged";
              const markInPlay = row.play?.marked === true && side === "with";
              const changedIndex = changed
                ? table.slice(0, index).filter((r) => {
                    const k = r.compare?.kind;
                    return k !== undefined && k !== "unchanged";
                  }).length
                : 0;
              const label = row.play?.label ?? row.compare?.label ?? "";
              const playable = !compareView && row.play !== null;
              return (
                <li
                  key={row.id}
                  className="rt-row"
                  data-action={row.id}
                  data-kind={kind}
                  data-in-play={row.play !== null}
                  data-in-compare={row.compare !== null}
                  data-enabled={row.play === null ? undefined : row.play.enabled}
                  data-testid={`rt-row-${row.id}`}
                  style={{ "--i": changedIndex } as React.CSSProperties}
                >
                  <span className="rt-row__num" aria-hidden="true">
                    {lineNumber(index)}
                  </span>
                  {markInPlay || changed ? (
                    <button
                      type="button"
                      className="rt-mark"
                      data-play={markInPlay}
                      data-compare={changed}
                      aria-label={`Why line ${lineNumber(index)} exists`}
                      aria-expanded={noteOpen}
                      aria-controls="rt-note"
                      aria-hidden={playable && markInPlay ? undefined : true}
                      tabIndex={playable && markInPlay ? undefined : -1}
                      data-testid={`rt-mark-${row.id}`}
                      onClick={() => {
                        if (!compareView) toggleNote();
                      }}
                    >
                      <span aria-hidden="true">*</span>
                    </button>
                  ) : null}
                  <div className="rt-row__single">
                    <span id={labelId} className="rt-action-label rt-row__label">
                      {label}
                    </span>
                    {row.play?.reason == null ? null : (
                      <span id={reasonId} className="rt-requirement rt-row__reason">
                        {row.play.reason}
                      </span>
                    )}
                    {kind === "added" && row.compare !== null ? (
                      <span className="rt-requirement rt-row__added">
                        Added with {pair.influenceName} · without: {lowerFirst(row.compare.without.note)}
                      </span>
                    ) : null}
                  </div>
                  {changed && row.compare !== null ? (
                    <div
                      className="rt-row__split"
                      aria-hidden={compareView ? undefined : true}
                      data-testid={`rt-split-${row.id}`}
                    >
                      <CompareCellView row={row.compare} side="without" />
                      <CompareCellView row={row.compare} side="with" />
                    </div>
                  ) : null}
                  {playable && row.play !== null ? (
                    <button
                      type="button"
                      className="rt-row__hit"
                      aria-labelledby={labelId}
                      aria-describedby={row.play.reason === null ? undefined : reasonId}
                      aria-disabled={row.play.enabled ? undefined : true}
                      data-testid={`rt-choice-${row.id}`}
                      onClick={() => take(row.id)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      }
      foot={
        <>
          <div className="rt-foot__play" inert={compareView}>
            {versionControl("rt-version-pinned", "rt-seg--pinned")}
            <button type="button" className="rt-button" data-testid="rt-restart" onClick={restart}>
              {ended ? "Play it again" : "Start over"}
            </button>
            <p className="rt-foot__note" role="status">
              {playFootNote}
            </p>
          </div>
          <div className="rt-foot__compare" inert={!compareView}>
            <button
              type="button"
              className="rt-button rt-button--primary"
              data-testid="rt-continue-with"
              onClick={() => continueIn("with")}
            >
              Continue with {pair.influenceName}
            </button>
            <button
              type="button"
              className="rt-button"
              data-testid="rt-continue-without"
              onClick={() => continueIn("without")}
            >
              Continue without
            </button>
            <p className="rt-foot__note">
              {comparison.prefix.length === 0
                ? "Both start from the beginning."
                : `Both pick up from the same ${numberWord(comparison.prefix.length)} choice${comparison.prefix.length === 1 ? "" : "s"}.`}
            </p>
          </div>
        </>
      }
      note={
        <>
          <CausalNote
            pair={pair}
            lines={compareView ? changedLines : markedLines}
            hidden={!noteVisible}
          />
          <div className="rt-why" inert={!compareView}>
            <button
              type="button"
              className="rt-why__button"
              aria-haspopup="dialog"
              data-testid="rt-why-summary"
              onClick={openSheet}
            >
              <span className="rt-label rt-why__title">
                Why this changed <span aria-hidden="true">↓</span>
              </span>
              <span className="rt-why__text">{causalSummary(pair)}</span>
            </button>
          </div>
          <dialog
            ref={sheetRef}
            className="rt-sheet"
            aria-label="Why this changed"
            data-testid="rt-sheet"
            onClick={(event) => {
              // A tap on the backdrop (the dialog itself, not its content) closes it.
              if (event.target === event.currentTarget) event.currentTarget.close();
            }}
          >
            <div className="rt-sheet__bar">
              <button
                type="button"
                className="rt-button"
                data-testid="rt-sheet-close"
                onClick={() => sheetRef.current?.close()}
              >
                Close
              </button>
            </div>
            <CausalNote
              pair={pair}
              lines={compareView ? changedLines : markedLines}
              id="rt-note-sheet"
              testId="rt-note-sheet"
              variant="sheet"
            />
          </dialog>
        </>
      }
    />
  );
}
