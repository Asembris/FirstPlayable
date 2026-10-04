/**
 * The provenance chain (specification section 13).
 *
 * Phase 3 exposes exactly the three layers that exist:
 *
 * ```text
 * Qloo retrieved        → the reference, its returned context, its capture date
 * FirstPlayable proposed → the abstraction, labelled a model interpretation
 * Creator approved       → the frozen wording, and whether it was edited
 * ```
 *
 * The fourth layer, **Scene changed**, belongs to phase 4. It is not hidden
 * behind a flag or rendered empty: {@link ProvenanceView} has no field for it.
 * A chain cannot claim a mechanical consequence that no compiler has produced,
 * because there is nowhere to put the claim.
 *
 * The retrieved layer is built from the immutable capture, so its context, its
 * field paths, its rank, and its date are the ones that were stored at
 * retrieval time — not today's lookup, and not the creator's wording.
 *
 * A provenance chain is an inspectable record of retrieval, interpretation and
 * decision. It is not evidence that the idea could only have been reached with
 * Qloo.
 */

import type { ApprovedInfluence } from "@/domain/influence";
import { PROPOSAL_ATTRIBUTION } from "@/domain/influence";
import type { ProvenanceView } from "@/domain/project";
import { ProvenanceViewSchema } from "@/domain/project";
import { supportedContextSentence, toPublicCandidate, type ReferenceCapture } from "@/domain/qloo";

/**
 * Builds one chain per current approval.
 *
 * `retrieved` is null only when the capture an approval names is genuinely not
 * readable, which the retention rule should prevent. Null renders as "the
 * original capture is no longer available", never as a fabricated excerpt.
 */
export function buildProvenance(
  approvals: readonly ApprovedInfluence[],
  captures: readonly ReferenceCapture[],
): ProvenanceView[] {
  const byId = new Map(
    captures
      .filter((capture) => capture.capture_id !== null)
      .map((capture) => [capture.capture_id as string, capture]),
  );

  const chains: ProvenanceView[] = [];
  for (const approval of approvals) {
    const capture = approval.capture_id === null ? undefined : byId.get(approval.capture_id);
    const candidate = capture?.candidates.find(
      (entry) => entry.reference_id === approval.reference_id,
    );

    const cited = new Set(approval.selected_evidence_ids);
    const chain: ProvenanceView = {
      approval_id: approval.approval_id,
      slot: approval.slot,
      retrieved:
        capture === undefined || candidate === undefined
          ? null
          : {
              reference_name: candidate.name,
              domain: candidate.domain,
              year: candidate.year,
              entity_id: candidate.entity_id,
              original_rank: candidate.original_rank,
              captured_at: capture.retrieved_at,
              // One sentence, from one returned field. Never a merge.
              context: supportedContextSentence(toPublicCandidate(candidate)),
              // Only the evidence this approval actually cites.
              evidence: candidate.evidence
                .filter((item) => cited.has(item.id))
                .map((item) => ({
                  id: item.id,
                  field_path: item.field_path,
                  text: item.text,
                })),
            },
      proposed: {
        // The model's own wording, not the creator's. These two layers stay
        // distinguishable so "Edited by you" is a fact rather than a label.
        idea: approval.proposed_idea,
        intended_interaction: approval.proposed_interaction,
        relevance: approval.proposed_relevance,
        /** Applied by this application, so the model cannot drop it. */
        attribution: PROPOSAL_ATTRIBUTION,
      },
      approved: {
        text: approval.approved_text,
        intended_effect: approval.intended_effect,
        edited_by_creator: approval.edited_by_creator,
        approved_at: approval.approved_at,
        slot: approval.slot,
        predecessor_id: approval.predecessor_id,
      },
    };

    const validated = ProvenanceViewSchema.safeParse(chain);
    if (validated.success) chains.push(validated.data);
  }
  return chains;
}

/** The capture ids a set of approvals needs, deduplicated. */
export function captureIdsForApprovals(
  approvals: readonly ApprovedInfluence[],
): string[] {
  const ids = new Set<string>();
  for (const approval of approvals) {
    if (approval.capture_id !== null) ids.add(approval.capture_id);
  }
  return [...ids];
}
