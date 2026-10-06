"use client";

/**
 * Previous and current, side by side, with the same choices replayed in both
 * (specification sections 2 and 9).
 *
 * Everything here is local. Both scenes arrived in one project read, and the
 * comparison runs through the pure Phase 1 engine: `observeReplayPrefix`
 * re-executes one explicit list of action ids from the initial state in each
 * version and reports what is available afterwards. There is no `fetch` in this
 * file, no provider, and no database — switching versions, playing either one,
 * and replaying a prefix all cost nothing.
 *
 * Phase 6 sets it as the Rehearsal Table's comparison: one row per action,
 * unchanged rows quiet and single, changed rows split into the previous
 * version and this one, with this version's cell on revision stock because
 * the engine observed that change. Actions are named by their labels; the ids
 * stay in the record.
 *
 * Two honesty rules the component follows:
 *
 *   * **The default prefix is the server's.** The stored diff carries the legal
 *     prefix at which the engine proved the two versions differ, so the first
 *     thing shown is a difference that was computed and recorded, not one the
 *     browser went looking for.
 *   * **The creator's own choices are theirs.** Playing the current version
 *     records the action ids actually taken, and "replay my choices" uses that
 *     list. When a choice does not exist in the other version, the replay stops
 *     and says which one, rather than inventing a path (section 9, "Play state").
 */

import { useCallback, useMemo, useState } from "react";
import type { PlayableView } from "@/domain/compile";
import type { Id } from "@/domain/scene";
import { availableActions, initialState } from "@/engine/interpreter";
import { lineNumber } from "@/presentation/rehearsal";
import { humanizeSummary, REVISION_LABEL_TEXT } from "@/presentation/revision";
import { compareVersions } from "@/presentation/versions";
import type { VersionRow } from "@/presentation/versions";
import { ScenePlayer } from "../player/ScenePlayer";

type Props = {
  current: PlayableView;
  previous: PlayableView;
};

type Side = "previous" | "current";

export function VersionCompare({ current, previous }: Props): React.JSX.Element {
  const [side, setSide] = useState<Side>("current");
  const [recorded, setRecorded] = useState<readonly Id[]>([]);

  const diff = current.diff;
  /** The prefix the server recorded, or the creator's own if they played one. */
  const prefix = useMemo<readonly Id[]>(
    () => (recorded.length > 0 ? recorded : (diff?.replay?.prefix ?? [])),
    [recorded, diff],
  );

  const comparison = useMemo(
    () => compareVersions(previous.scene, current.scene, prefix),
    [previous.scene, current.scene, prefix],
  );

  const onPrefix = useCallback((taken: readonly Id[]) => {
    setRecorded([...taken]);
  }, []);

  const shown = side === "current" ? current : previous;
  const scenes = [current.scene, previous.scene];
  const mine = recorded.length > 0;
  const changed = comparison.changedCount;

  return (
    <section
      className="rt rt-studio rt-versions"
      id="compare"
      data-testid="version-compare"
      aria-labelledby="compare-heading"
    >
      <header className="rt-studio__head">
        <p className="rt-label rt-studio__eyebrow">Compare · the previous version and this one</p>
        <h2 className="rt-studio__title rt-studio__title--small" id="compare-heading">
          {prefix.length === 0
            ? "Play one version, then compare"
            : comparison.stoppedAt !== null
              ? "Your choices end early in the previous version"
              : changed > 0
                ? "Same choices. Different next move."
                : "Same choices. Same next move."}
        </h2>
        {diff === null ? (
          <p className="rt-studio__lede" data-testid="compare-no-diff">
            This version has no recorded comparison, so only the versions
            themselves are shown.
          </p>
        ) : (
          <>
            <p className="rt-studio__lede" data-testid="compare-label">
              {REVISION_LABEL_TEXT[diff.label]}
            </p>
            <ul className="rt-versions__summary" data-testid="compare-summary">
              {humanizeSummary(diff.summary, scenes).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </header>

      <h3 className="rt-label rt-versions__heading">Replay the same choices</h3>
      {prefix.length === 0 ? (
        <p className="rt-studio__note rt-versions__empty" data-testid="replay-empty">
          Play the version below and your choices will be replayed here in the
          other one.
        </p>
      ) : (
        <div className="rt-versions__replay" data-testid="replay">
          <div className="rt-versions__prefix" data-testid="replay-prefix">
            <p className="rt-label rt-versions__prefix-head">
              {mine ? "Your choices" : "The recorded difference"}
              {mine ? ", in both versions" : ", in both versions · the engine recorded this point"}
            </p>
            <p className="rt-versions__prefix-labels">{comparison.prefixLabels.join(" → ")}</p>
            <details className="rt-record-details rt-versions__ids">
              <summary>Action ids</summary>
              <p>
                <code>{prefix.join(" → ")}</code>
              </p>
            </details>
          </div>

          {comparison.stoppedAt === null ? null : (
            <p className="rt-failure-line" data-testid="replay-stopped">
              The previous version stops at &ldquo;{comparison.stoppedAt.label}&rdquo;: that
              choice is not available there, so the replay goes no further.
            </p>
          )}

          {comparison.stoppedAt !== null ? null : changed === 0 ? (
            <p className="rt-studio__note rt-versions__count" data-testid="replay-same">
              After those choices, the same actions are available in both
              versions.
            </p>
          ) : (
            <p className="rt-versions__count">
              <span className="rt-versions__changed">
                {changed} choice{changed === 1 ? "" : "s"} changed
              </span>
              {" · "}
              {comparison.unchangedCount} unchanged · same room, same people, same object
            </p>
          )}

          <div className="rt-vheads" aria-hidden="true">
            <span>What do you do?</span>
            <span>Previous version</span>
            <span>This version</span>
          </div>
          <ol
            className="rt-vrows"
            data-testid={changed > 0 ? "replay-changes" : undefined}
            aria-label="Actions after these choices"
          >
            {comparison.rows.map((row, index) => (
              <VersionRowView key={row.id} row={row} index={index} />
            ))}
          </ol>
        </div>
      )}

      <div className="rt-versions__play">
        <div className="rt-versions__play-head">
          <h3 className="rt-label rt-versions__heading" id="compare-play-heading">
            {side === "current" ? "This version" : "The previous version"}
          </h3>
          <div className="rt-seg rt-versions__seg" role="group" aria-label="Which version to play">
            <button
              type="button"
              className="rt-seg__option"
              data-testid="compare-previous"
              aria-pressed={side === "previous"}
              onClick={() => setSide("previous")}
            >
              Previous version
            </button>
            <button
              type="button"
              className="rt-seg__option"
              data-testid="compare-current"
              aria-pressed={side === "current"}
              onClick={() => setSide("current")}
            >
              This version
            </button>
          </div>
        </div>
        <p className="rt-studio__note">
          {side === "current"
            ? "Your choices here are replayed in the previous version above."
            : "Playing the previous version changes nothing; your comparison keeps this version's choices."}{" "}
          A revision starts a new run. No flag from an earlier playthrough is carried into a
          changed version.
        </p>
        <div className="rt-player rt-versions__player">
          <ScenePlayer
            key={shown.version_id}
            scene={shown.scene}
            testIdPrefix={side === "current" ? "compare-current-play" : "compare-previous-play"}
            {...(side === "current" ? { onPrefixChange: onPrefix } : {})}
          />
        </div>
        <p className="rt-studio__note" data-testid="compare-offline-note">
          {availableActions(shown.scene, initialState(shown.scene)).length} choices are
          open at the start. Everything on this screen is computed in your browser
          by the same engine that validated both versions.
        </p>
        <details className="rt-record-details">
          <summary>Version record</summary>
          <p data-testid="compare-version-id">
            Version <span className="rt-record-id">{shown.version_id}</span>
          </p>
        </details>
      </div>
    </section>
  );
}

function VersionRowView({ row, index }: { row: VersionRow; index: number }): React.JSX.Element {
  const split = row.kind !== "unchanged";
  return (
    <li
      className={`rt-vrow rt-vrow--${row.kind}`}
      data-testid={split ? `replay-change-${row.id}` : undefined}
    >
      <span className="rt-vrow__num" aria-hidden="true">
        {lineNumber(index)}
      </span>
      <span className="rt-vrow__label">{row.label}</span>
      {split ? (
        <>
          <span className="rt-vrow__cell rt-vrow__cell--previous">
            <span className="rt-vrow__tag">Previous</span>
            {row.previous.note}
          </span>
          <span className="rt-vrow__cell rt-vrow__cell--current">
            <span className="rt-vrow__tag">This version</span>
            {row.current.note}
          </span>
        </>
      ) : (
        <span className="rt-vrow__cell rt-vrow__cell--same">
          <span className="rt-vrow__tag">Both</span>
          {row.current.note}
          {row.previous.note === row.current.note ? "" : ` · previous: ${row.previous.note}`}
        </span>
      )}
    </li>
  );
}
