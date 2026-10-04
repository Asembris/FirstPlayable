"use client";

/**
 * The Phase 4 studio panel: build, watch truthfully, review, activate.
 *
 * Functional, not polished — the visual system is phase 6's. What it does have
 * to be is honest, and that shapes every state here:
 *
 *   * **The stage wording is the server's.** `status.next_stage_label` and
 *     each stage's own label come from the locked table in
 *     `src/domain/compile.ts`, so the screen cannot describe work that is not
 *     happening.
 *   * **One advance request per stage.** The panel asks for the next stage,
 *     waits for it to commit, then asks again. It never fires a second request
 *     while one is in flight, and closing the browser simply stops the chain:
 *     reopening the project resumes from the committed checkpoint.
 *   * **A failure is a finished state.** It shows this application's own code
 *     and sentence, the last good version is still named, and the saved
 *     example is one click away. There is no spinner that outlives the work.
 *   * **Review is explicit.** A successful build produces a *pending* scene.
 *     It is playable right here, through the Phase 1 engine, and it becomes
 *     the project's active version only when the creator confirms it.
 *
 * What this panel deliberately does not have: a revision control, an
 * ending-copy editor, a version comparison, a share or export action, a
 * provider log, or a raw JSON view. Those are phases 5 and 6.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdvanceResponse,
  CompilationStatus,
  CompileResponse,
  PlayableView,
  SceneVersionSummary,
} from "@/domain/compile";
import type { ProjectView } from "@/domain/project";
import { ScenePlayer } from "../player/ScenePlayer";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

type Props = {
  projectId: string;
  project: ProjectView;
  playable: PlayableView | null;
  versions: readonly SceneVersionSummary[];
  onChanged: () => void;
};

export function CompilePanel({
  projectId,
  project,
  playable,
  versions,
  onChanged,
}: Props): React.JSX.Element {
  const [status, setStatus] = useState<CompilationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  /** Guards against two advance requests being in flight at once. */
  const advancing = useRef(false);

  const approvedCount = project.approved_slots.length;
  const canCompile = approvedCount > 0;

  // Arriving on this page starts nothing: no reservation, no lease, no
  // provider call. A build is resumed by an explicit click.
  useEffect(() => {
    setStatus(null);
    setFailure(null);
  }, [projectId, project.revision]);

  const advance = useCallback(
    async (operationId: string): Promise<CompilationStatus | null> => {
      const result = await postJson<AdvanceResponse>(
        `/api/operations/${encodeURIComponent(operationId)}/advance`,
        {},
      );
      if (!result.ok) {
        setFailure(result.failure);
        return null;
      }
      setFailure(null);
      setStatus(result.value.status);
      return result.value.status;
    },
    [],
  );

  /**
   * Drives the build one stage at a time.
   *
   * Each iteration is one `POST .../advance`, which performs at most one
   * provider attempt and commits before returning. The loop stops the moment
   * the controller says there is no next stage, or on any failure.
   */
  const run = useCallback(
    async (initial: CompilationStatus) => {
      if (advancing.current) return;
      advancing.current = true;
      setBusy(true);
      try {
        let current: CompilationStatus | null = initial;
        // Bounded: four stages, each with at most one repair, is eight.
        for (let guard = 0; guard < 10; guard += 1) {
          if (current === null || current.next_stage === null) break;
          current = await advance(current.operation_id);
          if (current !== null && current.failure !== null) break;
        }
      } finally {
        advancing.current = false;
        setBusy(false);
        onChanged();
      }
    },
    [advance, onChanged],
  );

  const compile = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    const result = await postJson<CompileResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/compile`,
      { expected_revision: project.revision },
    );
    if (!result.ok) {
      setFailure(result.failure);
      setBusy(false);
      return;
    }
    setStatus(result.value.status);
    await run(result.value.status);
  }, [projectId, project.revision, run]);

  const decide = useCallback(
    async (versionId: string, decline: boolean) => {
      setBusy(true);
      setFailure(null);
      const result = await postJson(
        `/api/projects/${encodeURIComponent(projectId)}/activate`,
        {
          expected_revision: project.revision,
          version_id: versionId,
          ...(decline ? { decline: true } : {}),
        },
      );
      setBusy(false);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setStatus(null);
      onChanged();
    },
    [projectId, project.revision, onChanged],
  );

  const pending = playable !== null && playable.state === "pending" ? playable : null;
  const active = playable !== null && playable.state === "active" ? playable : null;

  /**
   * A build that was interrupted — by a reload, a closed tab, or a lost
   * connection — leaves the project in one of the compilation states. Pressing
   * build again is what resumes it: `POST .../compile` with the same frozen
   * inputs replays the existing operation rather than creating a second one,
   * and the advance loop picks up from the last committed stage.
   */
  const interrupted =
    pending === null &&
    status === null &&
    (["AWAITING_APPROVAL", "BASE_READY", "MODULES_READY", "VALIDATING"] as const).some(
      (state) => state === project.workflow_state,
    );

  return (
    <section className="panel" data-testid="compile-panel">
      <h2 className="panel__heading">Playable scene</h2>

      {!canCompile ? (
        <p className="studio__hint" data-testid="compile-needs-approval">
          Approve at least one interaction above, then build the playable scene.
        </p>
      ) : (
        <>
          {interrupted ? (
            <p className="studio__hint" data-testid="compile-interrupted">
              A build for these choices was started and did not finish. Resuming
              continues from the last step that was saved; nothing already
              written is repeated.
            </p>
          ) : null}
          <p className="studio__hint">
            {approvedCount === 1
              ? "One approved influence will be compiled as its own module onto a brief-only foundation."
              : "Each approved influence is compiled as its own module onto one brief-only foundation."}
          </p>
          <div className="studio__actions">
            <button
              type="button"
              className="button button--primary"
              data-testid="compile-start"
              disabled={busy}
              onClick={() => void compile()}
            >
              {interrupted
                ? "Resume the build"
                : active === null && pending === null
                  ? "Build the playable scene"
                  : "Build it again"}
            </button>
            {status !== null && status.next_stage !== null && !busy ? (
              <button
                type="button"
                className="button"
                data-testid="compile-resume"
                onClick={() => void run(status)}
              >
                Resume · {status.next_stage_label}
              </button>
            ) : null}
          </div>
        </>
      )}

      {status !== null ? <StageList status={status} busy={busy} /> : null}

      {failure !== null ? (
        <InlineFailure failure={failure} testId="compile-failure" />
      ) : null}

      {status?.failure != null ? (
        <div className="studio__error" role="alert" data-testid="compile-failed">
          <p className="studio__error-heading">This build did not finish</p>
          <p className="studio__error-message">{status.failure.message}</p>
          <p className="studio__error-meta">
            <span data-testid="compile-failure-code">{status.failure.code}</span>
            {status.failure.stage === null ? null : ` · ${status.failure.stage}`}
          </p>
          <p className="studio__hint" data-testid="compile-last-good">
            {status.last_good_version_id === null
              ? "No earlier version has been activated, so nothing was replaced. Your brief and approvals are unchanged."
              : `Your active version ${status.last_good_version_id} is untouched and still plays.`}
          </p>
          <div className="studio__actions">
            <Link className="button" href="/example">
              Play saved example
            </Link>
          </div>
        </div>
      ) : null}

      {pending !== null ? (
        <ReviewBlock
          playable={pending}
          busy={busy}
          onActivate={() => void decide(pending.version_id, false)}
          onDecline={() => void decide(pending.version_id, true)}
          hasActive={project.active_version_id !== null}
        />
      ) : null}

      {pending === null && active !== null ? (
        <div data-testid="active-playable">
          <h3 className="panel__heading">Active version</h3>
          <p className="studio__hint">
            Version <span data-testid="active-version-id">{active.version_id}</span>. Every
            choice and reset below runs locally through the same engine that validated it.
          </p>
          <WhereThisAppears playable={active} />
          <ScenePlayer scene={active.scene} testIdPrefix="active" />
        </div>
      ) : null}

      {versions.length > 0 ? (
        <ul className="panel__list" data-testid="version-list">
          {versions.map((version) => (
            <li key={version.id}>
              <span className="chip">{version.state}</span>{" "}
              <span data-testid={`version-${version.id}`}>{version.id}</span> ·{" "}
              {version.active_slots.length === 0
                ? "foundation only"
                : version.active_slots.join(" + ")}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The truthful stage list: what has committed, what is running, what failed. */
function StageList({
  status,
  busy,
}: {
  status: CompilationStatus;
  busy: boolean;
}): React.JSX.Element {
  return (
    <>
      <p className="studio__hint" data-testid="compile-state">
        {status.state}
        {busy && status.next_stage !== null ? ` · ${status.next_stage_label}…` : ""}
      </p>
      <ul className="panel__list" data-testid="compile-stages">
        {status.stages.map((stage) => (
          <li key={stage.stage} data-testid={`stage-${stage.stage}`}>
            <span className="chip">{stage.status}</span> {stage.label}
            {stage.repaired ? " · repaired once" : ""}
          </li>
        ))}
      </ul>
      <p className="studio__hint" data-testid="compile-model-calls">
        Model calls so far: {status.model_calls}
      </p>
    </>
  );
}

/**
 * The review block.
 *
 * The creator plays the pending scene here and then confirms that the compiled
 * interaction reflects what they approved. Declining preserves the previous
 * active version; it never broadens or rewrites the approval.
 */
function ReviewBlock({
  playable,
  busy,
  onActivate,
  onDecline,
  hasActive,
}: {
  playable: PlayableView;
  busy: boolean;
  onActivate: () => void;
  onDecline: () => void;
  hasActive: boolean;
}): React.JSX.Element {
  return (
    <div data-testid="pending-review">
      <h3 className="panel__heading">Does this match what you approved?</h3>
      <p className="studio__hint">
        Version <span data-testid="pending-version-id">{playable.version_id}</span> passed every
        interaction check and is not active yet. Play it, then confirm or decline.
      </p>
      <WhereThisAppears playable={playable} />
      <ScenePlayer scene={playable.scene} testIdPrefix="pending" />
      <div className="studio__actions">
        <button
          type="button"
          className="button button--primary"
          data-testid="activate-version"
          disabled={busy}
          onClick={onActivate}
        >
          Yes — make this the active version
        </button>
        <button
          type="button"
          className="button"
          data-testid="decline-version"
          disabled={busy}
          onClick={onDecline}
        >
          {hasActive ? "No — keep the previous version" : "No — discard this build"}
        </button>
      </div>
    </div>
  );
}

/**
 * "Where this appears": the fourth provenance line of specification
 * section 13.
 *
 * Every sentence here is `witness.sentence`, generated by the engine from a
 * paired replay. Nothing on this screen is a model describing its own output,
 * and nothing claims the retrieval source produced the mechanic or that the
 * idea could not have been reached another way.
 */
function WhereThisAppears({ playable }: { playable: PlayableView }): React.JSX.Element {
  if (playable.scene_changed.length === 0) {
    return (
      <p className="studio__hint" data-testid="where-this-appears-empty">
        This version has no influence module composed. It is the clean
        brief-only foundation.
      </p>
    );
  }
  return (
    <div data-testid="where-this-appears">
      <h4 className="panel__heading">Where this appears</h4>
      <ul className="panel__list">
        {playable.scene_changed.map((change) => {
          const influence = playable.scene.influences.find(
            (candidate) => candidate.approval_id === change.approval_id,
          );
          return (
            <li key={change.approval_id} data-testid={`scene-changed-${change.slot}`}>
              <span className="chip">{change.slot}</span>{" "}
              {influence === undefined ? null : (
                <span className="studio__prose">{influence.approved_text}</span>
              )}
              <p className="line__text" data-testid={`witness-${change.slot}`}>
                {change.witness.sentence}
              </p>
              <p className="studio__hint">
                Observed by replaying this version against the same version
                without this influence. Affected definitions:{" "}
                {change.mechanic_ids.join(", ")}.
              </p>
            </li>
          );
        })}
      </ul>
      <p className="studio__hint">
        These sentences come from the engine&rsquo;s own replay, not from a
        model describing its output. They say what changed, not that it is
        better or that it could only have been reached this way.
      </p>
    </div>
  );
}
