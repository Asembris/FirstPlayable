"use client";

/**
 * Publishing a version, revoking a link, and downloading an offline playable.
 *
 * The three rules this panel exists to make visible:
 *
 *   * **Preview before publish.** The preview shows the title, the version, the
 *     influences, and the source chain exactly as a viewer would see them, and
 *     the publish request carries the hash of that document. Change the
 *     disclosure choice after previewing and the server refuses rather than
 *     publishing something else.
 *   * **One link is one version.** The link names the version it was made from
 *     and keeps playing that version after the project moves on. The panel says
 *     so rather than implying a link follows the latest scene.
 *   * **A download cannot be recalled.** The warning is the server's own
 *     sentence, shown beside both publish and export, before either is used.
 *
 * The read token appears exactly once, when the link is created: only its hash
 * is stored, so the panel says plainly that it cannot show the link again.
 */

import { useCallback, useState } from "react";
import type { PlayableView, SceneVersionSummary } from "@/domain/compile";
import type { ProjectView } from "@/domain/project";
import type {
  PublicationSummary,
  PublicSnapshot,
  PublishResponse,
} from "@/domain/publish";
import { SHARE_WARNING } from "@/domain/publish";
import { deleteJson, InlineFailure, postJson, type RequestFailure } from "./shared";

type Props = {
  projectId: string;
  project: ProjectView;
  playable: PlayableView | null;
  versions: readonly SceneVersionSummary[];
  publications: readonly PublicationSummary[];
  onChanged: () => void;
};

type Preview = { snapshot: PublicSnapshot; hash: string; includeProvenance: boolean };

export function PublishPanel({
  projectId,
  project,
  playable,
  versions,
  publications,
  onChanged,
}: Props): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [includeProvenance, setIncludeProvenance] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const activeVersionId = project.active_version_id;

  const publishable = versions.filter((version) => version.state !== "pending");
  const [versionId, setVersionId] = useState<string | null>(activeVersionId);
  const selected = versionId ?? activeVersionId;

  const call = useCallback(
    async (payload: Record<string, unknown>): Promise<PublishResponse | null> => {
      setBusy(true);
      setFailure(null);
      const response = await postJson<PublishResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/publish`,
        { expected_revision: project.revision, ...payload },
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

  const runPreview = useCallback(async () => {
    if (selected === null) return;
    const result = await call({
      version_id: selected,
      include_provenance: includeProvenance,
      preview: true,
    });
    if (result === null) return;
    setLink(null);
    setPreview({
      snapshot: result.snapshot,
      hash: result.snapshot_hash,
      includeProvenance,
    });
  }, [call, selected, includeProvenance]);

  const runPublish = useCallback(async () => {
    if (preview === null || selected === null) return;
    const result = await call({
      version_id: selected,
      // Exactly what was previewed, including the disclosure choice.
      include_provenance: preview.includeProvenance,
      preview: false,
      snapshot_hash: preview.hash,
    });
    if (result === null) return;
    setLink(result.play_path);
    setPreview(null);
    onChanged();
  }, [call, preview, selected, onChanged]);

  const revoke = useCallback(
    async (publicationId: string) => {
      setBusy(true);
      setFailure(null);
      const response = await deleteJson(
        `/api/publications/${encodeURIComponent(publicationId)}`,
      );
      setBusy(false);
      if (!response.ok) {
        setFailure(response.failure);
        return;
      }
      setLink(null);
      onChanged();
    },
    [onChanged],
  );

  if (activeVersionId === null) return null;

  const exportPath = `/api/projects/${encodeURIComponent(projectId)}/export?version=${encodeURIComponent(
    selected ?? activeVersionId,
  )}${includeProvenance ? "" : "&provenance=0"}`;

  return (
    <section className="panel" data-testid="publish-panel">
      <h2 className="panel__heading">Share or download</h2>
      <p className="studio__hint" data-testid="share-warning">
        {SHARE_WARNING}
      </p>

      <label className="studio__label">
        <span>Which version</span>
        <select
          className="studio__input"
          data-testid="publish-version"
          value={selected ?? ""}
          onChange={(event) => {
            setVersionId(event.target.value);
            setPreview(null);
            setLink(null);
          }}
        >
          {publishable.map((version) => (
            <option key={version.id} value={version.id}>
              {version.id} · {version.state} ·{" "}
              {version.active_slots.length === 0
                ? "foundation only"
                : version.active_slots.join(" + ")}
            </option>
          ))}
        </select>
      </label>
      <p className="studio__hint">
        A link names this exact version forever. Revising the project later does
        not change what somebody with this link plays.
      </p>

      <label className="studio__label">
        <input
          type="checkbox"
          data-testid="publish-provenance"
          checked={includeProvenance}
          onChange={(event) => {
            setIncludeProvenance(event.target.checked);
            setPreview(null);
          }}
        />{" "}
        <span>
          Include the source chain: which reference, what was proposed, what you
          approved, and what the engine observed
        </span>
      </label>

      <div className="studio__actions">
        <button
          type="button"
          className="button"
          data-testid="publish-preview"
          disabled={busy || selected === null}
          onClick={() => void runPreview()}
        >
          Preview what will be public
        </button>
        <a
          className="button"
          data-testid="export-download"
          href={exportPath}
          download
        >
          Download an offline playable
        </a>
      </div>
      <p className="studio__hint">
        The download is one HTML file. It plays from your disk with no network,
        no account, and no service of any kind, and it contains exactly what a
        link would have shown.
      </p>

      {preview !== null ? (
        <div data-testid="publish-preview-body">
          <h3 className="panel__heading">This is what a viewer would see</h3>
          <p className="studio__hint">
            Nothing is public yet. Publishing creates the link.
          </p>
          <ul className="panel__list">
            <li>
              Title: <span data-testid="preview-title">{preview.snapshot.title}</span>
            </li>
            <li>
              Version:{" "}
              <span data-testid="preview-version">{preview.snapshot.version_id}</span>
            </li>
            <li>
              Influences:{" "}
              {preview.snapshot.active_slots.length === 0
                ? "none — the foundation alone"
                : preview.snapshot.active_slots.join(" + ")}
            </li>
            <li data-testid="preview-provenance">
              Source chain:{" "}
              {preview.snapshot.provenance_included
                ? `included, ${preview.snapshot.provenance.length} chain(s)`
                : "not included"}
            </li>
          </ul>
          <p className="studio__hint">
            Your brief, your premise, the artist you searched for, anything you
            dismissed, and every other version stay private. None of them is in
            this document.
          </p>
          <div className="studio__actions">
            <button
              type="button"
              className="button button--primary"
              data-testid="publish-confirm"
              disabled={busy}
              onClick={() => void runPublish()}
            >
              Publish this version
            </button>
            <button
              type="button"
              className="button"
              data-testid="publish-cancel"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Not yet
            </button>
          </div>
        </div>
      ) : null}

      {link !== null ? (
        <div className="studio__error" data-testid="publish-link" role="status">
          <p className="studio__error-heading">Your link is ready</p>
          <p className="studio__error-message" data-testid="publish-link-path">
            {link}
          </p>
          <p className="studio__hint">
            This is the only time this link is shown: only a hash of it is
            stored, so it cannot be looked up again. Copy it now. Withdrawing it
            below stops new reads within five minutes.
          </p>
        </div>
      ) : null}

      {publications.length > 0 ? (
        <>
          <h3 className="panel__heading">Links you have made</h3>
          <ul className="panel__list" data-testid="publication-list">
            {publications.map((publication) => (
              <li key={publication.id} data-testid={`publication-${publication.id}`}>
                <span className="chip">
                  {publication.revoked_at === null ? "live" : "withdrawn"}
                </span>{" "}
                version {publication.scene_version_id} · made {publication.created_at}
                {publication.provenance_included ? " · with the source chain" : ""}
                {publication.revoked_at === null ? (
                  <button
                    type="button"
                    className="button"
                    data-testid={`revoke-${publication.id}`}
                    disabled={busy}
                    onClick={() => void revoke(publication.id)}
                  >
                    Withdraw this link
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="studio__hint">
            Withdrawing a link stops new reads. It cannot recall a file somebody
            already downloaded or a page they already have open.
          </p>
        </>
      ) : null}

      {failure !== null ? (
        <InlineFailure failure={failure} testId="publish-failure" />
      ) : null}

      {playable !== null && playable.state === "pending" ? (
        <p className="studio__hint" data-testid="publish-pending-note">
          The version awaiting your review cannot be published until you confirm
          it.
        </p>
      ) : null}
    </section>
  );
}
