/**
 * The context firewall (specification section 7).
 *
 * Every payload that leaves this application for a model is built here, from
 * the server's own frozen database snapshot, by a pure function with an
 * explicit parameter list. That is the entire mechanism:
 *
 * ```ts
 * buildProposalPayload(brief, eligibleReferences)   // brief + eligible evidence
 * buildApprovedInfluencePayload(approval, capture)  // one approval + its evidence
 * ```
 *
 * A builder cannot reach anything it was not handed. There is no project
 * object in scope, no mutable transcript, no provider conversation handle, no
 * previous response id, and no "approved" flag read from a request body.
 *
 * What this guarantees, precisely: **dataflow and ownership isolation.** A
 * rejected proposal, an unselected reference, and the other slot's approval
 * are not reachable from the value a model receives. What it does **not**
 * guarantee is that a language model could never independently invent a
 * semantically similar idea from the brief alone — that is not a property any
 * code can establish, and this application does not claim it.
 *
 * `buildApprovedInfluencePayload` is deliberately built and tested in phase 3,
 * before the phase 4 module compiler exists, so the boundary is established
 * before anything depends on it.
 */

import type { Brief } from "@/domain/brief";
import type {
  ApprovedInfluence,
  ApprovedInfluencePayload,
  Slot,
} from "@/domain/influence";
import { ApprovedInfluencePayloadSchema } from "@/domain/influence";
import { SLOTS } from "@/domain/limits";
import {
  DISPLAYED_USABLE_PER_DOMAIN,
  MAX_PROPOSAL_CANDIDATES,
  QLOO_DOMAINS,
  type QlooDomain,
  type ReferenceCandidate,
  type ReferenceCapture,
} from "@/domain/qloo";

/**
 * One reference as a model sees it.
 *
 * Note what has no field here: the Qloo entity UUID, the affinity, the capture
 * id, the request fingerprint, the artist, the rank, and the quota
 * diagnostics. A model has no use for any of them and must not be able to echo
 * one back as if it were its own output.
 */
export type ReferenceForProposal = {
  reference_id: string;
  name: string;
  domain: QlooDomain;
  year: number | null;
  evidence: { id: string; field_path: string; text: string }[];
};

/**
 * The brief as a model sees it: the frozen creator fields, and nothing about
 * retrieval, approval, or any previous generation.
 */
export type BriefForModel = {
  title: string | null;
  premise: string;
  player_role: string;
  room: { name: string; description: string };
  character: { name: string; role: string };
  object: { name: string; description: string };
  tone: Brief["tone"];
  forbidden_wording: string[];
};

export type ProposalPayload = {
  brief: BriefForModel;
  /** The two fixed slots, described in plain language, so the model can choose. */
  slots: { id: Slot; description: string }[];
  references: ReferenceForProposal[];
};

/**
 * How each slot actually attaches, stated without naming an action id a model
 * could try to emit. Phase 3 produces no scene, so this is guidance for
 * choosing a slot, not a contract the model can write against.
 */
const SLOT_DESCRIPTIONS: Record<Slot, string> = {
  discovery:
    "Discovery: something the player learns by examining the object, which can later " +
    "stand between them and handing it over.",
  commitment:
    "Commitment: something the player says or promises when asking about terms, which " +
    "can later close the option of keeping the object.",
};

function toBriefForModel(brief: Brief): BriefForModel {
  return {
    title: brief.title,
    premise: brief.premise,
    player_role: brief.player_role,
    room: { name: brief.room.name, description: brief.room.description },
    character: { name: brief.character.name, role: brief.character.role },
    object: { name: brief.object.name, description: brief.object.description },
    tone: brief.tone,
    forbidden_wording: [...brief.forbidden_wording],
  };
}

function toReferenceForProposal(candidate: ReferenceCandidate): ReferenceForProposal {
  return {
    reference_id: candidate.reference_id,
    name: candidate.name,
    domain: candidate.domain,
    year: candidate.year,
    evidence: candidate.evidence.map((item) => ({
      id: item.id,
      field_path: item.field_path,
      text: item.text,
    })),
  };
}

/**
 * Chooses which references may enter the proposal stage.
 *
 * Only usable candidates, only from the frozen captures, at most three per
 * domain and at most six in total, in returned-rank order. When one domain has
 * fewer than three usable rows the other may contribute more, up to the same
 * overall ceiling: a thin game list makes the movie row more useful, it does
 * not make the budget smaller.
 */
export function selectEligibleReferences(
  captures: readonly ReferenceCapture[],
): ReferenceCandidate[] {
  const byDomain = new Map<QlooDomain, ReferenceCandidate[]>();
  for (const domain of QLOO_DOMAINS) byDomain.set(domain, []);
  for (const capture of captures) {
    const bucket = byDomain.get(capture.domain);
    if (bucket === undefined) continue;
    for (const candidate of capture.candidates) {
      if (candidate.usable) bucket.push(candidate);
    }
  }

  const primary: ReferenceCandidate[] = [];
  const overflow: ReferenceCandidate[] = [];
  for (const domain of QLOO_DOMAINS) {
    const bucket = byDomain.get(domain) ?? [];
    primary.push(...bucket.slice(0, DISPLAYED_USABLE_PER_DOMAIN));
    overflow.push(...bucket.slice(DISPLAYED_USABLE_PER_DOMAIN));
  }

  const selected = [...primary];
  for (const candidate of overflow) {
    if (selected.length >= MAX_PROPOSAL_CANDIDATES) break;
    selected.push(candidate);
  }
  return selected.slice(0, MAX_PROPOSAL_CANDIDATES);
}

/**
 * The proposal payload.
 *
 * Two parameters, both frozen server-side values. The artist query and the
 * artist's name are deliberately absent: the proposal must follow from the
 * evidence that was retrieved, not from what a model already associates with a
 * band's name.
 */
export function buildProposalPayload(
  brief: Brief,
  eligibleReferences: readonly ReferenceCandidate[],
): ProposalPayload {
  return {
    brief: toBriefForModel(brief),
    slots: SLOTS.map((slot) => ({ id: slot, description: SLOT_DESCRIPTIONS[slot] })),
    references: eligibleReferences
      .slice(0, MAX_PROPOSAL_CANDIDATES)
      .map(toReferenceForProposal),
  };
}

/**
 * The smallest compiler-facing representation of one approval.
 *
 * Exactly one approval, exactly the evidence it cited, and the reference that
 * evidence came from. The other slot, every unselected reference, every
 * dismissed proposal, and the artist are all unreachable from the result, and
 * an evidence id the approval does not cite is dropped rather than carried.
 *
 * Returns null when the approval's evidence is not present in the capture it
 * names. A compiler input that cannot be grounded in stored evidence is not
 * built at all.
 */
export function buildApprovedInfluencePayload(
  approval: ApprovedInfluence,
  capture: ReferenceCapture,
): ApprovedInfluencePayload | null {
  if (capture.domain !== approval.domain) return null;

  const reference = capture.candidates.find(
    (candidate) => candidate.reference_id === approval.reference_id,
  );
  if (reference === undefined) return null;

  const cited = new Set(approval.selected_evidence_ids);
  const evidence = reference.evidence
    .filter((item) => cited.has(item.id))
    .map((item) => ({ id: item.id, field_path: item.field_path, text: item.text }));

  // Every cited id has to resolve. A missing one means the payload would be
  // narrower than the approval the creator gave, which is not the same thing.
  if (evidence.length !== cited.size) return null;
  if (evidence.length === 0) return null;

  const payload: ApprovedInfluencePayload = {
    slot: approval.slot,
    approval_id: approval.approval_id,
    approved_text: approval.approved_text,
    intended_effect: approval.intended_effect,
    reference: {
      reference_id: reference.reference_id,
      name: reference.name,
      domain: reference.domain,
      year: reference.year,
    },
    evidence,
  };

  const validated = ApprovedInfluencePayloadSchema.safeParse(payload);
  return validated.success ? validated.data : null;
}

/**
 * Builds the payload for each current approval.
 *
 * One entry per slot, each built independently from its own approval and its
 * own capture, so no entry can observe another. This is the shape phase 4 will
 * iterate over when it compiles one module per slot.
 */
export function buildApprovedInfluencePayloads(
  approvals: readonly ApprovedInfluence[],
  captures: readonly ReferenceCapture[],
): ApprovedInfluencePayload[] {
  const byId = new Map(
    captures
      .filter((capture) => capture.capture_id !== null)
      .map((capture) => [capture.capture_id as string, capture]),
  );

  const payloads: ApprovedInfluencePayload[] = [];
  for (const slot of SLOTS) {
    const approval = approvals.find((candidate) => candidate.slot === slot);
    if (approval === undefined) continue;
    const capture =
      approval.capture_id === null ? undefined : byId.get(approval.capture_id);
    if (capture === undefined) continue;
    const payload = buildApprovedInfluencePayload(approval, capture);
    if (payload !== null) payloads.push(payload);
  }
  return payloads;
}

/** Deterministic JSON for a payload, used as the model input and for hashing. */
export function serializePayload(payload: unknown): string {
  return JSON.stringify(payload, null, 1);
}
