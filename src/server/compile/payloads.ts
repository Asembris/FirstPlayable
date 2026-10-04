/**
 * The Phase 4 half of the context firewall (specification section 7).
 *
 * Three pure builders with explicit parameter lists, and nothing else:
 *
 * ```ts
 * buildBaseCompilationPayload(brief)
 * buildModuleCompilationPayload(base, approvedInfluence)
 * buildRepairPayload(original, failedCandidate, deterministicErrors)
 * ```
 *
 * A builder cannot reach what it was not handed. There is no project object in
 * scope, no mutable transcript, no provider conversation handle, no previous
 * response id, no composed scene, and no `approved` flag read from a request
 * body. The base builder takes one parameter — the frozen brief — so an artist
 * name, a reference title, an evidence excerpt, a dismissed proposal, and an
 * approval are not *filtered out* of its result, they are unreachable from it.
 *
 * The module builder takes exactly two: the clean base representation needed
 * for attachment, and one {@link ApprovedInfluencePayload}, which phase 3
 * already narrowed to one approval, its own reference, and the evidence that
 * approval cited. The other slot's approval is a different value that this
 * call never receives.
 *
 * What the base representation handed to a module deliberately contains: the
 * foundation's ids, verbs, labels, dialogue, endings, and this slot's two
 * attachment points. What it deliberately does not contain: the other slot's
 * port, any already-composed module, any influence reference, any provenance
 * binding, the scene id, or any hash. A module is attached to a clean base, not
 * to a scene that already carries someone else's interpretation.
 *
 * `buildRepairPayload` is the narrowest of the three by construction: it takes
 * an already-built payload and returns a value with the same `context` field
 * plus the failed candidate and this application's own finding codes. It has no
 * parameter through which more context could enter, so a repair cannot widen
 * the original information boundary.
 *
 * What all of this guarantees, precisely: **dataflow and ownership
 * isolation.** It does not guarantee that a language model could never
 * independently invent a similar idea from the brief alone, and this module
 * makes no such claim.
 */

import type { Brief } from "@/domain/brief";
import type { ApprovedInfluencePayload, Slot } from "@/domain/influence";
import { FIXED_PORTS } from "@/domain/limits";
import type { CoreScene, Scene } from "@/domain/scene";
import { hashCanonical } from "@/engine/hash";

/* ------------------------------------------------------------- the brief */

/**
 * The brief as a compiler sees it.
 *
 * The same shape phase 3's proposal payload uses, for one reason: the brief is
 * the brief. `cultural_anchor_query` is absent — it is the artist query, which
 * no compilation stage may see.
 */
export type BriefForCompiler = {
  title: string | null;
  premise: string;
  player_role: string;
  room: { id: string; name: string; description: string };
  character: { id: string; name: string; role: string };
  object: { id: string; name: string; description: string };
  tone: Brief["tone"];
  forbidden_wording: string[];
};

export function toBriefForCompiler(brief: Brief): BriefForCompiler {
  return {
    title: brief.title,
    premise: brief.premise,
    player_role: brief.player_role,
    room: { id: brief.room.id, name: brief.room.name, description: brief.room.description },
    character: {
      id: brief.character.id,
      name: brief.character.name,
      role: brief.character.role,
    },
    object: {
      id: brief.object.id,
      name: brief.object.name,
      description: brief.object.description,
    },
    tone: brief.tone,
    forbidden_wording: [...brief.forbidden_wording],
  };
}

/* ------------------------------------------------------- the base payload */

export type BaseCompilationPayload = {
  readonly stage: "base";
  readonly brief: BriefForCompiler;
};

/**
 * The brief-only base payload.
 *
 * One parameter. That is the mechanism, and the unit tests assert the
 * consequence: a sentinel inserted into an artist query, a reference title, an
 * evidence excerpt, a dismissed proposal, or an approval cannot appear in this
 * value, because no argument carries one.
 */
export function buildBaseCompilationPayload(brief: Brief): BaseCompilationPayload {
  return { stage: "base", brief: toBriefForCompiler(brief) };
}

/* ----------------------------------------------------- the base view sent
 *                                                       to a module stage */

/**
 * The clean foundation as one module sees it.
 *
 * Structural only: what exists, what it is called, and what this slot is
 * allowed to attach to. `ports` holds this slot's two attachment points alone,
 * so a module is not even shown the other slot's port names.
 */
export type BaseForModule = {
  readonly title: string;
  readonly world: {
    player_role: string;
    room: { id: string; name: string; description: string };
    character: { id: string; name: string; role: string };
    object: { id: string; name: string; description: string };
  };
  readonly variables: { id: string; label: string }[];
  readonly actions: { id: string; verb: string; label: string }[];
  readonly dialogue: { id: string; speaker_id: string; text: string }[];
  readonly endings: { id: string; title: string }[];
  readonly ports: { gate_action_ids: string[]; effect_action_ids: string[] };
};

/**
 * Projects the clean base down to what one slot needs in order to attach.
 *
 * Takes the `CoreScene` and the world rather than a whole `Scene`, so an
 * already-composed module, an influence reference, and a provenance binding
 * are not in the input at all. Ending *text* is omitted too: a module may not
 * rewrite an ending, so it has no use for the wording.
 */
export function toBaseForModule(
  title: string,
  world: Scene["world"],
  core: CoreScene,
  slot: Slot,
): BaseForModule {
  return {
    title,
    world: {
      player_role: world.player_role,
      room: { id: world.room.id, name: world.room.name, description: world.room.description },
      character: {
        id: world.characters[0].id,
        name: world.characters[0].name,
        role: world.characters[0].role,
      },
      object: {
        id: world.object.id,
        name: world.object.name,
        description: world.object.description,
      },
    },
    variables: core.variables.map((variable) => ({
      id: variable.id,
      label: variable.label,
    })),
    actions: core.actions.map((action) => ({
      id: action.id,
      verb: action.verb,
      label: action.label,
    })),
    dialogue: core.dialogue.map((node) => ({
      id: node.id,
      speaker_id: node.speaker_id,
      text: node.text,
    })),
    endings: core.endings.map((ending) => ({ id: ending.id, title: ending.title })),
    ports: {
      gate_action_ids: [...FIXED_PORTS[slot].gate_action_ids],
      effect_action_ids: [...FIXED_PORTS[slot].effect_action_ids],
    },
  };
}

/* ----------------------------------------------------- the module payload */

/**
 * One module stage's whole payload.
 *
 * `approved_interaction` is the creator's frozen wording and the evidence the
 * approval cited, exactly as phase 3's `buildApprovedInfluencePayload`
 * narrowed it. `forbidden_wording` is carried separately because the module
 * must honour it, and it is the only brief field a module receives: the
 * premise and the tone reached the base, and the base representation above is
 * what the module builds against.
 */
export type ModuleCompilationPayload = {
  readonly stage: "module";
  readonly slot: Slot;
  readonly base: BaseForModule;
  readonly approved_interaction: {
    approved_text: string;
    intended_effect: string;
    source: { name: string; domain: string; year: number | null };
    evidence: { id: string; field_path: string; text: string }[];
  };
  readonly forbidden_wording: string[];
};

/**
 * Builds one module stage's payload from the clean base and one approval.
 *
 * The approval's own `slot` decides which port description is sent, so a
 * caller cannot ask for a Discovery module using a Commitment approval. Note
 * what is dropped from the approval on the way in: the approval id, the
 * application reference id, the capture id, the entity UUID, the original
 * rank, and the affinity. The server binds the approval id to the compiled
 * module itself; a model that could echo one back could claim its own
 * provenance.
 */
export function buildModuleCompilationPayload(
  base: { title: string; world: Scene["world"]; core: CoreScene },
  approval: ApprovedInfluencePayload,
  forbiddenWording: readonly string[] = [],
): ModuleCompilationPayload {
  return {
    stage: "module",
    slot: approval.slot,
    base: toBaseForModule(base.title, base.world, base.core, approval.slot),
    approved_interaction: {
      approved_text: approval.approved_text,
      intended_effect: approval.intended_effect,
      source: {
        name: approval.reference.name,
        domain: approval.reference.domain,
        year: approval.reference.year,
      },
      evidence: approval.evidence.map((item) => ({
        id: item.id,
        field_path: item.field_path,
        text: item.text,
      })),
    },
    forbidden_wording: [...forbiddenWording],
  };
}

/* ------------------------------------------------ the ending-copy payload */

/**
 * One ending-copy stage's whole payload (specification section 9).
 *
 * Three parameters, and the consequence is the point: the frozen brief, one
 * ending's own wording, and the creator's request. There is no parameter for an
 * influence module, a cultural reference, an evidence excerpt, a proposal
 * accepted or dismissed, a composed scene, another ending, or a transcript. So
 * a copy operation cannot become an unowned path through which retained
 * cultural module text survives a rejection — not because this function filters
 * such text out, but because no argument carries any.
 *
 * `base_text` and `current_text` are both sent because they answer different
 * questions: what the encounter originally said, and what the creator is
 * actually looking at now after any earlier edit of their own.
 */
export type EndingCopyPayload = {
  readonly stage: "ending_copy";
  readonly brief: BriefForCompiler;
  readonly ending: {
    id: string;
    title: string;
    base_text: string;
    current_text: string;
  };
  readonly request: string;
};

export function buildEndingCopyPayload(
  brief: Brief,
  ending: { id: string; title: string; baseText: string; currentText: string },
  request: string,
): EndingCopyPayload {
  return {
    stage: "ending_copy",
    brief: toBriefForCompiler(brief),
    ending: {
      id: ending.id,
      title: ending.title,
      base_text: ending.baseText,
      current_text: ending.currentText,
    },
    request,
  };
}

/* ----------------------------------------------------- the repair payload */

/**
 * One deterministic finding, as a repair is allowed to see it.
 *
 * A code and a sentence this application wrote. Never a provider message,
 * never a stack trace, and never a finding about another stage's candidate.
 */
export type DeterministicError = { code: string; detail: string };

export type RepairPayload<T> = {
  readonly stage: "repair";
  /** The exact value the first attempt was given. Not a widened copy. */
  readonly context: T;
  /** This stage's own rejected output. */
  readonly rejected_output: unknown;
  readonly findings: DeterministicError[];
};

/** How many findings a repair note carries. Enough to fix, short enough to read. */
export const MAX_REPAIR_FINDINGS = 10;

/**
 * Builds the one permitted repair payload.
 *
 * Its first parameter is the original payload value, passed through by
 * reference rather than rebuilt, so the repair's context is identical to the
 * first attempt's by construction — there is no code path here that could add
 * a field to it. The second is this stage's own failed candidate. The third is
 * this application's own findings.
 *
 * `rejected_output` is dropped when it is larger than `maxCandidateBytes`, and
 * the caller is told so, rather than silently sending a truncated object a
 * model would try to complete.
 */
export function buildRepairPayload<T>(
  originalContext: T,
  failedCandidate: unknown,
  deterministicErrors: readonly DeterministicError[],
  options: { maxCandidateBytes?: number } = {},
): RepairPayload<T> {
  const maxBytes = options.maxCandidateBytes ?? 12 * 1024;
  const serialized = JSON.stringify(failedCandidate ?? null);
  const withinBudget =
    new TextEncoder().encode(serialized).byteLength <= maxBytes;

  return {
    stage: "repair",
    context: originalContext,
    rejected_output: withinBudget ? failedCandidate : null,
    findings: deterministicErrors
      .slice(0, MAX_REPAIR_FINDINGS)
      .map((error) => ({ code: error.code, detail: error.detail })),
  };
}

/* ------------------------------------------------------------- utilities */

/** Deterministic JSON for a payload, used as the model input and for hashing. */
export function serializeCompilerPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 1);
}

/** The canonical hash of a payload, used for stage idempotency and the snapshot. */
export function payloadHash(payload: unknown): string {
  return hashCanonical(payload).slice(0, 48);
}
