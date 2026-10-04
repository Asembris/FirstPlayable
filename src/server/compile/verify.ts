/**
 * Verification: the deterministic engine decides whether a candidate is
 * acceptable (specification section 5).
 *
 * Phase 4 adds no validator. Every judgement here comes from the Phase 1
 * engine — `validateScene`, `validateSceneSubsets`, and
 * `findMechanicalWitness` — and this module only decides *which* of those to
 * run at which stage, and turns their findings into the concise deterministic
 * error list the one permitted repair is allowed to see.
 *
 * Three deliberate choices:
 *
 *   * **A module stage validates `base + that module alone`.** Not the whole
 *     composed set. That is what makes the repair's error list structurally
 *     incapable of mentioning the other slot: the other module is not in the
 *     scene that produced the findings, so no finding can name it.
 *   * **The witness is required at the module stage, not only at the end.** A
 *     module that changes no legal action availability and no reachable ending
 *     is rejected while its own repair is still available.
 *   * **A resource-limit outcome is a failure.** `exploreScene` and the
 *     witness search both report exhaustion, and `validateScene` already turns
 *     that into a finding. Nothing here treats an unfinished search as a pass.
 */

import type { Brief } from "@/domain/brief";
import type {
  SubsetReportView,
  ValidationSummaryView,
  WitnessSummaryView,
} from "@/domain/compile";
import type { Slot } from "@/domain/influence";
import type { Scene } from "@/domain/scene";
import { sceneWithModuleSubset } from "@/engine/compose";
import type { MechanicalWitness, WitnessObservation } from "@/engine/diff";
import type { Finding, ValidationReport } from "@/engine/validate";
import { validateScene, validateSceneSubsets } from "@/engine/validate";
import type { DeterministicError } from "./payloads";

/**
 * Finding codes that mean the analysis did not finish rather than that the
 * candidate is wrong. Both are failures; they are reported under their own
 * compilation failure code so the creator sees the honest reason.
 */
export const RESOURCE_LIMIT_CODES: readonly string[] = [
  "VALIDATION_RESOURCE_LIMIT",
  "WITNESS_SEARCH_OVERFLOW",
];

export function hitResourceLimit(findings: readonly Finding[]): boolean {
  return findings.some((finding) => RESOURCE_LIMIT_CODES.includes(finding.code));
}

/** The engine's findings as a repair may see them: a code and one sentence. */
export function toDeterministicErrors(
  findings: readonly Finding[],
): DeterministicError[] {
  return findings.map((finding) => ({
    code: finding.code,
    detail:
      finding.where === null
        ? finding.message
        : `${finding.where}: ${finding.message}`,
  }));
}

/* ------------------------------------------------------------ base stage */

export type StageVerdict = {
  readonly ok: boolean;
  readonly report: ValidationReport;
  readonly errors: DeterministicError[];
  readonly resourceLimited: boolean;
};

/**
 * Verifies a freshly compiled clean base.
 *
 * The base carries no module, so the approval allowlist is empty and the
 * witness search has nothing to compare — `checkModuleWitnesses` is left on
 * because it is vacuous here, not because it is being skipped.
 */
export function verifyBase(scene: Scene, brief: Brief): StageVerdict {
  const report = validateScene(scene, brief, { approvedApprovalIds: [] });
  return {
    ok: report.ok,
    report,
    errors: toDeterministicErrors(report.findings),
    resourceLimited: hitResourceLimit(report.findings),
  };
}

/* ---------------------------------------------------------- module stage */

/**
 * Verifies one module against the clean base and nothing else.
 *
 * `scene` must already be the two-part composition: the clean core plus this
 * one module. The caller builds it that way; this function asserts the
 * consequence by validating what it was given, so every finding it returns is
 * about the base or about this slot.
 */
export function verifyModule(
  scene: Scene,
  brief: Brief,
  slot: Slot,
  approvedApprovalIds: readonly string[],
): StageVerdict {
  const report = validateScene(scene, brief, { approvedApprovalIds });
  const errors = toDeterministicErrors(report.findings);
  const witness = report.module_witnesses[slot];
  return {
    ok: report.ok && witness !== undefined && witness.mechanical,
    report,
    errors,
    resourceLimited: hitResourceLimit(report.findings),
  };
}

/* ------------------------------------------------------- validate stage */

export type CandidateVerdict = {
  readonly ok: boolean;
  /** True when each module validates alone but the composed set does not. */
  readonly subsetConflict: boolean;
  readonly resourceLimited: boolean;
  readonly summary: ValidationSummaryView;
  readonly errors: DeterministicError[];
};

/**
 * Validates the full candidate and **every** supported removal subset.
 *
 * `validateSceneSubsets` covers the base alone, each module alone, and the
 * composed pair — at most four reports. All of them must pass, even though
 * only the composed set becomes the pending version, because a subset that
 * cannot validate would be reachable later by removing an influence.
 *
 * `subsetConflict` distinguishes the one failure shape that is nobody's module
 * in particular: every proper subset is valid and only the full composition is
 * not. There is no repair for it — repairing "the scene" would replace modules
 * that individually passed — so the compilation fails explicitly and the
 * previous active version stays current.
 */
export function verifyCandidate(
  scene: Scene,
  brief: Brief,
  approvedApprovalIds: readonly string[],
): CandidateVerdict {
  const full = validateScene(scene, brief, { approvedApprovalIds });
  const subsets = validateSceneSubsets(scene, brief, { approvedApprovalIds });

  const activeSlots = scene.modules.map((module) => module.slot);
  const properSubsetsOk = subsets.subsets
    .filter((entry) => entry.slots.length < activeSlots.length)
    .every((entry) => entry.report.ok);

  const subsetViews: SubsetReportView[] = subsets.subsets.map((entry) => ({
    slots: [...entry.slots],
    ok: entry.report.ok,
    finding_codes: uniqueCodes(entry.report.findings),
  }));

  const witnesses = witnessViews(scene, full);

  const summary: ValidationSummaryView = {
    ok: full.ok && subsets.ok && witnesses.every((witness) => witness.mechanical),
    active_slots: [...full.active_slots],
    finding_codes: uniqueCodes(full.findings),
    reachable_endings: full.graph === null ? [] : [...full.graph.reachable_endings],
    reachable_nonterminal_states:
      full.graph === null ? 0 : full.graph.reachable_nonterminal_states,
    edges: full.graph === null ? 0 : full.graph.edges,
    subsets: subsetViews,
    witnesses,
    notes: [...full.notes].slice(0, 8),
  };

  const resourceLimited =
    hitResourceLimit(full.findings) ||
    subsets.subsets.some((entry) => hitResourceLimit(entry.report.findings));

  return {
    ok: summary.ok,
    subsetConflict: !summary.ok && properSubsetsOk && !full.ok && activeSlots.length > 1,
    resourceLimited,
    summary,
    errors: toDeterministicErrors(full.findings),
  };
}

function uniqueCodes(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.code))].slice(0, 32);
}

/* ----------------------------------------------------------- witness view */

/**
 * The first mechanical observation for each module, as a sentence built from
 * the observation's own fields.
 *
 * "Mechanical" means the engine saw a changed legal action availability or a
 * changed reachable-ending set in a paired replay. An introduced action on its
 * own is reported as `action_set` and does **not** make a witness mechanical:
 * `findMechanicalWitness` only sets `mechanical` for the two consequential
 * kinds, which is exactly the specification's rule that extra prose and an
 * unused action are not enough.
 */
export function witnessViews(
  scene: Scene,
  report: ValidationReport,
): WitnessSummaryView[] {
  const views: WitnessSummaryView[] = [];
  for (const module of scene.modules) {
    const witness = report.module_witnesses[module.slot];
    if (witness === undefined) continue;
    views.push(toWitnessView(module.slot, module.approval_id, witness));
  }
  return views;
}

export function toWitnessView(
  slot: Slot,
  approvalId: string,
  witness: MechanicalWitness,
): WitnessSummaryView {
  const consequential = witness.observations.find(
    (observation) =>
      observation.kind === "action_availability" ||
      observation.kind === "ending_reachability",
  );
  const observation = consequential ?? witness.observations[0] ?? null;
  return {
    slot,
    approval_id: approvalId,
    mechanical: witness.mechanical,
    kind: observation === null ? null : observation.kind,
    action_id: observation === null ? null : observation.action_id,
    prefix: observation === null ? [] : [...observation.prefix].slice(0, 16),
    before: clamp(observation === null ? "unchanged" : observation.before, 200),
    after: clamp(observation === null ? "unchanged" : observation.after, 200),
    sentence: clamp(describeWitness(slot, witness, observation), 300),
    pairs_explored: witness.pairs_explored,
  };
}

/**
 * The "Scene changed" sentence of specification section 13.
 *
 * Generated from the observation's own fields. It states what the engine saw,
 * names the replay prefix that reaches it, and claims nothing about quality,
 * originality, or what produced the idea.
 */
export function describeWitness(
  slot: Slot,
  witness: MechanicalWitness,
  observation: WitnessObservation | null,
): string {
  if (observation === null) {
    return witness.overflow
      ? `No ${slot} difference was proven before the paired-replay bound was reached.`
      : `No ${slot} difference was observed between this version and the same version without it.`;
  }
  const after = describePrefix(observation.prefix);
  switch (observation.kind) {
    case "action_availability":
      return `${after}"${observation.action_id}" is ${observation.after} with the ${slot} influence and ${observation.before} without it.`;
    case "ending_reachability":
      return `${after}the endings still reachable are ${observation.after} with the ${slot} influence and ${observation.before} without it.`;
    default:
      return `${after}the ${slot} influence introduces "${observation.action_id}", which the foundation alone does not offer.`;
  }
}

/** Keeps a generated sentence inside the contract's cap without truncating mid-word. */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}\u2026`;
}

function describePrefix(prefix: readonly string[]): string {
  if (prefix.length === 0) return "At the start, ";
  return `After ${prefix.join(" then ")}, `;
}

/* -------------------------------------------------- composition helpers */

/** The candidate reduced to the clean base plus one module. */
export function sceneWithOnlySlot(scene: Scene, slot: Slot): Scene {
  return sceneWithModuleSubset(scene, [slot]);
}
