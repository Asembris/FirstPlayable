"use client";

/**
 * Influence approval, on the Rehearsal Table (Phase 6).
 *
 * Every reference is one row of three columns, each in its own material:
 *
 *   Qloo returned            the catalogue slip: identity and the context Qloo sent
 *   FirstPlayable proposes   the suggestion, in pencil
 *   You decide               approve it, edit it first, or not use it
 *
 * Approving changes no scene. An approved row says so ("Not built yet") until
 * a build carries that exact approval, and even then the scene people play
 * changes only when the creator makes the new version current.
 *
 * What is deliberately absent, still: no affinity, no score, no percentage, no
 * "best match" badge, no preselected card, and no evidence dashboard. The
 * original response rank and the field paths stay behind the provenance
 * drawer's deeper disclosure.
 */

import { useEffect, useRef, useState } from "react";
import type { DomainRowView, ProjectView, ReferencesView } from "@/domain/project";
import type { ApprovedInfluence, ProposedInterpretation } from "@/domain/influence";
import { PROPOSAL_ATTRIBUTION } from "@/domain/influence";
import type { Scene } from "@/domain/scene";
import {
  type PublicReferenceCandidate,
  supportedContextSentence,
} from "@/domain/qloo";
import { firstSentence } from "@/presentation/rehearsal";
import { BUILD_STATUS_LABEL, buildStatusOf } from "@/presentation/review";
import type { BuildStatus } from "@/presentation/review";
import { EditedMark } from "../rehearsal/CausalNote";
import { InlineFailure, postJson, type RequestFailure } from "./shared";

const DOMAIN_LABEL = { movie: "Movie", videogame: "Videogame" } as const;

/** What each slot lets an approved influence shape in play. */
const SLOT_SHAPES = {
  discovery: "Discovery · what the player can find out",
  commitment: "Commitment · what the player can promise",
} as const;

const STATUS_NOTE: Readonly<Record<BuildStatus, string>> = {
  "not-built":
    "The scene hasn't changed. It changes only when you build, and then make the new version current.",
  "awaiting-review":
    "A new build carries this approval. It is not what people play until you make it current.",
  current: "The version people play carries this approval.",
};

/** The versions an approval can be built into, for its status. */
export type Builds = { readonly pending: Scene | null; readonly active: Scene | null };

export type ReferenceRowsProps = {
  projectId: string;
  project: ProjectView;
  references: ReferencesView | null;
  builds: Builds;
  onChanged: () => void;
};

export function ReferenceRows({
  projectId,
  project,
  references,
  builds,
  onChanged,
}: ReferenceRowsProps): React.JSX.Element {
  const [retrieving, setRetrieving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);

  const proposalsByReference = new Map(
    project.proposals.map((proposal) => [proposal.reference_id, proposal]),
  );
  const approvalsByReference = new Map(
    project.approvals.map((approval) => [approval.reference_id, approval]),
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
      <section className="rt rt-studio rt-approval" aria-labelledby="references-heading">
        <p className="rt-label rt-studio__eyebrow">Influences</p>
        <h2 className="rt-studio__title rt-studio__title--small" id="references-heading">
          Which influence should shape the scene?
        </h2>
        <p className="rt-studio__lede" data-testid="references-need-anchor">
          Confirm an artist above, then Qloo can retrieve movie and videogame
          references for it.
        </p>
      </section>
    );
  }

  return (
    <section className="rt rt-studio rt-approval" aria-labelledby="references-heading">
      <header className="rt-studio__head">
        <p className="rt-label rt-studio__eyebrow">
          Artist confirmed · {project.anchor?.name ?? "your artist"} · references Qloo returned
          for that artist
        </p>
        <h2 className="rt-studio__title" id="references-heading">
          Which influence should shape the scene?
        </h2>
        <p className="rt-studio__lede">
          For each reference, FirstPlayable suggests one way it could change play. Nothing
          changes until you approve an interpretation, and nothing is built until you ask.
        </p>
      </header>

      {references === null && (
        <div className="rt-studio__actions">
          <button
            className="rt-button rt-button--primary"
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
        <p className="rt-studio__note" aria-live="polite" data-testid="finding-references">
          Finding references. Two requests: one for movies, one for videogames.
        </p>
      )}

      {failure !== null && <InlineFailure failure={failure} testId="references-failure" />}

      {references !== null && (
        <>
          {!references.any_usable && (
            <div className="rt-domain__note" data-testid="no-supported-influences">
              <p className="rt-studio__note">No supported influences available for this artist.</p>
              <p className="rt-studio__note">
                Nothing was invented to fill the gap. Search another artist above, or
                play the saved example.
              </p>
            </div>
          )}

          {references.any_usable && project.proposals.length === 0 && (
            <div className="rt-studio__actions">
              <button
                className="rt-button rt-button--primary"
                type="button"
                data-testid="run-proposals"
                disabled={proposing}
                onClick={() => void propose()}
              >
                {proposing ? "Writing interpretations…" : "Suggest interactions"}
              </button>
              <p className="rt-studio__note">
                FirstPlayable proposes; nothing is approved until you say so.
              </p>
            </div>
          )}

          <div className="rt-ref-heads" aria-hidden="true">
            <span>Qloo returned</span>
            <span>FirstPlayable proposes</span>
            <span>You decide</span>
          </div>

          <DomainRow
            row={references.movie}
            proposals={proposalsByReference}
            approvals={approvalsByReference}
            occupied={occupied}
            builds={builds}
            projectId={projectId}
            revision={project.revision}
            onChanged={onChanged}
          />
          <DomainRow
            row={references.videogame}
            proposals={proposalsByReference}
            approvals={approvalsByReference}
            occupied={occupied}
            builds={builds}
            projectId={projectId}
            revision={project.revision}
            onChanged={onChanged}
          />

          <div className="rt-studio__actions">
            <button
              className="rt-button"
              type="button"
              data-testid="retrieve-references-again"
              disabled={retrieving}
              onClick={() => void retrieve(false)}
            >
              Re-read references
            </button>
            <p className="rt-studio__note">
              Re-reading uses the stored capture. It makes no new request unless
              the capture has expired.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

type RowContext = {
  proposals: Map<string, ProposedInterpretation>;
  approvals: Map<string, ApprovedInfluence>;
  occupied: Set<"discovery" | "commitment">;
  builds: Builds;
  projectId: string;
  revision: number;
  onChanged: () => void;
};

function DomainRow({ row, ...context }: { row: DomainRowView } & RowContext): React.JSX.Element {
  const [showSkipped, setShowSkipped] = useState(false);
  const label = DOMAIN_LABEL[row.domain];

  return (
    <div className="domain-row rt-domain" data-testid={`domain-row-${row.domain}`}>
      <h3 className="rt-label rt-domain__heading">
        {label}s
        {row.status === "ready" && (
          <span className="rt-domain__count">
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
        <p className="rt-domain__note" data-testid={`domain-unavailable-${row.domain}`}>
          No {label.toLowerCase()} context is available right now
          {row.failure_code === null ? "" : ` (${row.failure_code})`}. The other row
          can still be used.
        </p>
      )}

      {row.status === "ready" && row.displayed.length === 0 && (
        <p className="rt-domain__note" data-testid={`domain-empty-${row.domain}`}>
          Qloo returned no {label.toLowerCase()} with usable context for this artist.
        </p>
      )}

      {row.displayed.length > 0 && (
        <ul className="cards rt-ref-list">
          {row.displayed.map((candidate) => (
            <ReferenceCard
              key={candidate.reference_id}
              candidate={candidate}
              proposal={context.proposals.get(candidate.reference_id) ?? null}
              approval={context.approvals.get(candidate.reference_id) ?? null}
              {...context}
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

/** "2009, Duncan Jones" → "Duncan Jones"; the year is already on the slip. */
function makerOf(candidate: PublicReferenceCandidate): string | null {
  const text = candidate.disambiguation;
  if (text === null || text.trim() === "") return null;
  const prefix = candidate.year === null ? "" : `${candidate.year}, `;
  const maker = prefix !== "" && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return maker === String(candidate.year) ? null : maker;
}

function ReferenceCard({
  candidate,
  proposal,
  approval,
  occupied,
  builds,
  projectId,
  revision,
  onChanged,
}: {
  candidate: PublicReferenceCandidate;
  proposal: ProposedInterpretation | null;
  approval: ApprovedInfluence | null;
} & Omit<RowContext, "proposals" | "approvals">): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal?.idea ?? "");
  const [effect, setEffect] = useState(proposal?.intended_interaction ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [justApproved, setJustApproved] = useState(false);
  const approvedRef = useRef<HTMLParagraphElement | null>(null);
  const ideaRef = useRef<HTMLTextAreaElement | null>(null);

  const context = supportedContextSentence(candidate);
  const slot = proposal?.slot ?? null;
  const slotTaken = slot !== null && occupied.has(slot);
  const maker = makerOf(candidate);
  const status = approval === null ? null : buildStatusOf(approval, builds);

  // Approving removes the buttons that were focused; focus lands on the
  // result, so a keyboard or screen-reader user hears what happened.
  useEffect(() => {
    if (justApproved && approval !== null) {
      approvedRef.current?.focus();
      setJustApproved(false);
    }
  }, [justApproved, approval]);

  useEffect(() => {
    if (editing) ideaRef.current?.focus();
  }, [editing]);

  async function decide(payload: Record<string, unknown>, approving: boolean): Promise<void> {
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
    setJustApproved(approving);
    onChanged();
  }

  const proposedHead = proposal === null ? null : firstSentence(proposal.idea);

  return (
    <li className="card rt-ref" data-testid={`card-${candidate.reference_id}`}>
      <div className="rt-ref__slip">
        <p className="rt-ref__kind">
          {DOMAIN_LABEL[candidate.domain]}
          {candidate.year !== null ? ` · ${candidate.year}` : ""}
        </p>
        <p className="rt-ref__name card__title">{candidate.name}</p>
        {maker === null ? null : <p className="rt-ref__maker">{maker}</p>}
        <p className="rt-ref__evidence card__context" data-testid={`card-context-${candidate.reference_id}`}>
          Qloo describes ·{" "}
          {context === null ? "No supported context was returned for this reference." : `“${context}”`}
        </p>
      </div>

      <div className="rt-ref__proposal">
        {proposal === null ? (
          <p className="rt-ref__was" data-testid={`card-no-proposal-${candidate.reference_id}`}>
            No interaction has been proposed for this reference yet.
          </p>
        ) : approval !== null ? (
          <>
            <p className="rt-ref__was">
              Proposed: {proposedHead?.head}
              {proposedHead?.truncated === true ? "…" : ""}
            </p>
            <p className="rt-ref__approved-label">
              <span className="rt-field__label">Your interpretation</span>
              {approval.edited_by_creator ? (
                <EditedMark />
              ) : (
                <span className="rt-studio__note">approved as suggested</span>
              )}
            </p>
            <blockquote className="rt-decision rt-decision--large" data-testid={`card-approved-${candidate.reference_id}`}>
              {approval.approved_text}
            </blockquote>
            <p className="rt-ref__effect">
              <span>What should change in play · </span>
              {approval.intended_effect}
            </p>
          </>
        ) : editing ? (
          <>
            <p className="rt-ref__was" data-testid={`card-proposed-${candidate.reference_id}`}>
              Proposed: {proposedHead?.head}
              {proposedHead?.truncated === true ? "…" : ""}
            </p>
            <div className="rt-field">
              <label className="rt-field__label" htmlFor={`edit-idea-${proposal.proposal_id}`}>
                Your interpretation
              </label>
              <textarea
                ref={ideaRef}
                className="rt-field__input"
                id={`edit-idea-${proposal.proposal_id}`}
                data-testid={`edit-idea-${candidate.reference_id}`}
                rows={4}
                maxLength={700}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="rt-field">
              <label className="rt-field__label" htmlFor={`edit-effect-${proposal.proposal_id}`}>
                What should change in play
              </label>
              <textarea
                className="rt-field__input rt-field__input--plain"
                id={`edit-effect-${proposal.proposal_id}`}
                data-testid={`edit-effect-${candidate.reference_id}`}
                rows={2}
                maxLength={300}
                value={effect}
                onChange={(event) => setEffect(event.target.value)}
              />
            </div>
            <p className="rt-ref__attrib">
              Editing changes your interpretation. It never changes what Qloo returned.
            </p>
          </>
        ) : (
          <>
            <p className="rt-ref__idea card__idea" data-testid={`card-idea-${candidate.reference_id}`}>
              {proposal.idea}
            </p>
            <dl className="rt-ref__meta">
              <dt>Proposed interaction:</dt>
              <dd>{proposal.intended_interaction}</dd>
              <dt>Would shape</dt>
              <dd className="card__slot">
                {SLOT_SHAPES[proposal.slot]}
                {slotTaken && <span> · this slot already holds an approval</span>}
              </dd>
            </dl>
            <p className="rt-ref__attrib">
              {proposal.relevance} — {PROPOSAL_ATTRIBUTION}.
            </p>
          </>
        )}
      </div>

      <div className="rt-ref__decide">
        {failure !== null && (
          <InlineFailure failure={failure} testId={`decision-failure-${candidate.reference_id}`} />
        )}
        {proposal === null ? null : approval !== null && status !== null ? (
          <>
            <p
              className="rt-ref__approved"
              ref={approvedRef}
              tabIndex={-1}
              data-testid={`card-status-${candidate.reference_id}`}
            >
              ✓ Approved
            </p>
            <span
              className={`rt-chip${status === "current" ? "" : " rt-chip--dashed"}`}
              data-testid={`card-build-${candidate.reference_id}`}
            >
              {BUILD_STATUS_LABEL[status]}
            </span>
            <p className="rt-studio__note">{STATUS_NOTE[status]}</p>
            <button
              className="rt-text-button"
              type="button"
              data-testid={`undo-approval-${candidate.reference_id}`}
              disabled={busy}
              onClick={() => void decide({ kind: "remove", slot: approval.slot }, false)}
            >
              {busy ? "Removing…" : "Undo approval"}
            </button>
          </>
        ) : editing ? (
          <>
            <button
              className="rt-button rt-button--primary"
              type="button"
              data-testid={`approve-edit-${candidate.reference_id}`}
              disabled={busy || text.trim().length === 0 || effect.trim().length === 0}
              onClick={() =>
                void decide(
                  {
                    kind: slotTaken ? "replace" : "edit",
                    proposal_id: proposal.proposal_id,
                    approved_text: text.trim(),
                    intended_effect: effect.trim(),
                  },
                  true,
                )
              }
            >
              {busy ? "Approving…" : slotTaken ? "Replace with my wording" : "Approve my wording"}
            </button>
            <button
              className="rt-text-button"
              type="button"
              data-testid={`cancel-edit-${candidate.reference_id}`}
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel edit
            </button>
            <p className="rt-studio__note">
              Your words are what gets built. The suggestion stays on record as the suggestion.
            </p>
          </>
        ) : (
          <>
            <button
              className="rt-button rt-button--primary"
              type="button"
              data-testid={`approve-${candidate.reference_id}`}
              disabled={busy}
              onClick={() =>
                void decide(
                  { kind: slotTaken ? "replace" : "accept", proposal_id: proposal.proposal_id },
                  true,
                )
              }
            >
              {slotTaken ? "Replace this slot" : "Approve this interpretation"}
            </button>
            <button
              className="rt-button"
              type="button"
              data-testid={`edit-${candidate.reference_id}`}
              disabled={busy}
              onClick={() => {
                setText(proposal.idea);
                setEffect(proposal.intended_interaction);
                setEditing(true);
              }}
            >
              Edit before approving
            </button>
            <button
              className="rt-text-button"
              type="button"
              data-testid={`dismiss-${candidate.reference_id}`}
              disabled={busy}
              onClick={() => void decide({ kind: "reject", proposal_id: proposal.proposal_id }, false)}
            >
              Not this one
            </button>
          </>
        )}
      </div>
    </li>
  );
}
