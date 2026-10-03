"use client";

/**
 * The persistent project view.
 *
 * It reads `GET /api/projects/:id` and nothing else. That one request is what
 * makes the phase 2 acceptance criteria observable in a browser:
 *
 *   * a reload re-fetches the project and the frozen brief is still there;
 *   * a different browser, with a different owner cookie or none at all, gets
 *     the same "not available here" state and learns nothing about whether the
 *     id exists;
 *   * a database outage produces a finished error with the saved example still
 *     one click away.
 *
 * It deliberately does *not* create a session. A clean browser opening somebody
 * else's project link must not quietly acquire one.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ProjectView } from "@/domain/project";
import { ErrorPanel, getJson, type RequestFailure } from "./shared";

type State =
  | { status: "loading" }
  | { status: "loaded"; project: ProjectView }
  | { status: "unavailable"; failure: RequestFailure }
  | { status: "failed"; failure: RequestFailure };

/** 401 and 404 are shown identically, so neither reveals that an id exists. */
const NOT_FOR_THIS_BROWSER = new Set(["SESSION_REQUIRED", "NOT_FOUND"]);

export function ProjectClient({ projectId }: { projectId: string }): React.JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const result = await getJson<{ project: ProjectView }>(
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
    if (result.ok) {
      setState({ status: "loaded", project: result.value.project });
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

  const { project } = state;
  return (
    <main className="studio">
      <header className="studio__header">
        <p className="cover__eyebrow">Persisted project · phase 2 shell</p>
        <h1 className="cover__title" data-testid="project-title">
          {project.title}
        </h1>
        <p className="studio__hint">
          Project <span data-testid="project-id">{project.id}</span> · revision{" "}
          <span data-testid="project-revision">{project.revision}</span> ·{" "}
          {project.workflow_state}
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

      <section className="panel">
        <h2 className="panel__heading">Not generated yet</h2>
        <ul className="panel__list">
          <li>
            Cultural anchor:{" "}
            {project.anchor_confirmed ? "confirmed" : "not confirmed — phase 3 retrieves references"}
          </li>
          <li>
            Approved influences:{" "}
            {project.approved_slots.length === 0
              ? "none — approval arrives in phase 3"
              : project.approved_slots.join(", ")}
          </li>
          <li>
            Playable version:{" "}
            {project.active_version_id ?? "none — compilation arrives in phase 4"}
          </li>
        </ul>
      </section>

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
