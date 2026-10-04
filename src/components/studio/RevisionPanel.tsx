"use client";

/**
 * The Phase 5 revision panel: change one idea, or one ending's wording.
 *
 * Functional, not polished — the visual system is phase 6's. What it has to be
 * is truthful, and that shapes every state here:
 *
 *   * **A preview says what will change before it is applied.** Removing names
 *     the slot and states that no generation happens. An ending rewrite is
 *     previewed as text and applied only on a second, explicit click.
 *   * **The label is the engine's.** A result says "mechanical" or "wording"
 *     because the stored diff says so. This panel never decides that, and never
 *     claims a mechanical success for a wording change.
 *   * **A refusal is finished.** The code and the sentence come from the server,
 *     the active version is named as still playing, and nothing is retried
 *     silently.
 *   * **Editing an interpretation does not generate anything here.** It records
 *     one immutable approval and says a rebuild is needed; the rebuild is the
 *     existing compile step, which recompiles that slot alone.
 */

import { useCallback, useState } from "react";
import type { PlayableView } from "@/domain/compile";
import type { ProjectView } from "@/domain/project";
import type { EndingCopyPreview, RevisionResponse } from "@/domain/revision";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

type Props = {
  projectId: string;
  project: ProjectView;
  /** The version on offer, which is what a revision revises. */
  playable: PlayableView | null;
  onChanged: () => void;
};

type Result = {
  kind: RevisionResponse["kind"];
  outcome: RevisionResponse["outcome"];
  label: string | null;
  summary: readonly string[];
};

export function RevisionPanel({
  projectId,
  project,
  playable,
  onChanged,
}: Props): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftEffect, setDraftEffect] = useState("");
  const [copyEnding, setCopyEnding] = useState<string | null>(null);
  const [copyRequest, setCopyRequest] = useState("");
  const [preview, setPreview] = useState<EndingCopyPreview | null>(null);

  const send = useCallback(
    async (command: Record<string, unknown>): Promise<RevisionResponse | null> => {
      setBusy(true);
      setFailure(null);
      const response = await postJson<RevisionResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/revisions`,
        { expected_revision: project.revision, ...command },
      );
      setBusy(false);
      if (!response.ok) {
        setFailure(response.failure);
        return null;
      }
      return response.value;
    },
    [projectId, project.revision],
  );

  const record = useCallback(
    (revised: RevisionResponse) => {
      setResult({
        kind: revised.kind,
        outcome: revised.outcome,
        label: revised.diff?.label ?? null,
        summary: revised.diff?.summary ?? [],
      });
    },
    [],
  );

  const remove = useCallback(
    async (slot: string) => {
      const revised = await send({ kind: "remove", slot });
      if (revised === null) return;
      record(revised);
      setEditing(null);
      onChanged();
    },
    [send, record, onChanged],
  );

  const edit = useCallback(
    async (slot: string) => {
      const revised = await send({
        kind: "edit",
        slot,
        approved_text: draftText,
        intended_effect: draftEffect,
      });
      if (revised === null) return;
      record(revised);
      setEditing(null);
      setDraftText("");
      setDraftEffect("");
      onChanged();
    },
    [send, record, draftText, draftEffect, onChanged],
  );

  const previewCopy = useCallback(
    async (endingId: string) => {
      const revised = await send({
        kind: "ending_copy_preview",
        ending_id: endingId,
        request: copyRequest,
      });
      if (revised === null || revised.preview === null) return;
      setPreview(revised.preview);
    },
    [send, copyRequest],
  );

  const applyCopy = useCallback(async () => {
    if (preview === null) return;
    const revised = await send({
      kind: "ending_copy_apply",
      ending_id: preview.ending_id,
      text: preview.proposed_text,
      preview_hash: preview.preview_hash,
    });
    if (revised === null) return;
    record(revised);
    setPreview(null);
    setCopyEnding(null);
    setCopyRequest("");
    onChanged();
  }, [preview, send, record, onChanged]);

  // Nothing to revise until a version has been confirmed.
  if (project.active_version_id === null) return null;

  const endings = playable?.scene.core.endings ?? [];
  const overrides = playable?.scene.ending_copy_overrides ?? [];

  return (
    <section className="panel" data-testid="revision-panel">
      <h2 className="panel__heading">Change one idea</h2>
      <p className="studio__hint">
        A revision changes one influence, or one ending&rsquo;s wording. Your
        brief, your room, your character, your object, and every other influence
        stay exactly as they are — and the version you confirmed keeps playing
        until you confirm the new one.
      </p>

      {project.approvals.length === 0 ? (
        <p className="studio__hint" data-testid="revision-no-influence">
          This version has no active influence, so there is none to change. The
          foundation is still playable and exportable.
        </p>
      ) : (
        <ul className="panel__list">
          {project.approvals.map((approval) => (
            <li key={approval.approval_id} data-testid={`revise-${approval.slot}`}>
              <span className="chip">{approval.slot}</span>{" "}
              <span className="studio__prose">{approval.approved_text}</span>
              <div className="studio__actions">
                <button
                  type="button"
                  className="button"
                  data-testid={`revise-remove-${approval.slot}`}
                  disabled={busy}
                  onClick={() => void remove(approval.slot)}
                >
                  Remove this influence
                </button>
                <button
                  type="button"
                  className="button"
                  data-testid={`revise-edit-${approval.slot}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing(editing === approval.slot ? null : approval.slot);
                    setDraftText(approval.approved_text);
                    setDraftEffect(approval.intended_effect);
                  }}
                >
                  Change what it means
                </button>
              </div>
              <p className="studio__hint">
                Removing it costs no generation at all: the scene is recomposed
                from the foundation and the influences that remain.
              </p>

              {editing === approval.slot ? (
                <div data-testid={`revise-form-${approval.slot}`}>
                  <label className="studio__label">
                    <span>What this influence means now</span>
                    <textarea
                      className="studio__input studio__input--area"
                      rows={3}
                      value={draftText}
                      data-testid={`revise-text-${approval.slot}`}
                      onChange={(event) => setDraftText(event.target.value)}
                    />
                  </label>
                  <label className="studio__label">
                    <span>What it should change in play</span>
                    <textarea
                      className="studio__input studio__input--area"
                      rows={2}
                      value={draftEffect}
                      data-testid={`revise-effect-${approval.slot}`}
                      onChange={(event) => setDraftEffect(event.target.value)}
                    />
                  </label>
                  <p className="studio__hint">
                    This records a new, immutable approval and keeps the one it
                    replaces in your history. The next build recompiles this
                    influence only — the foundation and the other influence are
                    reused exactly as they are.
                  </p>
                  <div className="studio__actions">
                    <button
                      type="button"
                      className="button button--primary"
                      data-testid={`revise-submit-${approval.slot}`}
                      disabled={busy || draftText.trim().length === 0}
                      onClick={() => void edit(approval.slot)}
                    >
                      Approve this wording
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="panel__heading">Change one ending&rsquo;s wording</h3>
      <p className="studio__hint">
        This is a writing change. It rewrites one ending&rsquo;s closing text and
        cannot change a choice, an outcome, or which endings are reachable — so
        it is labelled a wording change, never a mechanical one.
      </p>
      <ul className="panel__list" data-testid="ending-list">
        {endings.map((ending) => {
          const override = overrides.find((entry) => entry.ending_id === ending.id);
          return (
            <li key={ending.id} data-testid={`ending-${ending.id}`}>
              <span className="chip">{ending.title}</span>
              {override === undefined ? null : (
                <span className="studio__hint"> edited by you</span>
              )}
              <p className="line__text">{override?.text ?? ending.text}</p>
              <button
                type="button"
                className="button"
                data-testid={`ending-rewrite-${ending.id}`}
                disabled={busy}
                onClick={() => {
                  setCopyEnding(copyEnding === ending.id ? null : ending.id);
                  setPreview(null);
                }}
              >
                Rewrite this ending
              </button>

              {copyEnding === ending.id ? (
                <div data-testid={`ending-form-${ending.id}`}>
                  <label className="studio__label">
                    <span>
                      What should read differently? For example, &ldquo;make it kinder to
                      her&rdquo;.
                    </span>
                    <input
                      className="studio__input"
                      value={copyRequest}
                      data-testid={`ending-request-${ending.id}`}
                      onChange={(event) => setCopyRequest(event.target.value)}
                    />
                  </label>
                  <div className="studio__actions">
                    <button
                      type="button"
                      className="button"
                      data-testid={`ending-preview-${ending.id}`}
                      disabled={busy || copyRequest.trim().length < 3}
                      onClick={() => void previewCopy(ending.id)}
                    >
                      Preview the new wording
                    </button>
                  </div>

                  {preview !== null && preview.ending_id === ending.id ? (
                    <div data-testid="ending-preview">
                      <p className="studio__hint">
                        Nothing has changed yet. This is the proposed wording.
                      </p>
                      <p className="line__text" data-testid="ending-preview-text">
                        {preview.proposed_text}
                      </p>
                      <div className="studio__actions">
                        <button
                          type="button"
                          className="button button--primary"
                          data-testid="ending-apply"
                          disabled={busy}
                          onClick={() => void applyCopy()}
                        >
                          Apply this wording
                        </button>
                        <button
                          type="button"
                          className="button"
                          data-testid="ending-discard"
                          disabled={busy}
                          onClick={() => setPreview(null)}
                        >
                          Keep the wording I have
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {failure !== null ? (
        <InlineFailure failure={failure} testId="revision-failure" />
      ) : null}

      {result !== null ? (
        <div data-testid="revision-result">
          {result.outcome === "requires_compilation" ? (
            <p className="studio__hint" data-testid="revision-needs-build">
              Your new approval is recorded. Build the scene again to compile
              this influence; the foundation and any other influence are reused.
            </p>
          ) : (
            <>
              <p className="studio__hint" data-testid="revision-label">
                {result.label === "mechanical"
                  ? "Mechanical change: the interaction itself is different."
                  : result.label === "wording"
                    ? "Wording changed; interaction unchanged."
                    : "No change."}
              </p>
              <ul className="panel__list" data-testid="revision-summary">
                {result.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="studio__hint">
                The revised scene is waiting for your review above. Confirm it to
                make it current, or decline it to keep the version you have.
              </p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
