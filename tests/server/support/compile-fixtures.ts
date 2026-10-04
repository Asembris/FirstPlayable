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
} from "../../../src/domain/compile";
import type { ApprovedInfluence, ApprovedInfluencePayload } from "../../../src/domain/influence";
import type { Action, InfluenceModule } from "../../../src/domain/scene";
import {
  SECOND_COPY_BASE,
  SECOND_COPY_DISCOVERY_V1,
} from "../../../fixtures/second-copy";

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
    reference_id: "ref.mv.moon",
    name: "Moon",
    domain: "movie",
    year: 2009,
  },
  evidence: [
    {
      id: "ref.mv.moon#ev1",
      field_path: "properties.plot_themes_description",
      text: "Probes what makes someone human by exploring identity and memory under isolation.",
    },
  ],
};

export const COMMITMENT_APPROVAL_PAYLOAD: ApprovedInfluencePayload = {
  slot: "commitment",
  approval_id: APPROVAL_IDS.commitment,
  approved_text: `Naming what the promise costs is required before the promise can be made. ${SENTINELS.commitmentApproval}`,
  intended_effect: "Asking why she came back reveals the cost; the promise needs that cost named.",
  reference: {
    reference_id: "ref.vg.dragonage",
    name: "Dragon Age: Origins",
    domain: "videogame",
    year: 2009,
  },
  evidence: [
    {
      id: "ref.vg.dragonage#ev1",
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
    entity_id: "6BBB34F4-9345-4459-82AE-10991FA35CD2",
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
function toModelEffects(
  effects: readonly { var_id: string }[],
  declared: readonly { id: string }[],
): { variable_index: number }[] {
  return effects.map((effect) => ({
    variable_index: declared.findIndex((variable) => variable.id === effect.var_id),
  }));
}

/** Strips the server-assigned fields back out of a hand-authored action. */
function toModelAction(
  action: Action,
  declared: readonly { id: string }[],
): ModuleCompilationOutput["actions"][number] {
  return {
    id: action.id,
    verb: action.verb,
    label: action.label,
    when: action.when,
    branches: action.branches.map((branch) => ({
      when: branch.when,
      effects: toModelEffects(branch.effects, declared),
      dialogue_id: branch.dialogue_id,
      ending_id: branch.ending_id,
    })),
  };
}

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

function moduleToModelOutput(module: InfluenceModule): ModuleCompilationOutput {
  return {
    variables: module.variables.map((variable) => ({
      id: variable.id,
      label: variable.label,
      visible: variable.visible,
    })),
    actions: module.actions.map((action) => toModelAction(action, module.variables)),
    dialogue: module.dialogue.map((node) => ({
      id: node.id,
      speaker_id: node.speaker_id,
      text: node.text,
    })),
    gates: module.gates.map((gate) => ({
      id: gate.id,
      action_id: gate.action_id,
      when: gate.when,
      blocked_text: gate.blocked_text,
    })),
    on_actions: module.on_actions.map((hook) => ({
      id: hook.id,
      when: hook.when,
      effects: toModelEffects(hook.effects, module.variables),
      dialogue_id: hook.dialogue_id,
    })),
  };
}

const DISCOVERY_FIXTURE = SECOND_COPY_DISCOVERY_V1.modules.find(
  (module) => module.slot === "discovery",
) as InfluenceModule;

/** A Discovery module the real validator accepts, with a real witness. */
export function validDiscoveryOutput(): ModuleCompilationOutput {
  return moduleToModelOutput(DISCOVERY_FIXTURE);
}

/**
 * A Commitment module the real validator accepts, with a real witness.
 *
 * It attaches to its own two ports: a hook on `core.ask_context` records that
 * the cost was named, and a gate on `core.ask_terms` requires the cost to have
 * been named before the promise can be made. Because `core.withhold` requires
 * `core.promised` to still be false, closing `core.ask_terms` changes which
 * endings remain reachable, which is what makes the witness mechanical.
 */
export function validCommitmentOutput(): ModuleCompilationOutput {
  return {
    variables: [
      { id: "commitment.cost_named", label: "Cost named", visible: false },
      { id: "commitment.cost_weighed", label: "Cost weighed", visible: false },
    ],
    actions: [
      {
        id: "commitment.ask_cost",
        verb: "ask",
        label: "Ask what returning it will cost her",
        when: {
          kind: "any",
          clauses: [
            [
              { var_id: "commitment.cost_named", equals: true },
              { var_id: "commitment.cost_weighed", equals: false },
            ],
          ],
        },
        branches: [
          {
            when: { kind: "always" },
            // commitment.cost_weighed, the second variable declared above.
            effects: [{ variable_index: 1 }],
            dialogue_id: "commitment.cost_text",
            ending_id: null,
          },
        ],
      },
    ],
    dialogue: [
      {
        id: "commitment.named_text",
        speaker_id: "nia",
        text: "If you promise, I will hold you to it. I would rather you said nothing than said it lightly.",
      },
      {
        id: "commitment.cost_text",
        speaker_id: "nia",
        text: "It costs me the chance to change my mind. That is the whole of it.",
      },
    ],
    gates: [
      {
        id: "commitment.terms_gate",
        action_id: "core.ask_terms",
        when: {
          kind: "any",
          clauses: [[{ var_id: "commitment.cost_weighed", equals: true }]],
        },
        blocked_text: "Ask what returning it costs her before promising.",
      },
    ],
    on_actions: [
      {
        id: "commitment.context_hook",
        when: { kind: "always" },
        // commitment.cost_named, the first variable declared above.
        effects: [{ variable_index: 0 }],
        dialogue_id: "commitment.named_text",
      },
    ],
  };
}

/** A module that reads the other slot's variable. */
export function crossSlotModuleOutput(): ModuleCompilationOutput {
  const output = validCommitmentOutput();
  return {
    ...output,
    gates: output.gates.map((gate) => ({
      ...gate,
      when: {
        kind: "any" as const,
        clauses: [[{ var_id: "discovery.disclosed", equals: true }]],
      },
    })),
  };
}

/**
 * A module whose effect names a variable it never declared.
 *
 * Writing a *foundation* variable is no longer expressible: an effect names a
 * position in the module's own `variables` array, so there is no field in
 * which to put `core.promised`. What remains representable is an index past
 * the end of that array, and this is it. The server resolves it to a reserved
 * undeclared id, so it lands as one readable `VAR_UNRESOLVED` finding rather
 * than as a silently dropped effect.
 */
export function unresolvedEffectModuleOutput(): ModuleCompilationOutput {
  const output = validCommitmentOutput();
  return {
    ...output,
    on_actions: output.on_actions.map((hook) => ({
      ...hook,
      effects: [{ variable_index: output.variables.length + 3 }],
    })),
  };
}

/** A module that attaches to a port it does not own. */
export function wrongPortModuleOutput(): ModuleCompilationOutput {
  const output = validCommitmentOutput();
  return {
    ...output,
    gates: output.gates.map((gate) => ({ ...gate, action_id: "core.give" })),
  };
}

/** A module whose own action ends the scene. */
export function terminalModuleOutput(): ModuleCompilationOutput {
  const output = validCommitmentOutput();
  return {
    ...output,
    actions: output.actions.map((action) => ({
      ...action,
      branches: action.branches.map((branch) => ({ ...branch, ending_id: "end.keep" })),
    })),
  };
}

/**
 * A module that is schema-valid and structurally legal but mechanically empty.
 *
 * It introduces a flag, sets it from its own action, reads it in its own
 * condition, and gates nothing. No legal action availability and no reachable
 * ending changes, so the witness search finds nothing consequential.
 */
export function mechanicallyEmptyModuleOutput(): ModuleCompilationOutput {
  return {
    variables: [{ id: "commitment.noted", label: "Noted", visible: false }],
    actions: [
      {
        id: "commitment.ask_mood",
        verb: "ask",
        label: "Ask how her evening has been",
        when: {
          kind: "any",
          clauses: [[{ var_id: "commitment.noted", equals: false }]],
        },
        branches: [
          {
            when: { kind: "always" },
            // commitment.noted, the only variable this module declares.
            effects: [{ variable_index: 0 }],
            dialogue_id: "commitment.mood_text",
            ending_id: null,
          },
        ],
      },
    ],
    dialogue: [
      {
        id: "commitment.mood_text",
        speaker_id: "nia",
        text: "Long. The trains were late and the platform was cold. None of that matters now.",
      },
    ],
    gates: [],
    on_actions: [],
  };
}

/** A module whose ids are outside its slot namespace. */
export function badNamespaceModuleOutput(): ModuleCompilationOutput {
  const output = validCommitmentOutput();
  return {
    ...output,
    variables: output.variables.map((variable, index) =>
      index === 0 ? { ...variable, id: "rogue.cost_named" } : variable,
    ),
  };
}
