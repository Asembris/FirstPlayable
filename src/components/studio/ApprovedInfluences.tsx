"use client";

/**
 * The approved-influence chips and the provenance drawer
 * (specification sections 3 and 13).
 *
 * Two small chips, Discovery and Commitment. Clicking one opens a contextual
 * drawer, not a separate analytics screen. The drawer shows exactly the three
 * layers that exist in phase 3:
 *
 *   * **Qloo retrieved** — the reference, one supported context sentence, the
 *     original artist, and the capture date. The original response rank and the
 *     evidence field paths sit behind a second disclosure, as the specification
 *     asks.
 *   * **FirstPlayable proposed** — the abstraction and the interaction,
 *     explicitly labelled a FirstPlayable interpretation.
 *   * **Creator approved** — the exact frozen wording, with "Edited by you"
 *     when it differs from what was proposed.
 *
 * There is no fourth line. "Scene changed" belongs to phase 4, the server
 * sends no field for it, and this component writes none: a creator is never
 * shown a mechanical consequence that no compiler produced.
 */

import { useState } from "react";
import type { AnchorView, ProjectView, ProvenanceView } from "@/domain/project";
import type { ApprovedInfluence, Slot } from "@/domain/influence";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

const SLOT_LABEL: Record<Slot, string> = {
  discovery: "Discovery",
  commitment: "Commitment",
};

export type ApprovedInfluencesProps = {
  projectId: string;
  project: ProjectView;
  onChanged: () => void;
};

export function ApprovedInfluences({
  projectId,
  project,
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
    <section className="panel" aria-labelledby="approved-heading">
      <h2 className="panel__heading" id="approved-heading">
        Approved influences
      </h2>

      {project.approvals.length === 0 ? (
        <p className="studio__note" data-testid="no-approvals">
          None yet. Retrieved references and proposed interactions are not
          approvals — you approve each one explicitly.
        </p>
      ) : (
        <>
          <ul className="influence-chips" data-testid="approved-chips">
            {project.approvals.map((approval) => (
              <li key={approval.approval_id}>
                <button
                  className="chip influence-chip"
                  type="button"
                  aria-expanded={open === approval.approval_id}
                  data-testid={`approved-chip-${approval.slot}`}
                  onClick={() =>
                    setOpen(open === approval.approval_id ? null : approval.approval_id)
                  }
                >
                  {SLOT_LABEL[approval.slot]}: {approval.reference_name}
                  {approval.edited_by_creator ? " · edited" : ""}
                </button>
              </li>
            ))}
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

      <p className="studio__hint">
        One Discovery and one Commitment approval at most. A scene is not
        generated yet: compilation arrives in phase 4.
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
    <div className="drawer" data-testid={`provenance-${approval.slot}`}>
      <ol className="drawer__chain">
        <li className="drawer__layer">
          <p className="drawer__label">Qloo retrieved</p>
          {chain?.retrieved === null || chain === null ? (
            <p className="studio__hint">
              The original capture for this approval is no longer readable.
            </p>
          ) : (
            <>
              <p>
                <strong>{chain.retrieved.reference_name}</strong>
                {chain.retrieved.year !== null && (
                  <span className="studio__hint"> ({chain.retrieved.year})</span>
                )}{" "}
                <span className="chip">
                  {chain.retrieved.domain === "movie" ? "Movie" : "Videogame"}
                </span>
              </p>
              {chain.retrieved.context !== null && (
                <p className="studio__prose" data-testid={`provenance-context-${approval.slot}`}>
                  {chain.retrieved.context}
                </p>
              )}
              <p className="studio__hint">
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
            </>
          )}
        </li>

        <li className="drawer__layer">
          <p className="drawer__label">FirstPlayable proposed</p>
          <p className="studio__prose">{approval.proposed_idea}</p>
          <p className="studio__hint">
            {approval.proposed_relevance} — {chain?.proposed.attribution ?? "FirstPlayable interpretation"}.
          </p>
        </li>

        <li className="drawer__layer">
          <p className="drawer__label">
            Creator approved
            {approval.edited_by_creator && (
              <span className="chip" data-testid={`edited-by-you-${approval.slot}`}>
                Edited by you
              </span>
            )}
          </p>
          <p className="studio__prose" data-testid={`approved-text-${approval.slot}`}>
            {approval.approved_text}
          </p>
          <p className="studio__hint">
            Intended effect: {approval.intended_effect} · {SLOT_LABEL[approval.slot]} slot ·
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

      <div className="studio__actions">
        <button
          className="button"
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
