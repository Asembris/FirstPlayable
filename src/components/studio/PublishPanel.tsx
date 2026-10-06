"use client";

/**
 * Publishing a version, revoking a link, and downloading an offline playable.
 *
 * Phase 6 sets it as the last sheet on the desk: one version chosen in the
 * creator's words, a preview that looks like what a viewer gets, then the
 * link. The three rules this panel exists to make visible are unchanged:
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
import { shortVersion, slotsLabel, versionOptionLabel, whenLabel } from "@/presentation/share";
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
  const [copied, setCopied] = useState(false);

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
    setCopied(false);
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

  const copy = useCallback(async () => {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(new URL(link, window.location.href).href);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the link is still on screen to copy by hand.
      setCopied(false);
    }
  }, [link]);

  if (activeVersionId === null) return null;

  const exportPath = `/api/projects/${encodeURIComponent(projectId)}/export?version=${encodeURIComponent(
    selected ?? activeVersionId,
  )}${includeProvenance ? "" : "&provenance=0"}`;

  return (
    <section
      className="rt rt-studio rt-share"
      id="share"
      data-testid="publish-panel"
      aria-labelledby="share-heading"
    >
      <header className="rt-studio__head">
        <p className="rt-label rt-studio__eyebrow">05 · Share</p>
        <h2 className="rt-studio__title rt-studio__title--small" id="share-heading">
          Share one version
        </h2>
        <p className="rt-studio__lede">
          A link plays one fixed version, read-only, in any browser. A download is one HTML file
          that plays from a disk. Preview first: nothing is public until you publish.
        </p>
      </header>

      <p className="rt-share__warning" data-testid="share-warning">
        {SHARE_WARNING}
      </p>

      <div className="rt-share__grid">
        <div className="rt-share__choose">
          <label className="rt-field">
            <span className="rt-field__label">Which version</span>
            <select
              className="rt-field__input rt-field__input--plain rt-share__select"
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
                  {versionOptionLabel(version)}
                </option>
              ))}
            </select>
          </label>
          <p className="rt-studio__note">
            A link names this exact version forever. Revising the project later does
            not change what somebody with this link plays.
          </p>

          <label className="rt-share__check">
            <input
              type="checkbox"
              data-testid="publish-provenance"
              checked={includeProvenance}
              onChange={(event) => {
                setIncludeProvenance(event.target.checked);
                setPreview(null);
              }}
            />
            <span>
              Include the source chain: which reference, what was proposed, what you
              approved, and what the engine observed
            </span>
          </label>

          <div className="rt-studio__actions">
            <button
              type="button"
              className="rt-button rt-button--primary"
              data-testid="publish-preview"
              disabled={busy || selected === null}
              onClick={() => void runPreview()}
            >
              Preview what will be public
            </button>
            <a className="rt-button" data-testid="export-download" href={exportPath} download>
              Download an offline playable
            </a>
          </div>
          <p className="rt-studio__note">
            The download is one HTML file. It plays from your disk with no network,
            no account, and no service of any kind, and it contains exactly what a
            link would have shown.
          </p>
        </div>

        <div className="rt-share__result">
          {preview === null && link === null ? (
            <p className="rt-studio__note rt-share__idle">
              The preview appears here, exactly as a viewer would get it.
            </p>
          ) : null}

          {preview !== null ? (
            <div className="rt-share__preview" data-testid="publish-preview-body">
              <h3 className="rt-label rt-share__heading">This is what a viewer would see</h3>
              <p className="rt-studio__note">
                Nothing is public yet. Publishing creates the link.
              </p>
              <div className="rt-share__specimen">
                <p className="rt-label rt-share__specimen-kind">Shared playable · play only</p>
                <p className="rt-share__specimen-title" data-testid="preview-title">
                  {preview.snapshot.title}
                </p>
                <dl className="rt-share__facts">
                  <div>
                    <dt>Version</dt>
                    <dd data-testid="preview-version">
                      {shortVersion(preview.snapshot.version_id)} · built{" "}
                      {whenLabel(preview.snapshot.created_at)}
                    </dd>
                  </div>
                  <div>
                    <dt>Influences</dt>
                    <dd>
                      {preview.snapshot.active_slots.length === 0
                        ? "none — the foundation alone"
                        : slotsLabel(preview.snapshot.active_slots)}
                    </dd>
                  </div>
                  <div>
                    <dt>Source chain</dt>
                    <dd data-testid="preview-provenance">
                      {preview.snapshot.provenance_included
                        ? `included, ${preview.snapshot.provenance.length} chain${preview.snapshot.provenance.length === 1 ? "" : "s"}`
                        : "not included"}
                    </dd>
                  </div>
                </dl>
              </div>
              <p className="rt-studio__note">
                Your brief, your premise, the artist you searched for, anything you
                dismissed, and every other version stay private. None of them is in
                this document.
              </p>
              <div className="rt-studio__actions">
                <button
                  type="button"
                  className="rt-button rt-button--primary"
                  data-testid="publish-confirm"
                  disabled={busy}
                  onClick={() => void runPublish()}
                >
                  Publish this version
                </button>
                <button
                  type="button"
                  className="rt-text-button"
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
            <div className="rt-share__link" data-testid="publish-link" role="status">
              <p className="rt-share__link-heading">Your link is ready</p>
              <p className="rt-share__path" data-testid="publish-link-path">
                {link}
              </p>
              <div className="rt-studio__actions">
                <button type="button" className="rt-button rt-button--primary" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy the link"}
                </button>
                <a className="rt-button" href={link} target="_blank" rel="noreferrer">
                  Open it
                </a>
              </div>
              <p className="rt-studio__note">
                This is the only time this link is shown: only a hash of it is
                stored, so it cannot be looked up again. Copy it now. Withdrawing it
                below stops new reads within five minutes.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      {publications.length > 0 ? (
        <>
          <h3 className="rt-label rt-share__heading rt-share__list-heading">Links you have made</h3>
          <ul className="rt-share__list" data-testid="publication-list">
            {publications.map((publication) => (
              <li
                key={publication.id}
                className="rt-share__item"
                data-testid={`publication-${publication.id}`}
              >
                <span
                  className={`rt-chip${publication.revoked_at === null ? "" : " rt-chip--dashed"}`}
                >
                  {publication.revoked_at === null ? "live" : "withdrawn"}
                </span>
                <span className="rt-share__item-text">
                  Version {shortVersion(publication.scene_version_id)} · made{" "}
                  {whenLabel(publication.created_at)}
                  {publication.provenance_included ? " · with the source chain" : ""}
                </span>
                {publication.revoked_at === null ? (
                  <button
                    type="button"
                    className="rt-text-button"
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
          <p className="rt-studio__note rt-share__after">
            Withdrawing a link stops new reads. It cannot recall a file somebody
            already downloaded or a page they already have open.
          </p>
        </>
      ) : null}

      {failure !== null ? (
        <InlineFailure failure={failure} testId="publish-failure" />
      ) : null}

      {playable !== null && playable.state === "pending" ? (
        <p className="rt-studio__note rt-share__after" data-testid="publish-pending-note">
          The version awaiting your review cannot be published until you confirm
          it.
        </p>
      ) : null}
    </section>
  );
}
