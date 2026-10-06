"use client";

/**
 * Build, and review the build, on the Rehearsal Table (Phase 6).
 *
 * The distinctions this panel exists to keep apart:
 *
 *   * **Approval is not a build.** Approving an interpretation changes no
 *     scene; the build button says how many approvals it will compile.
 *   * **A build is not the current version.** A successful build is a
 *     *candidate*, labelled "New version · awaiting review" in a dashed chip.
 *     It plays right here, and nothing about it reaches the people who play
 *     the scene.
 *   * **Only "Make it current" changes what people play.** The chip stamps
 *     solid only after that explicit action. "Keep the current version" (or,
 *     for a first build, "Discard this build") leaves everything as it was.
 *
 * The review sets what the creator intended (their own words, in ink) against
 * what the build was observed to do (revision stock), read from the engine's
 * own replay of the build with and without each influence. The UI never says
 * they match; the creator judges that.
 *
 * Unchanged from Phase 4, and still load-bearing: the stage wording is the
 * server's, one advance request runs per stage, a failure is a finished state
 * that names the version still in place, and an interrupted build resumes
 * from its last committed stage.
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
import type { ApprovedInfluence } from "@/domain/influence";
import type { ProjectView } from "@/domain/project";
import { numberWord } from "@/presentation/rehearsal";
import { allEndingsReachable, observationsOf } from "@/presentation/review";
import type { Observation } from "@/presentation/review";
import { ScenePlayer } from "../player/ScenePlayer";
import { PhraseText } from "../rehearsal/CausalNote";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

type Props = {
  projectId: string;
  project: ProjectView;
  playable: PlayableView | null;
  versions: readonly SceneVersionSummary[];
  onChanged: () => void;
};

/** What the creator last decided about a candidate, said back to them once. */
type Outcome = "activated" | "kept" | "discarded";

const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = {
  activated: "✓ Made current. This is now the version people play.",
  kept: "Kept the current version. The new build was set aside; your brief and approvals are unchanged.",
  discarded: "Discarded this build. Your brief and your approvals are unchanged.",
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement | null>(null);
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

  // The buttons the creator just used are gone; focus lands on what happened.
  useEffect(() => {
    if (outcome !== null) outcomeRef.current?.focus();
  }, [outcome]);

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
    setOutcome(null);
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
      const hadActive = project.active_version_id !== null;
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
      setOutcome(decline ? (hadActive ? "kept" : "discarded") : "activated");
      onChanged();
    },
    [projectId, project.revision, project.active_version_id, onChanged],
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

  const chip =
    pending !== null
      ? { text: "New version · awaiting review", dashed: true }
      : active !== null
        ? { text: "Current", dashed: false }
        : { text: "Draft · nothing built", dashed: true };
  const approvals = `${approvedCount} approved interpretation${approvedCount === 1 ? "" : "s"}`;

  return (
    <section className="rt rt-studio rt-build" id="build" data-testid="compile-panel" aria-labelledby="build-heading">
      <header className="rt-build__head">
        <div className="rt-studio__head">
          <p className="rt-label rt-studio__eyebrow">04 · Build and review</p>
          <h2 className="rt-studio__title rt-studio__title--small" id="build-heading">
            {pending !== null
              ? "A new version is waiting for your review"
              : active !== null
                ? "Your playable scene"
                : "Build the playable scene"}
          </h2>
        </div>
        <span
          className={`rt-chip${chip.dashed ? " rt-chip--dashed" : ""}${outcome === "activated" ? " rt-chip--stamp" : ""}`}
          data-testid="build-chip"
        >
          {chip.text}
        </span>
      </header>

      <div className="rt-build__cta">
        {!canCompile ? (
          <>
            <button type="button" className="rt-button rt-button--primary" data-testid="compile-start" disabled>
              Build the scene
            </button>
            <p className="rt-studio__note" data-testid="compile-needs-approval">
              Approve an interpretation above to build. Approving alone changes nothing.
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`rt-button${pending === null ? " rt-button--primary" : ""}`}
              data-testid="compile-start"
              disabled={busy}
              onClick={() => void compile()}
            >
              {interrupted
                ? "Resume the build"
                : active === null && pending === null
                  ? `Build the scene with ${approvals}`
                  : `Build again with ${approvals}`}
            </button>
            {status !== null && status.next_stage !== null && !busy ? (
              <button
                type="button"
                className="rt-button"
                data-testid="compile-resume"
                onClick={() => void run(status)}
              >
                Resume · {status.next_stage_label}
              </button>
            ) : null}
            <p className="rt-studio__note">
              {interrupted ? (
                <span data-testid="compile-interrupted">
                  A build for these choices was started and did not finish. Resuming continues
                  from the last step that was saved; nothing already written is repeated.
                </span>
              ) : (
                "Builds a new version for you to review. The scene people play doesn't change until you make it current."
              )}
            </p>
          </>
        )}
      </div>

      {status !== null ? <StageList status={status} busy={busy} /> : null}

      {failure !== null ? <InlineFailure failure={failure} testId="compile-failure" /> : null}

      {status?.failure != null ? (
        <div className="rt-stages" role="alert" data-testid="compile-failed">
          <p className="rt-review__outcome">This build did not finish</p>
          <p className="rt-studio__note">{status.failure.message}</p>
          <p className="rt-stages__state">
            <span data-testid="compile-failure-code">{status.failure.code}</span>
            {status.failure.stage === null ? null : ` · ${status.failure.stage}`}
          </p>
          <p className="rt-studio__note" data-testid="compile-last-good">
            {status.last_good_version_id === null
              ? "No earlier version has been activated, so nothing was replaced. Your brief and approvals are unchanged."
              : `Your active version ${status.last_good_version_id} is untouched and still plays.`}
          </p>
          <div className="rt-studio__actions">
            <Link className="rt-button" href="/difference">
              Play saved example
            </Link>
          </div>
        </div>
      ) : null}

      {outcome !== null ? (
        <p
          className="rt-review__outcome"
          ref={outcomeRef}
          tabIndex={-1}
          role="status"
          data-testid="review-outcome"
        >
          {OUTCOME_TEXT[outcome]}
        </p>
      ) : null}

      {pending !== null ? (
        <ReviewBlock
          playable={pending}
          approvals={project.approvals}
          busy={busy}
          onActivate={() => void decide(pending.version_id, false)}
          onDecline={() => void decide(pending.version_id, true)}
          hasActive={project.active_version_id !== null}
        />
      ) : null}

      {pending === null && active !== null ? (
        <div className="rt-review rt-current" data-testid="active-playable">
          <p className="rt-review__outcome">✓ Current. This is the version people play.</p>
          <p className="rt-studio__note">
            To see exactly what one influence contributed, use Revise below to build the same
            scene without it, then compare the two.
          </p>
          {observationsOf(active, project.approvals).length > 0 ? (
            <div className="rt-review__grid">
              <IntendedColumn observations={observationsOf(active, project.approvals)} />
              <ObservedColumn
                observations={observationsOf(active, project.approvals)}
                heading="In this version · observed"
              />
            </div>
          ) : null}
          <Candidate
            playable={active}
            prefix="active"
            heading="Play the current version"
            note="Every choice and reset here runs in your browser, through the same engine that checked it."
          />
          <details className="rt-record-details">
            <summary>Build record</summary>
            <p>
              Version <span className="rt-record-id" data-testid="active-version-id">{active.version_id}</span>
            </p>
          </details>
        </div>
      ) : null}

      {versions.length > 0 ? (
        <details className="rt-record-details">
          <summary>Every build of this project</summary>
          <ul data-testid="version-list">
            {versions.map((version) => (
              <li key={version.id}>
                {version.state === "pending"
                  ? "Awaiting review"
                  : version.state === "active"
                    ? "Current"
                    : "Earlier version"}{" "}
                · <span className="rt-record-id" data-testid={`version-${version.id}`}>{version.id}</span> ·{" "}
                {version.active_slots.length === 0
                  ? "foundation only"
                  : version.active_slots.join(" + ")}
              </li>
            ))}
          </ul>
        </details>
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
    <div className="rt-stages" aria-live="polite">
      <p className="rt-stages__state" data-testid="compile-state">
        {status.state}
        {busy && status.next_stage !== null ? ` · ${status.next_stage_label}…` : ""}
      </p>
      <ul className="rt-stages__list" data-testid="compile-stages">
        {status.stages.map((stage) => (
          <li key={stage.stage} data-testid={`stage-${stage.stage}`}>
            <span className="chip">{stage.status}</span> {stage.label}
            {stage.repaired ? " · repaired once" : ""}
          </li>
        ))}
      </ul>
      <p className="rt-studio__note" data-testid="compile-model-calls">
        Model calls so far: {status.model_calls}
      </p>
    </div>
  );
}

/** What the creator approved, in their own words: the intended side. */
function IntendedColumn({ observations }: { observations: readonly Observation[] }): React.JSX.Element {
  return (
    <div className="rt-review__intended" data-testid="review-intended">
      <p className="rt-review__column-head">You approved · intended</p>
      {observations.map((observation) => (
        <div key={observation.slot} className="rt-review__influence">
          <p className="rt-review__intent" data-testid={`intended-${observation.slot}`}>
            {observation.intendedEffect}
          </p>
          <p className="rt-review__from">
            From your interpretation of {observation.influenceName}: “{observation.approvedHead.head}
            {observation.approvedHead.truncated ? "…" : ""}”
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * What the build was observed to do: the engine's own replay of this build
 * with and without each influence, in player words. Never the raw witness
 * sentence, never an identifier.
 */
function ObservedColumn({
  observations,
  heading,
}: {
  observations: readonly Observation[];
  heading: string;
}): React.JSX.Element {
  return (
    <div className="rt-review__observed" data-testid="where-this-appears">
      <p className="rt-review__column-head">{heading}</p>
      {observations.map((observation) => (
        <div
          key={observation.slot}
          className="rt-review__influence"
          data-testid={`scene-changed-${observation.slot}`}
        >
          <p className="rt-review__after">
            {observation.prefixLabels.length === 0
              ? "At the start of the scene:"
              : `After ${observation.prefixLabels.join(" → ")}:`}
          </p>
          {observation.rows.length === 0 ? (
            <p className="rt-studio__note">
              No choice differs from the same build without {observation.influenceName} at that point.
            </p>
          ) : (
            <ul className="rt-review__rows">
              {observation.rows.map((row) => (
                <li key={row.id} className="rt-review__row">
                  <span className="rt-review__row-mark" aria-hidden="true">
                    *
                  </span>
                  {row.label} <span className="rt-review__reading">· {row.reading}</span>
                </li>
              ))}
            </ul>
          )}
          {observation.phrase === null ? null : (
            <p className="rt-review__phrase" data-testid={`witness-${observation.slot}`}>
              <PhraseText phrase={observation.phrase} />
            </p>
          )}
          {observation.requirements.map((requirement) => (
            <div key={requirement.label} className="rt-review__requirements">
              <p>
                <strong>
                  {requirement.label} has {numberWord(requirement.texts.length)} requirement
                  {requirement.texts.length === 1 ? "" : "s"} in this build.
                </strong>{" "}
                Check {requirement.texts.length === 1 ? "it" : "them"} against what you intended:
              </p>
              <ul>
                {requirement.texts.map((text) => (
                  <li key={text}>
                    <q>{text}</q>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Candidate({
  playable,
  prefix,
  heading,
  note,
  sectionRef,
}: {
  playable: PlayableView;
  prefix: "pending" | "active";
  heading: string;
  note: string;
  sectionRef?: React.Ref<HTMLElement>;
}): React.JSX.Element {
  return (
    <section
      className="rt-candidate rt-player"
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby={`candidate-${prefix}`}
      data-testid={`candidate-${prefix}`}
    >
      <h4 className="rt-label rt-review__column-head" id={`candidate-${prefix}`}>
        {heading}
      </h4>
      <p className="rt-studio__note">{note}</p>
      <ScenePlayer scene={playable.scene} testIdPrefix={prefix} />
    </section>
  );
}

/**
 * The review of a candidate build: intended against observed, then the three
 * decisions. Playing it changes nothing; making it current is the only action
 * that changes what people play.
 */
function ReviewBlock({
  playable,
  approvals,
  busy,
  onActivate,
  onDecline,
  hasActive,
}: {
  playable: PlayableView;
  approvals: readonly ApprovedInfluence[];
  busy: boolean;
  onActivate: () => void;
  onDecline: () => void;
  hasActive: boolean;
}): React.JSX.Element {
  const candidateRef = useRef<HTMLElement | null>(null);
  const observations = observationsOf(playable, approvals);
  const world = playable.scene.world;
  const endings = playable.scene.core.endings.length;

  return (
    <div className="rt-review" data-testid="pending-review" aria-labelledby="review-heading">
      <p className="rt-label rt-studio__eyebrow">
        {world.room.name} · {world.characters[0].name} · {world.object.name.toLowerCase()}
        {allEndingsReachable(playable) ? ` · all ${numberWord(endings)} endings still reachable` : ""}
      </p>
      <h3 className="rt-studio__title" id="review-heading">
        Did it do what you approved?
      </h3>
      <p className="rt-studio__lede">
        Play the new version before you decide. Nothing becomes current until you make it
        current.
      </p>

      {observations.length === 0 ? (
        <p className="rt-studio__note" data-testid="where-this-appears-empty">
          This version has no influence module composed. It is the clean brief-only foundation.
        </p>
      ) : (
        <div className="rt-review__grid">
          <IntendedColumn observations={observations} />
          <ObservedColumn observations={observations} heading="In this build · observed" />
        </div>
      )}

      <div className="rt-review__actions">
        <button
          type="button"
          className="rt-button"
          data-testid="play-candidate"
          onClick={() => {
            candidateRef.current?.scrollIntoView({ block: "start" });
            candidateRef.current?.focus({ preventScroll: true });
          }}
        >
          ▸ Play this version
        </button>
        <button
          type="button"
          className="rt-button rt-button--primary"
          data-testid="activate-version"
          disabled={busy}
          onClick={onActivate}
        >
          Make it current
        </button>
        <button
          type="button"
          className="rt-text-button"
          data-testid="decline-version"
          disabled={busy}
          onClick={onDecline}
        >
          {hasActive ? "Keep the current version" : "Discard this build"}
        </button>
        <p className="rt-studio__note">Building never makes a version current by itself.</p>
      </div>

      <Candidate
        playable={playable}
        prefix="pending"
        heading="Play this version"
        note="It runs here, through the same engine that checked it. Playing it changes nothing."
        sectionRef={candidateRef}
      />

      <details className="rt-record-details">
        <summary>Build record</summary>
        <p>
          Version <span className="rt-record-id" data-testid="pending-version-id">{playable.version_id}</span>,
          not current. Observed by replaying this build against the same build without each
          influence; it passed every interaction check.
        </p>
      </details>
    </div>
  );
}
