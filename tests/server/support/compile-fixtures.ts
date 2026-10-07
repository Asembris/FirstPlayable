/**
 * Deterministic compilation fixtures for the offline suite.
 *
 * Two jobs, kept apart on purpose:
 *
 *   * **Sentinels.** Distinct, unmistakable strings planted in every piece of
 *     cultural material a compilation stage must not see: the artist query, an
 *     unselected reference title, an unselected evidence excerpt, a dismissed
 *     proposal, the other slot's approval, and the private affinity and
 *     capture diagnostics. A payload test fails if any of them appears in the
 *     bytes actually sent.
 *   * **Model candidates.** Base narrative copy and module outputs in the
 *     exact shape the model-facing contracts accept, the copy lifted from the
 *     hand-authored Phase 1 fixture so a "valid" candidate really is valid. The fake provider
 *     returns these; the **real** engine decides whether they are acceptable.
 *     Nothing here mocks the validator.
 */

import type {
  BaseNarrativeCopy,
  ModuleCompilationOutput,
  ModuleMechanic,
} from "../../../src/domain/compile";
import type { ApprovedInfluence, ApprovedInfluencePayload } from "../../../src/domain/influence";
import { BUDGET } from "../../../src/domain/limits";
import { SECOND_COPY_BASE } from "../../../fixtures/second-copy";

/* --------------------------------------------------------------- sentinels */

/**
 * Every sentinel, with the boundary it proves. A payload assertion iterates
 * this list rather than naming strings inline, so adding a sentinel
 * immediately strengthens every payload test.
 */
export const SENTINELS = {
  /** The confirmed artist's query text. No compilation stage receives it. */
  artist: "ZZARTISTSENTINEL",
  /** A reference the creator never selected. */
  unselectedReference: "ZZUNSELECTEDREFSENTINEL",
  /** An evidence excerpt the approval did not cite. */
  unselectedEvidence: "ZZUNSELECTEDEVIDENCESENTINEL",
  /** A proposal the creator dismissed. */
  rejectedProposal: "ZZREJECTEDPROPOSALSENTINEL",
  /** The Discovery approval, as the Commitment stage must not see it. */
  discoveryApproval: "ZZDISCOVERYAPPROVALSENTINEL",
  /** The Commitment approval, as the Discovery stage must not see it. */
  commitmentApproval: "ZZCOMMITMENTAPPROVALSENTINEL",
  /** The private affinity score. Never creative confidence, never sent. */
  affinity: "ZZAFFINITYSENTINEL",
  /** Capture request fingerprints and quota diagnostics. */
  captureDiagnostics: "ZZCAPTUREDIAGNOSTICSENTINEL",
} as const;

export const ALL_SENTINELS: readonly string[] = Object.values(SENTINELS);

/** Sentinels the Discovery stage must never see. */
export const SENTINELS_FORBIDDEN_IN_DISCOVERY: readonly string[] = [
  SENTINELS.artist,
  SENTINELS.unselectedReference,
  SENTINELS.unselectedEvidence,
  SENTINELS.rejectedProposal,
  SENTINELS.commitmentApproval,
  SENTINELS.affinity,
  SENTINELS.captureDiagnostics,
];

/** Sentinels the Commitment stage must never see. */
export const SENTINELS_FORBIDDEN_IN_COMMITMENT: readonly string[] = [
  SENTINELS.artist,
  SENTINELS.unselectedReference,
  SENTINELS.unselectedEvidence,
  SENTINELS.rejectedProposal,
  SENTINELS.discoveryApproval,
  SENTINELS.affinity,
  SENTINELS.captureDiagnostics,
];

/* ------------------------------------------------------- approval payloads */

const APPROVAL_IDS = {
  discovery: "11111111-1111-4111-8111-111111111111",
  commitment: "22222222-2222-4222-8222-222222222222",
} as const;

export const DISCOVERY_APPROVAL_PAYLOAD: ApprovedInfluencePayload = {
  slot: "discovery",
  approval_id: APPROVAL_IDS.discovery,
  approved_text: `Inspecting the letter reveals an identity contradiction, and it must be discussed before the letter is returned. ${SENTINELS.discoveryApproval}`,
  intended_effect: "Inspection unlocks a question; that question unlocks the return.",
  reference: {
    reference_id: "ref.mv.halcyon",
    name: "Halcyon Relay",
    domain: "movie",
    year: 2009,
  },
  evidence: [
    {
      id: "ref.mv.halcyon#ev1",
      field_path: "properties.plot_themes_description",
      text: "Asks what makes a person the same person by setting two copies of one man against the record of a single life.",
    },
  ],
};

export const COMMITMENT_APPROVAL_PAYLOAD: ApprovedInfluencePayload = {
  slot: "commitment",
  approval_id: APPROVAL_IDS.commitment,
  approved_text: `Naming what the promise costs is required before the promise can be made. ${SENTINELS.commitmentApproval}`,
  intended_effect: "Asking why she came back reveals the cost; the promise needs that cost named.",
  reference: {
    reference_id: "ref.vg.emberfall",
    name: "Emberfall: Oaths",
    domain: "videogame",
    year: 2009,
  },
  evidence: [
    {
      id: "ref.vg.emberfall#ev1",
      field_path: "properties.description",
      text: "Alliances are won and lost by what you promise.",
    },
  ],
};

/** The frozen approval record behind each payload, as the server resolves it. */
export function approvalRecord(payload: ApprovedInfluencePayload): ApprovedInfluence {
  return {
    approval_id: payload.approval_id,
    slot: payload.slot,
    reference_id: payload.reference.reference_id,
    entity_id: "5B000000-0000-4000-8000-000000000003",
    reference_name: payload.reference.name,
    domain: payload.reference.domain,
    capture_id: "33333333-3333-4333-8333-333333333333",
    selected_evidence_ids: payload.evidence.map((item) => item.id),
    approved_text: payload.approved_text,
    intended_effect: payload.intended_effect,
    proposed_idea: payload.approved_text,
    proposed_interaction: payload.intended_effect,
    proposed_relevance: "This follows from the cited excerpt.",
    edited_by_creator: false,
    source_kind: "qloo",
    project_revision: 4,
    predecessor_id: null,
    approved_at: "2026-10-04T10:05:00.000Z",
  };
}

export const DISCOVERY_APPROVAL = approvalRecord(DISCOVERY_APPROVAL_PAYLOAD);
export const COMMITMENT_APPROVAL = approvalRecord(COMMITMENT_APPROVAL_PAYLOAD);

/* ------------------------------------------------------- model candidates */

/**
 * An effect, back in the form a model writes it: the position of the variable
 * in the module's own declared array, which is the only way it can name one.
 */
/* ------------------------------------------------ base narrative copy */

/**
 * The base copy the Phase 1 fixture's own writing supplies.
 *
 * Every string here is lifted verbatim from `fixtures/second_copy.base.json`,
 * so `baseCoreFromCopy(SECOND_COPY_BRIEF, validBaseCopy())` reproduces that
 * fixture's core — the deterministic skeleton and the authoritative fixture are
 * the same state machine, and `compile-base.test.ts` asserts exactly that.
 */
export function validBaseCopy(): BaseNarrativeCopy {
  const label = (id: string): string =>
    SECOND_COPY_BASE.core.actions.find((action) => action.id === id)!.label;
  const line = (id: string): string =>
    SECOND_COPY_BASE.core.dialogue.find((node) => node.id === id)!.text;
  const ending = (id: string) =>
    SECOND_COPY_BASE.core.endings.find((entry) => entry.id === id)!;
  return {
    title: SECOND_COPY_BASE.title,
    inspect_label: label("core.inspect"),
    ask_context_label: label("core.ask_context"),
    ask_terms_label: label("core.ask_terms"),
    give_label: label("core.give"),
    withhold_label: label("core.withhold"),
    leave_label: label("core.leave"),
    inspect_dialogue: line("core.inspect_text"),
    context_dialogue: line("core.context_text"),
    commitment_dialogue: line("core.promise_text"),
    give_ending_title: ending("end.give").title,
    give_ending_text: ending("end.give").text,
    keep_ending_title: ending("end.keep").title,
    keep_ending_text: ending("end.keep").text,
    leave_ending_title: ending("end.leave").title,
    leave_ending_text: ending("end.leave").text,
  };
}

/**
 * Copy the *scene contract* refuses: a control character in a dialogue line.
 *
 * It satisfies the narrative-copy schema, which bounds length only, and is
 * rejected by `boundedText`'s plain-text refinement during assembly. This is
 * the rejectable base candidate the offline suite uses now that no mechanical
 * one is representable.
 */
export function nonPlainTextBaseCopy(): BaseNarrativeCopy {
  return { ...validBaseCopy(), inspect_dialogue: "The envelope is still sealed." };
}

/**
 * Copy that uses {@link FORBIDDEN_PHRASE}.
 *
 * Pair it with a brief whose `forbidden_wording` lists that phrase: the
 * validator then reports `FORBIDDEN_WORDING`, which is a real copy failure the
 * one permitted repair can fix without touching a mechanic.
 */
export function forbiddenWordingBaseCopy(): BaseNarrativeCopy {
  return {
    ...validBaseCopy(),
    keep_ending_text: "You keep it. The whole affair is a moral quandary you cannot settle.",
  };
}

/** The phrase {@link forbiddenWordingBaseCopy} uses, as a brief forbids it. */
export const FORBIDDEN_PHRASE = "moral quandary";

/* -------------------------------------------------- influence modules */

/**
 * One mechanic in the module contract's own shape.
 *
 * The contract is now a list of mechanics and nothing else: the identifiers,
 * conditions, effects, branches, dialogue node ids, and ports are all written
 * by `moduleFromModelOutput`. These fixtures therefore author what a model
 * authors and no more, which is the point — a fixture that could still spell
 * out a condition would be testing a contract the provider is never given.
 */
function mechanic(
  over: Partial<ModuleMechanic> & Pick<ModuleMechanic, "gate_port">,
): ModuleMechanic {
  return {
    verb: "ask",
    action_label: "Ask what returning it will cost her",
    flag_label: "Cost weighed",
    flag_visible: false,
    dialogue_speaker: "character",
    dialogue_text: "It costs me the chance to change my mind. That is the whole of it.",
    gate_blocked_text: "Ask what returning it costs her before promising.",
    hook: null,
    ...over,
  };
}

/**
 * A Discovery module the real validator accepts, with a real witness.
 *
 * One mechanic: inspecting the letter closely tells the player something, and
 * `core.give` stays locked until they have done it. Closing `core.give`
 * changes which actions are legal, which is what makes the witness mechanical
 * rather than decorative.
 */
export function validDiscoveryOutput(): ModuleCompilationOutput {
  return {
    mechanics: [
      mechanic({
        gate_port: "core.give",
        verb: "inspect",
        action_label: "Look at the handwriting on the envelope",
        flag_label: "Handwriting read",
        dialogue_speaker: "narrator",
        dialogue_text:
          "The address is written twice, once crossed out. Someone changed their mind about where this was going.",
        gate_blocked_text: "Look at the envelope properly before handing it over.",
        hook: {
          dialogue_speaker: "narrator",
          dialogue_text: "Held to the light, the second address shows through the first.",
        },
      }),
    ],
  };
}

/**
 * A Commitment module the real validator accepts, with a real witness.
 *
 * One mechanic with a hook: a line on `core.ask_context` sets up the cost, and
 * `core.ask_terms` stays locked until the player has asked what returning the
 * letter costs her. Because `core.withhold` requires `core.promised` to still
 * be false, closing `core.ask_terms` changes which endings remain reachable.
 */
export function validCommitmentOutput(): ModuleCompilationOutput {
  return {
    mechanics: [
      mechanic({
        gate_port: "core.ask_terms",
        hook: {
          dialogue_speaker: "character",
          dialogue_text:
            "If you promise, I will hold you to it. I would rather you said nothing than said it lightly.",
        },
      }),
    ],
  };
}

/**
 * Two mechanics in one module, each gating a different commitment port.
 *
 * It exercises the part of the contract that is genuinely the model's choice:
 * how many mechanics to build, and which base action each one earns.
 */
export function twoMechanicCommitmentOutput(): ModuleCompilationOutput {
  return {
    mechanics: [
      validCommitmentOutput().mechanics[0] as ModuleMechanic,
      mechanic({
        gate_port: "core.withhold",
        action_label: "Ask who else has come looking for it",
        flag_label: "Other claimants asked about",
        flag_visible: true,
        dialogue_speaker: "character",
        dialogue_text: "No one. That is what frightens me about it being here at all.",
        gate_blocked_text: "Find out who else wants it before you decide to keep it.",
      }),
    ],
  };
}

/**
 * A module that gates a port belonging to the other slot.
 *
 * The contract the provider is given cannot express this: `gate_port` is
 * enumerated from the asked-for slot's own ports, so a commitment module is
 * offered only `core.ask_terms` and `core.withhold`. It stays representable in
 * the slot-agnostic type, which is what lets this fixture prove that
 * `GATE_PORT_INVALID` is still enforced underneath the narrowed schema rather
 * than merely unreachable.
 */
export function wrongPortModuleOutput(): ModuleCompilationOutput {
  return { mechanics: [mechanic({ gate_port: "core.give" })] };
}

/** More mechanics than the module variable budget allows. */
export function overBudgetModuleOutput(): ModuleCompilationOutput {
  return {
    mechanics: Array.from({ length: BUDGET.module_variables + 2 }, (_unused, index) =>
      mechanic({
        gate_port: "core.ask_terms",
        action_label: `Ask her something else, the ${index + 1}th time`,
        flag_label: `Asked ${index + 1}`,
      }),
    ),
  };
}

/** A module whose line uses {@link FORBIDDEN_PHRASE}. */
export function forbiddenWordingModuleOutput(): ModuleCompilationOutput {
  return {
    mechanics: [
      mechanic({
        gate_port: "core.ask_terms",
        dialogue_text: "She will not say. The whole affair is a moral quandary to her.",
      }),
    ],
  };
}

/** A module whose line carries a control character the scene contract refuses. */
export function nonPlainTextModuleOutput(): ModuleCompilationOutput {
  return {
    mechanics: [
      mechanic({ gate_port: "core.ask_terms", dialogue_text: "She weighs it. Then nothing." }),
    ],
  };
}
