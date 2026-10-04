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
 * What it deliberately does not render: a revision control, an ending-copy
 * editor, a version comparison, or a share or export action. Those are phases
 * 5 and 6.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PlayableView, SceneVersionSummary } from "@/domain/compile";
import type { ProjectView, ReferencesView } from "@/domain/project";
import { AnchorPanel } from "./AnchorPanel";
import { CompilePanel } from "./CompilePanel";
import { ApprovedInfluences } from "./ApprovedInfluences";
import { ReferenceRows } from "./ReferenceRows";
import { ErrorPanel, getJson, type RequestFailure } from "./shared";

type Loaded = {
  project: ProjectView;
  references: ReferencesView | null;
  /** The version awaiting review, else the active one, else null. */
  /** Absent before phase 4 compiled anything; null when nothing is readable. */
  playable?: PlayableView | null;
  versions?: SceneVersionSummary[];
};

type State =
  | { status: "loading" }
  | { status: "loaded"; data: Loaded }
  | { status: "unavailable"; failure: RequestFailure }
  | { status: "failed"; failure: RequestFailure };

/** 401 and 404 are shown identically, so neither reveals that an id exists. */
const NOT_FOR_THIS_BROWSER = new Set(["SESSION_REQUIRED", "NOT_FOUND"]);

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
      <main className="studio">
        <p className="studio__note" aria-live="polite">
          Loading this project…
        </p>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="studio">
        <h1 className="cover__title">This project is not available here</h1>
        <p className="cover__lede" data-testid="project-unavailable">
          Editing access to a FirstPlayable project lives in the browser that
          created it. There is no account and no recovery.
        </p>
        <div className="studio__actions">
          <Link className="button button--primary" href="/studio">
            Create your own scene
          </Link>
          <Link className="button" href="/example">
            Play saved example
          </Link>
        </div>
      </main>
    );
  }

  if (state.status === "failed") {
    return (
      <main className="studio">
        <h1 className="cover__title">This project could not be loaded</h1>
        <ErrorPanel
          heading="Saving and loading are unavailable"
          failure={state.failure}
          onRetry={() => void load()}
        />
      </main>
    );
  }

  const { project, references, playable, versions } = state.data;
  return (
    <main className="studio">
      <header className="studio__header">
        <p className="cover__eyebrow">Persisted project · phase 4 compilation</p>
        <h1 className="cover__title" data-testid="project-title">
          {project.title}
        </h1>
        <p className="studio__hint">
          Project <span data-testid="project-id">{project.id}</span> · revision{" "}
          <span data-testid="project-revision">{project.revision}</span> ·{" "}
          <span data-testid="project-state">{project.workflow_state}</span>
        </p>
      </header>

      <section className="panel">
        <h2 className="panel__heading">Premise</h2>
        <p className="studio__prose" data-testid="project-premise">
          {project.brief.premise}
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__heading">Keep these fixed</h2>
        <ul className="panel__list">
          <li>
            <span className="chip">Room</span>{" "}
            <span data-testid="project-room">{project.brief.room.name}</span> —{" "}
            {project.brief.room.description}
          </li>
          <li>
            <span className="chip">You</span>{" "}
            <span data-testid="project-role">{project.brief.player_role}</span>
          </li>
          <li>
            <span className="chip">Character</span>{" "}
            <span data-testid="project-character">{project.brief.character.name}</span> —{" "}
            {project.brief.character.role}
          </li>
          <li>
            <span className="chip">Object</span>{" "}
            <span data-testid="project-object">{project.brief.object.name}</span> —{" "}
            {project.brief.object.description}
          </li>
          <li>
            <span className="chip">Tone</span> {project.brief.tone}
          </li>
        </ul>
      </section>

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
        onChanged={() => void load()}
      />

      <ApprovedInfluences
        projectId={project.id}
        project={project}
        onChanged={() => void load()}
      />

      <CompilePanel
        projectId={project.id}
        project={project}
        playable={playable ?? null}
        versions={versions ?? []}
        onChanged={() => void load()}
      />

      <div className="studio__actions">
        <Link className="button" href="/studio">
          Start another brief
        </Link>
        <Link className="button" href="/example">
          Play saved example
        </Link>
      </div>
    </main>
  );
}
