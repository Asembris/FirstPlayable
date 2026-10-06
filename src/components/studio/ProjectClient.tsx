"use client";

/**
 * The persistent project view, extended for the phase 3 workflow.
 *
 * It reads `GET /api/projects/:id` and renders, in order: the frozen brief,
 * the cultural anchor, the two reference rows with their proposals and
 * decision controls, and the approved-influence chips. Every mutation goes
 * through this application's own same-origin API and is followed by a re-read,
 * so what the creator sees is always the persisted state rather than an
 * optimistic guess.
 *
 * Still true from phase 2, and still load-bearing:
 *
 *   * a reload re-fetches the project and the frozen brief is still there;
 *   * a different browser gets the same "not available here" state and learns
 *     nothing about whether the id exists;
 *   * a database outage produces a finished error with the saved example one
 *     click away;
 *   * this component creates no session, so opening somebody else's link does
 *     not quietly acquire one.
 *
 * Phase 4 adds the compilation panel at the bottom: build the playable scene
 * from the frozen approvals, watch the stages truthfully, play the pending
 * result locally through the Phase 1 engine, and confirm or decline it. A
 * compiled scene never becomes the active version by itself.
 *
 * Phase 5 adds the three panels below the compilation one: change one idea or
 * one ending's wording, compare the previous and current versions by replaying
 * the same choices locally, and publish a version-pinned read-only link or
 * download a self-contained offline playable.
 *
 * Phase 6 sets all of it on the Rehearsal Table desk: the brief as the scene
 * page's world strip, title, and cast; a step line that says where the
 * project stands in the creator's terms; and the record ids kept in a
 * disclosure rather than in the heading.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PlayableView, SceneVersionSummary } from "@/domain/compile";
import type { ProjectView, ReferencesView } from "@/domain/project";
import type { PublicationSummary } from "@/domain/publish";
import { AnchorPanel } from "./AnchorPanel";
import { CompilePanel } from "./CompilePanel";
import { ApprovedInfluences } from "./ApprovedInfluences";
import { PublishPanel } from "./PublishPanel";
import { ReferenceRows } from "./ReferenceRows";
import { RevisionPanel } from "./RevisionPanel";
import { VersionCompare } from "./VersionCompare";
import { ErrorPanel, getJson, type RequestFailure } from "./shared";
import { DeskMessage, StudioDesk } from "./StudioDesk";

type Loaded = {
  project: ProjectView;
  references: ReferencesView | null;
  /** The version awaiting review, else the active one, else null. */
  /** Absent before phase 4 compiled anything; null when nothing is readable. */
  playable?: PlayableView | null;
  /** The version `playable` revised, for the local previous/current comparison. */
  previous_playable?: PlayableView | null;
  versions?: SceneVersionSummary[];
  publications?: PublicationSummary[];
};

type State =
  | { status: "loading" }
  | { status: "loaded"; data: Loaded }
  | { status: "unavailable"; failure: RequestFailure }
  | { status: "failed"; failure: RequestFailure };

/** 401 and 404 are shown identically, so neither reveals that an id exists. */
const NOT_FOR_THIS_BROWSER = new Set(["SESSION_REQUIRED", "NOT_FOUND"]);

type Step = { href: string; label: string; status: string; done: boolean };

/** Where the project stands, in the creator's words rather than the workflow's. */
function stepsOf(
  project: ProjectView,
  playable: PlayableView | null,
  publications: readonly PublicationSummary[],
): Step[] {
  const approved = project.approvals.length;
  const live = publications.filter((publication) => publication.revoked_at === null).length;
  return [
    { href: "#brief", label: "Brief", status: "saved", done: true },
    {
      href: "#artist",
      label: "Artist",
      status: project.anchor === null ? "not chosen" : project.anchor.name,
      done: project.anchor !== null,
    },
    {
      href: "#influences",
      label: "Influences",
      status: approved === 0 ? "none approved" : `${approved} approved`,
      done: approved > 0,
    },
    {
      href: "#build",
      label: "Build",
      status:
        playable?.state === "pending"
          ? "awaiting review"
          : project.active_version_id !== null
            ? "current version"
            : "not built",
      done: project.active_version_id !== null,
    },
    {
      // Sharing opens once a version is current; until then the way there is the build.
      href: project.active_version_id === null ? "#build" : "#share",
      label: "Share",
      status: live === 0 ? "private" : `${live} live link${live === 1 ? "" : "s"}`,
      done: live > 0,
    },
  ];
}

export function ProjectClient({ projectId }: { projectId: string }): React.JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    const result = await getJson<Loaded>(`/api/projects/${encodeURIComponent(projectId)}`);
    if (result.ok) {
      setState({ status: "loaded", data: result.value });
      return;
    }
    setState({
      status: NOT_FOR_THIS_BROWSER.has(result.failure.code) ? "unavailable" : "failed",
      failure: result.failure,
    });
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <StudioDesk crumb="Your scene">
        <p className="rt-studio__note rt-desk__loading" aria-live="polite">
          Loading this project…
        </p>
      </StudioDesk>
    );
  }

  if (state.status === "unavailable") {
    return (
      <StudioDesk crumb="Your scene">
        <DeskMessage title="This project is not available here">
          <p className="rt-studio__lede" data-testid="project-unavailable">
            Editing access to a FirstPlayable project lives in the browser that
            created it. There is no account and no recovery.
          </p>
          <div className="rt-studio__actions">
            <Link className="rt-button rt-button--primary" href="/studio">
              Create your own scene
            </Link>
            <Link className="rt-button" href="/difference">
              Play saved example
            </Link>
          </div>
        </DeskMessage>
      </StudioDesk>
    );
  }

  if (state.status === "failed") {
    return (
      <StudioDesk crumb="Your scene">
        <DeskMessage title="This project could not be loaded">
          <ErrorPanel
            heading="Saving and loading are unavailable"
            failure={state.failure}
            onRetry={() => void load()}
          />
        </DeskMessage>
      </StudioDesk>
    );
  }

  const { project, references, playable, versions, publications } = state.data;
  const previous = state.data.previous_playable ?? null;
  // Which builds exist, so an approval can say truthfully whether any build
  // carries it yet. Approving alone never changes a scene.
  const builds = {
    pending: playable?.state === "pending" ? playable.scene : null,
    active:
      playable?.state === "active"
        ? playable.scene
        : previous?.state === "active"
          ? previous.scene
          : null,
  };
  const { brief } = project;
  const steps = stepsOf(project, playable ?? null, publications ?? []);
  return (
    <StudioDesk crumb={project.title}>
      <header className="rt-desk__head rt-project" id="brief">
        <p className="rt-strip rt-project__strip">
          <span className="rt-label rt-strip__room" data-testid="project-room">
            {brief.room.name}
          </span>
          <span className="rt-strip__desc">{brief.room.description}</span>
        </p>
        <h1 className="rt-desk__title rt-project__title" data-testid="project-title">
          {project.title}
        </h1>

        <div className="rt-project__brief">
          <section aria-labelledby="premise-heading">
            <h2 className="rt-label rt-project__label" id="premise-heading">
              Premise · your brief
            </h2>
            <p className="rt-project__premise" data-testid="project-premise">
              {brief.premise}
            </p>
          </section>

          <aside className="rt-project__cast" aria-labelledby="fixed-heading">
            <h2 className="rt-label rt-project__label" id="fixed-heading">
              In this scene · kept fixed
            </h2>
            <dl className="rt-cast__list">
              <div>
                <dt data-testid="project-character">{brief.character.name}</dt>
                <dd>{brief.character.role}</dd>
              </div>
              <div>
                <dt data-testid="project-object">{brief.object.name}</dt>
                <dd>{brief.object.description}</dd>
              </div>
              <div>
                <dt>You</dt>
                <dd data-testid="project-role">{brief.player_role}</dd>
              </div>
              <div>
                <dt>Tone</dt>
                <dd>{brief.tone}</dd>
              </div>
            </dl>
          </aside>
        </div>

        <nav className="rt-steps" aria-label="Where this scene stands">
          <ol className="rt-steps__list">
            {steps.map((step, index) => (
              <li key={step.href} className="rt-steps__item" data-done={step.done}>
                <a className="rt-steps__link" href={step.href}>
                  <span className="rt-steps__num" aria-hidden="true">
                    {step.done ? "✓" : String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="rt-steps__label">{step.label}</span>
                  <span className="rt-steps__status">{step.status}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <details className="rt-record-details rt-project__record">
          <summary>Project record</summary>
          <p>
            Project <span className="rt-record-id" data-testid="project-id">{project.id}</span> ·
            revision <span data-testid="project-revision">{project.revision}</span> · state{" "}
            <span className="rt-record-id" data-testid="project-state">
              {project.workflow_state}
            </span>
          </p>
        </details>
      </header>

      <AnchorPanel
        projectId={project.id}
        revision={project.revision}
        anchor={project.anchor}
        onConfirmed={() => void load()}
      />

      <ReferenceRows
        projectId={project.id}
        project={project}
        references={references}
        builds={builds}
        onChanged={() => void load()}
      />

      <ApprovedInfluences
        projectId={project.id}
        project={project}
        builds={builds}
        onChanged={() => void load()}
      />

      <CompilePanel
        projectId={project.id}
        project={project}
        playable={playable ?? null}
        versions={versions ?? []}
        onChanged={() => void load()}
      />

      <RevisionPanel
        projectId={project.id}
        project={project}
        playable={playable ?? null}
        previous={previous}
        onChanged={() => void load()}
      />

      {playable != null && previous !== null ? (
        <VersionCompare current={playable} previous={previous} />
      ) : null}

      <PublishPanel
        projectId={project.id}
        project={project}
        playable={playable ?? null}
        versions={versions ?? []}
        publications={publications ?? []}
        onChanged={() => void load()}
      />

      <div className="rt-studio__actions rt-desk__foot">
        <Link className="rt-button" href="/studio">
          Start another brief
        </Link>
        <Link className="rt-button" href="/difference">
          Play saved example
        </Link>
      </div>
    </StudioDesk>
  );
}
