"use client";

/**
 * The approved influences and their provenance drawer, on the Rehearsal Table.
 *
 * One chip per approved slot, each with where it stands: "Not built yet",
 * "Built · awaiting your review", or "In the current version". Opening a chip
 * shows exactly three layers, each in its own material:
 *
 *   * **Qloo retrieved** — the catalogue slip: the reference, one supported
 *     context sentence, the artist, and the capture date. The original
 *     response rank and the evidence field paths sit behind a second
 *     disclosure.
 *   * **FirstPlayable proposed** — the suggestion, in pencil, labelled a
 *     FirstPlayable interpretation.
 *   * **Creator approved** — the exact frozen wording in ink, marked "Edited
 *     by you" when it differs from what was proposed.
 *
 * There is no fourth line here. "The scene changed" is something only a build
 * can observe, and it is shown on the review of that build, never on an
 * approval.
 */

import { useState } from "react";
import type { AnchorView, ProjectView, ProvenanceView } from "@/domain/project";
import type { ApprovedInfluence, Slot } from "@/domain/influence";
import { BUILD_STATUS_LABEL, buildStatusOf } from "@/presentation/review";
import { EditedMark } from "../rehearsal/CausalNote";
import type { Builds } from "./ReferenceRows";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

const SLOT_LABEL: Record<Slot, string> = {
  discovery: "Discovery",
  commitment: "Commitment",
};

export type ApprovedInfluencesProps = {
  projectId: string;
  project: ProjectView;
  builds: Builds;
  onChanged: () => void;
};

export function ApprovedInfluences({
  projectId,
  project,
  builds,
  onChanged,
}: ApprovedInfluencesProps): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);

  const chains = new Map(project.provenance.map((chain) => [chain.approval_id, chain]));

  async function remove(slot: Slot): Promise<void> {
    setBusy(true);
    setFailure(null);
    const result = await postJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/decisions`,
      { expected_revision: project.revision, kind: "remove", slot },
    );
    setBusy(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(null);
    onChanged();
  }

  return (
    <section className="rt rt-studio rt-approved" aria-labelledby="approved-heading">
      <p className="rt-label rt-studio__eyebrow">03 · Your decisions</p>
      <h2 className="rt-studio__title rt-studio__title--small" id="approved-heading">
        Approved influences
      </h2>

      {project.approvals.length === 0 ? (
        <p className="rt-studio__lede" data-testid="no-approvals">
          None yet. Retrieved references and proposed interactions are not
          approvals — you approve each one explicitly.
        </p>
      ) : (
        <>
          <ul className="influence-chips rt-approved__list" data-testid="approved-chips">
            {project.approvals.map((approval) => {
              const status = buildStatusOf(approval, builds);
              return (
                <li key={approval.approval_id} className="rt-approved__item">
                  <button
                    className="chip influence-chip"
                    type="button"
                    aria-expanded={open === approval.approval_id}
                    aria-controls={`provenance-${approval.slot}`}
                    data-testid={`approved-chip-${approval.slot}`}
                    onClick={() =>
                      setOpen(open === approval.approval_id ? null : approval.approval_id)
                    }
                  >
                    {SLOT_LABEL[approval.slot]}: {approval.reference_name}
                    {approval.edited_by_creator ? " · edited" : ""}
                  </button>
                  <span
                    className={`rt-chip${status === "current" ? "" : " rt-chip--dashed"}`}
                    data-testid={`approved-build-${approval.slot}`}
                  >
                    {BUILD_STATUS_LABEL[status]}
                  </span>
                </li>
              );
            })}
          </ul>

          {failure !== null && <InlineFailure failure={failure} testId="approval-failure" />}

          {project.approvals
            .filter((approval) => approval.approval_id === open)
            .map((approval) => (
              <ProvenanceDrawer
                key={approval.approval_id}
                approval={approval}
                chain={chains.get(approval.approval_id) ?? null}
                anchor={project.anchor}
                busy={busy}
                onRemove={() => void remove(approval.slot)}
              />
            ))}
        </>
      )}

      <p className="rt-studio__note rt-approved__rule">
        One Discovery and one Commitment approval at most. Approving changes no scene:
        build below when you are ready, then review what the build did.
      </p>
    </section>
  );
}

function ProvenanceDrawer({
  approval,
  chain,
  anchor,
  busy,
  onRemove,
}: {
  approval: ApprovedInfluence;
  chain: ProvenanceView | null;
  anchor: AnchorView | null;
  busy: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      className="drawer"
      id={`provenance-${approval.slot}`}
      data-testid={`provenance-${approval.slot}`}
    >
      <ol className="drawer__chain">
        <li className="drawer__layer">
          <p className="drawer__label">Qloo retrieved</p>
          {chain?.retrieved === null || chain === null ? (
            <p className="studio__hint">
              The original capture for this approval is no longer readable.
            </p>
          ) : (
            <div className="rt-drawer__slip">
              <p>
                <strong>{chain.retrieved.reference_name}</strong>
                {" · "}
                {chain.retrieved.domain === "movie" ? "movie" : "videogame"}
                {chain.retrieved.year !== null ? ` · ${chain.retrieved.year}` : ""}
              </p>
              {chain.retrieved.context !== null && (
                <p data-testid={`provenance-context-${approval.slot}`}>
                  “{chain.retrieved.context}”
                </p>
              )}
              <p>
                Retrieved for {anchor?.name ?? "the confirmed artist"} on{" "}
                {chain.retrieved.captured_at.slice(0, 10)}
              </p>
              <details className="disclosure">
                <summary data-testid={`provenance-detail-${approval.slot}`}>
                  Where this came from
                </summary>
                <ul className="panel__list">
                  <li>Original response position: {chain.retrieved.original_rank}</li>
                  {chain.retrieved.evidence.map((item) => (
                    <li key={item.id}>
                      <code>{item.field_path}</code> — {item.text}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </li>

        <li className="drawer__layer">
          <p className="drawer__label">FirstPlayable proposed</p>
          <p className="rt-suggestion">{approval.proposed_idea}</p>
          <p className="studio__hint">
            {approval.proposed_relevance} — {chain?.proposed.attribution ?? "FirstPlayable interpretation"}.
          </p>
        </li>

        <li className="drawer__layer drawer__layer--decision">
          <p className="drawer__label">Creator approved</p>
          {approval.edited_by_creator && (
            <p className="rt-drawer__edited">
              <EditedMark testId={`edited-by-you-${approval.slot}`} />
            </p>
          )}
          <p className="rt-decision" data-testid={`approved-text-${approval.slot}`}>
            {approval.approved_text}
          </p>
          <p className="studio__hint">
            What should change in play: {approval.intended_effect} · {SLOT_LABEL[approval.slot]} ·
            approved {approval.approved_at.slice(0, 10)}
          </p>
          {approval.predecessor_id !== null && (
            <p className="studio__hint" data-testid={`replaced-${approval.slot}`}>
              This replaced an earlier approval for the same slot. The earlier one
              is still on record.
            </p>
          )}
        </li>
      </ol>

      <div className="rt-studio__actions">
        <button
          className="rt-button"
          type="button"
          data-testid={`remove-${approval.slot}`}
          disabled={busy}
          onClick={onRemove}
        >
          {busy ? "Removing…" : "Remove this influence"}
        </button>
      </div>
    </div>
  );
}
