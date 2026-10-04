"use client";

/**
 * The two compact domain rows, their cards, and the decision controls
 * (specification sections 3 and 18 of the build prompt).
 *
 * Shape of a card, in order: title, domain, one supported context sentence,
 * then the proposed interaction once the proposal stage has run, then Approve
 * / Edit / Dismiss immediately underneath it.
 *
 * What is deliberately absent:
 *
 *   * no affinity, no score, no percentage, no "best match" badge — the server
 *     does not send one, and this component has no slot for one;
 *   * no card is preselected, and nothing is marked approved until the creator
 *     presses Approve;
 *   * no evidence dashboard. The original rank and the field paths live behind
 *     the provenance drawer's deeper disclosure, not on the card.
 */

import { useState } from "react";
import type { DomainRowView, ProjectView, ReferencesView } from "@/domain/project";
import type { ProposedInterpretation } from "@/domain/influence";
import { PROPOSAL_ATTRIBUTION } from "@/domain/influence";
import {
  type PublicReferenceCandidate,
  supportedContextSentence,
} from "@/domain/qloo";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

const DOMAIN_LABEL = { movie: "Movie", videogame: "Videogame" } as const;

export type ReferenceRowsProps = {
  projectId: string;
  project: ProjectView;
  references: ReferencesView | null;
  onChanged: () => void;
};

export function ReferenceRows({
  projectId,
  project,
  references,
  onChanged,
}: ReferenceRowsProps): React.JSX.Element {
  const [retrieving, setRetrieving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);

  const proposalsByReference = new Map(
    project.proposals.map((proposal) => [proposal.reference_id, proposal]),
  );
  const occupied = new Set(project.approved_slots);

  async function retrieve(acceptStale: boolean): Promise<void> {
    setRetrieving(true);
    setFailure(null);
    const result = await postJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/references`,
      { expected_revision: project.revision, accept_stale: acceptStale },
    );
    setRetrieving(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    onChanged();
  }

  async function propose(): Promise<void> {
    setProposing(true);
    setFailure(null);
    const result = await postJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/proposals`,
      { expected_revision: project.revision },
    );
    setProposing(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    onChanged();
  }

  if (!project.anchor_confirmed) {
    return (
      <section className="panel">
        <h2 className="panel__heading">References</h2>
        <p className="studio__note" data-testid="references-need-anchor">
          Confirm an artist above, then Qloo can retrieve movie and videogame
          references for it.
        </p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="references-heading">
      <h2 className="panel__heading" id="references-heading">
        References
      </h2>

      {references === null && (
        <div className="studio__actions">
          <button
            className="button button--primary"
            type="button"
            data-testid="retrieve-references"
            disabled={retrieving}
            onClick={() => void retrieve(false)}
          >
            {retrieving ? "Finding references…" : "Find references"}
          </button>
        </div>
      )}

      {retrieving && (
        <p className="studio__note" aria-live="polite" data-testid="finding-references">
          Finding references. Two requests: one for movies, one for videogames.
        </p>
      )}

      {failure !== null && <InlineFailure failure={failure} testId="references-failure" />}

      {references !== null && (
        <>
          {!references.any_usable && (
            <div data-testid="no-supported-influences">
              <p className="studio__note">No supported influences available for this artist.</p>
              <p className="studio__hint">
                Nothing was invented to fill the gap. Search another artist above, or
                play the saved example.
              </p>
            </div>
          )}

          {references.any_usable && project.proposals.length === 0 && (
            <div className="studio__actions">
              <button
                className="button button--primary"
                type="button"
                data-testid="run-proposals"
                disabled={proposing}
                onClick={() => void propose()}
              >
                {proposing ? "Writing interpretations…" : "Suggest interactions"}
              </button>
              <p className="studio__hint">
                FirstPlayable proposes; nothing is approved until you say so.
              </p>
            </div>
          )}

          <DomainRow
            row={references.movie}
            proposals={proposalsByReference}
            occupied={occupied}
            projectId={projectId}
            revision={project.revision}
            onChanged={onChanged}
          />
          <DomainRow
            row={references.videogame}
            proposals={proposalsByReference}
            occupied={occupied}
            projectId={projectId}
            revision={project.revision}
            onChanged={onChanged}
          />

          <div className="studio__actions">
            <button
              className="button"
              type="button"
              data-testid="retrieve-references-again"
              disabled={retrieving}
              onClick={() => void retrieve(false)}
            >
              Re-read references
            </button>
            <p className="studio__hint">
              Re-reading uses the stored capture. It makes no new request unless
              the capture has expired.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function DomainRow({
  row,
  proposals,
  occupied,
  projectId,
  revision,
  onChanged,
}: {
  row: DomainRowView;
  proposals: Map<string, ProposedInterpretation>;
  occupied: Set<"discovery" | "commitment">;
  projectId: string;
  revision: number;
  onChanged: () => void;
}): React.JSX.Element {
  const [showSkipped, setShowSkipped] = useState(false);
  const label = DOMAIN_LABEL[row.domain];

  return (
    <div className="domain-row" data-testid={`domain-row-${row.domain}`}>
      <h3 className="domain-row__heading">
        {label}s
        {row.status === "ready" && (
          <span className="studio__hint">
            {" "}
            · Qloo returned {row.returned_count}, {row.usable_count} with usable
            context
            {row.cache === "cached" ? " · from a stored capture" : ""}
            {row.cache === "stale" && row.stale_captured_at !== null
              ? ` · dated capture from ${row.stale_captured_at.slice(0, 10)}`
              : ""}
          </span>
        )}
      </h3>

      {row.status === "unavailable" && (
        <p className="studio__note" data-testid={`domain-unavailable-${row.domain}`}>
          No {label.toLowerCase()} context is available right now
          {row.failure_code === null ? "" : ` (${row.failure_code})`}. The other row
          can still be used.
        </p>
      )}

      {row.status === "ready" && row.displayed.length === 0 && (
        <p className="studio__note" data-testid={`domain-empty-${row.domain}`}>
          Qloo returned no {label.toLowerCase()} with usable context for this artist.
        </p>
      )}

      {row.displayed.length > 0 && (
        <ul className="cards">
          {row.displayed.map((candidate) => (
            <ReferenceCard
              key={candidate.reference_id}
              candidate={candidate}
              proposal={proposals.get(candidate.reference_id) ?? null}
              occupied={occupied}
              projectId={projectId}
              revision={revision}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}

      {row.skipped.length > 0 && (
        <details
          className="disclosure"
          open={showSkipped}
          onToggle={(event) => setShowSkipped(event.currentTarget.open)}
        >
          <summary data-testid={`domain-skipped-${row.domain}`}>
            {row.skipped.length} other returned {label.toLowerCase()}
            {row.skipped.length === 1 ? "" : "s"}, and why they are not shown
          </summary>
          <ul className="panel__list">
            {row.skipped.map((skip) => (
              <li key={`${skip.original_rank}-${skip.name}`}>
                Result {skip.original_rank}: {skip.name} —{" "}
                {skip.reason === "no_usable_context"
                  ? "Qloo returned identity but no usable context, so it cannot support an interaction"
                  : "beyond the three shown for this row"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReferenceCard({
  candidate,
  proposal,
  occupied,
  projectId,
  revision,
  onChanged,
}: {
  candidate: PublicReferenceCandidate;
  proposal: ProposedInterpretation | null;
  occupied: Set<"discovery" | "commitment">;
  projectId: string;
  revision: number;
  onChanged: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal?.idea ?? "");
  const [effect, setEffect] = useState(proposal?.intended_interaction ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);

  const context = supportedContextSentence(candidate);
  const slot = proposal?.slot ?? null;
  const slotTaken = slot !== null && occupied.has(slot);

  async function decide(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setFailure(null);
    const result = await postJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/decisions`,
      { expected_revision: revision, ...payload },
    );
    setBusy(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setEditing(false);
    onChanged();
  }

  return (
    <li className="card" data-testid={`card-${candidate.reference_id}`}>
      <p className="card__title">
        <strong>{candidate.name}</strong>
        {candidate.year !== null && <span className="studio__hint"> ({candidate.year})</span>}
        <span className="chip card__domain">{DOMAIN_LABEL[candidate.domain]}</span>
      </p>

      <p className="card__context" data-testid={`card-context-${candidate.reference_id}`}>
        <span className="studio__hint">Qloo describes: </span>
        {context ?? "No supported context was returned for this reference."}
      </p>

      {proposal === null ? (
        <p className="studio__hint" data-testid={`card-no-proposal-${candidate.reference_id}`}>
          No interaction has been proposed for this reference yet.
        </p>
      ) : (
        <div className="card__proposal">
          <p className="card__slot">
            <span className="chip">{slot === "discovery" ? "Discovery" : "Commitment"}</span>
            {slotTaken && (
              <span className="studio__hint"> · this slot already holds an approval</span>
            )}
          </p>

          {editing ? (
            <>
              <label className="studio__label" htmlFor={`edit-idea-${proposal.proposal_id}`}>
                Your wording
              </label>
              <textarea
                className="studio__input studio__input--area"
                id={`edit-idea-${proposal.proposal_id}`}
                data-testid={`edit-idea-${candidate.reference_id}`}
                rows={3}
                maxLength={700}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <label className="studio__label" htmlFor={`edit-effect-${proposal.proposal_id}`}>
                What it should do in the scene
              </label>
              <textarea
                className="studio__input studio__input--area"
                id={`edit-effect-${proposal.proposal_id}`}
                data-testid={`edit-effect-${candidate.reference_id}`}
                rows={2}
                maxLength={300}
                value={effect}
                onChange={(event) => setEffect(event.target.value)}
              />
              <p className="studio__hint">
                Editing changes your interpretation. It never changes the Qloo
                context above.
              </p>
            </>
          ) : (
            <>
              <p className="card__idea" data-testid={`card-idea-${candidate.reference_id}`}>
                {proposal.idea}
              </p>
              <p className="card__interaction">
                <span className="studio__hint">Proposed interaction: </span>
                {proposal.intended_interaction}
              </p>
              <p className="studio__hint">
                {proposal.relevance} — {PROPOSAL_ATTRIBUTION}.
              </p>
            </>
          )}

          {failure !== null && (
            <InlineFailure failure={failure} testId={`decision-failure-${candidate.reference_id}`} />
          )}

          <div className="card__actions">
            {editing ? (
              <>
                <button
                  className="button button--primary"
                  type="button"
                  data-testid={`approve-edit-${candidate.reference_id}`}
                  disabled={busy || text.trim().length === 0 || effect.trim().length === 0}
                  onClick={() =>
                    void decide({
                      kind: slotTaken ? "replace" : "edit",
                      proposal_id: proposal.proposal_id,
                      approved_text: text.trim(),
                      intended_effect: effect.trim(),
                    })
                  }
                >
                  {busy ? "Approving…" : slotTaken ? "Replace with my wording" : "Approve my wording"}
                </button>
                <button
                  className="button"
                  type="button"
                  data-testid={`cancel-edit-${candidate.reference_id}`}
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  className="button button--primary"
                  type="button"
                  data-testid={`approve-${candidate.reference_id}`}
                  disabled={busy}
                  onClick={() =>
                    void decide({
                      kind: slotTaken ? "replace" : "accept",
                      proposal_id: proposal.proposal_id,
                    })
                  }
                >
                  {slotTaken ? "Replace this slot" : "Approve this interaction"}
                </button>
                <button
                  className="button"
                  type="button"
                  data-testid={`edit-${candidate.reference_id}`}
                  disabled={busy}
                  onClick={() => {
                    setText(proposal.idea);
                    setEffect(proposal.intended_interaction);
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  className="button"
                  type="button"
                  data-testid={`dismiss-${candidate.reference_id}`}
                  disabled={busy}
                  onClick={() =>
                    void decide({ kind: "reject", proposal_id: proposal.proposal_id })
                  }
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
