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
import { observeReplayPrefix } from "@/engine/diff";
import { availableActions, initialState, step } from "@/engine/interpreter";
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

  const replay = useMemo(
    () => observeReplayPrefix(previous.scene, current.scene, prefix),
    [previous.scene, current.scene, prefix],
  );

  /**
   * Where the replay stops in the earlier version, if it does.
   *
   * A prefix that is legal in one version and not the other is the honest
   * answer to "the same choices": it names the first action that is not
   * available, instead of quietly skipping it.
   */
  const stoppedAt = useMemo(() => {
    if (replay.prefix_legal_in_before) return null;
    let bits = initialState(previous.scene);
    for (const actionId of prefix) {
      const result = step(previous.scene, { bits: bits.bits }, actionId);
      if (!result.ok) return actionId;
      bits = result.state;
    }
    return null;
  }, [replay.prefix_legal_in_before, previous.scene, prefix]);

  const onPrefix = useCallback((taken: readonly Id[]) => {
    setRecorded([...taken]);
  }, []);

  const shown = side === "current" ? current : previous;
  const changed = replay.changed_action_ids;

  return (
    <section className="panel" data-testid="version-compare">
      <h2 className="panel__heading">Compare versions</h2>
      <div className="studio__actions" role="group" aria-label="Which version to play">
        <button
          type="button"
          className={`button${side === "previous" ? " button--primary" : ""}`}
          data-testid="compare-previous"
          aria-pressed={side === "previous"}
          onClick={() => setSide("previous")}
        >
          Previous version
        </button>
        <button
          type="button"
          className={`button${side === "current" ? " button--primary" : ""}`}
          data-testid="compare-current"
          aria-pressed={side === "current"}
          onClick={() => setSide("current")}
        >
          This version
        </button>
      </div>

      {diff === null ? (
        <p className="studio__hint" data-testid="compare-no-diff">
          This version has no recorded comparison, so only the versions
          themselves are shown.
        </p>
      ) : (
        <>
          <p className="studio__hint" data-testid="compare-label">
            {diff.label === "mechanical"
              ? "Mechanical change: the interaction itself is different."
              : diff.label === "wording"
                ? "Wording changed; interaction unchanged."
                : "No change."}
          </p>
          <ul className="panel__list" data-testid="compare-summary">
            {diff.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}

      <h3 className="panel__heading">Replay the same choices</h3>
      {prefix.length === 0 ? (
        <p className="studio__hint" data-testid="replay-empty">
          Play the version below and your choices will be replayed here in the
          other one.
        </p>
      ) : (
        <div data-testid="replay">
          <p className="studio__hint" data-testid="replay-prefix">
            {recorded.length > 0 ? "Your choices" : "The recorded difference"}:{" "}
            {prefix.join(" → ")}
          </p>
          {stoppedAt === null ? null : (
            <p className="studio__hint" data-testid="replay-stopped">
              The previous version stops at &ldquo;{stoppedAt}&rdquo;: that choice is
              not available there, so the replay goes no further.
            </p>
          )}
          {changed.length === 0 ? (
            <p className="studio__hint" data-testid="replay-same">
              After those choices, the same actions are available in both
              versions.
            </p>
          ) : (
            <ul className="panel__list" data-testid="replay-changes">
              {changed.map((actionId) => (
                <li key={actionId} data-testid={`replay-change-${actionId}`}>
                  <span className="chip">{actionId}</span> was{" "}
                  {replay.before[actionId] ?? "hidden"} before and{" "}
                  {replay.after[actionId] ?? "hidden"} now.
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h3 className="panel__heading">
        {side === "current" ? "This version" : "The previous version"}
      </h3>
      <p className="studio__hint" data-testid="compare-version-id">
        Version {shown.version_id}
      </p>
      <ScenePlayer
        key={shown.version_id}
        scene={shown.scene}
        testIdPrefix={side === "current" ? "compare-current-play" : "compare-previous-play"}
        {...(side === "current" ? { onPrefixChange: onPrefix } : {})}
      />
      <p className="studio__hint">
        A revision starts a new run. No flag from an earlier playthrough is
        carried into a changed version.
      </p>
      <p className="studio__hint" data-testid="compare-offline-note">
        {availableActions(shown.scene, initialState(shown.scene)).length} choices are
        open at the start. Everything on this screen is computed in your browser
        by the same engine that validated both versions.
      </p>
    </section>
  );
}
