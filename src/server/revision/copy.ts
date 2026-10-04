/**
 * The ending-copy stage: one bounded provider call that can only return prose
 * (specification section 9).
 *
 * Like every other stage in this application it performs **at most one**
 * provider attempt per invocation, and the attempt ceiling is the database's:
 * the caller reserves an `ending_copy` operation row with `max_attempts = 2`,
 * a rejected candidate parks it, the next request spends attempt two, and a
 * third gets `attempts_exhausted` from `reserve_operation` itself. There is no
 * counter in this file.
 *
 * Two properties are worth naming because they are mechanisms rather than
 * promises:
 *
 *   * **A preview applies nothing.** This function returns wording. The caller
 *     stores it on the operation row and shows it; a separate, explicit apply
 *     command — which makes no provider call at all — is what composes a
 *     version from it. There is no code path here that writes a project column
 *     or a version row.
 *   * **A wording that could not be applied is not offered.** The candidate
 *     scene is composed with the override and submitted to the unchanged
 *     Phase 1 validator before the preview is returned, so forbidden wording, a
 *     text bound, or a narrative-total overrun is a rejection with a repair
 *     rather than a preview the creator cannot use.
 */

import type { Brief } from "@/domain/brief";
import { EndingCopyOutputSchema } from "@/domain/compile";
import type { Scene } from "@/domain/scene";
import type { ModelUsage } from "../model/openai";
import {
  ENDING_COPY_MAX_OUTPUT_TOKENS,
  ENDING_COPY_SCHEMA_NAME,
  type SceneCompiler,
} from "../compile/compiler";
import { ENDING_COPY_INSTRUCTIONS } from "../compile/instructions";
import {
  buildEndingCopyPayload,
  buildRepairPayload,
  type DeterministicError,
} from "../compile/payloads";
import { repairNote, type RepairContext } from "../compile/stages";
import { verifyCandidate } from "../compile/verify";

export type EndingCopyStageInput = {
  readonly brief: Brief;
  readonly ending: {
    readonly id: string;
    readonly title: string;
    /** The ending as the encounter was first written. */
    readonly baseText: string;
    /** The ending as it reads now, which may already be a creator edit. */
    readonly currentText: string;
  };
  readonly request: string;
  /**
   * Composes the candidate scene this wording would produce, exactly as the
   * apply command will compose it. Supplied by the caller so this stage holds
   * no gateway and cannot write anything; `null` means the wording cannot be
   * composed at all, which is a rejection rather than a silent pass.
   */
  readonly candidateFor: (text: string) => Scene | null;
  /** The frozen approval allowlist the validator checks the candidate against. */
  readonly approvedApprovalIds: readonly string[];
  readonly repair: RepairContext | null;
};

export type EndingCopyStageOutcome =
  | {
      readonly kind: "committed";
      readonly text: string;
      readonly model: string;
      readonly usage: ModelUsage | null;
    }
  | {
      readonly kind: "rejected";
      readonly errors: DeterministicError[];
      readonly candidate: unknown;
      readonly resourceLimited: boolean;
      readonly model: string;
      readonly usage: ModelUsage | null;
    };

export async function runEndingCopyStage(
  input: EndingCopyStageInput,
  compiler: SceneCompiler,
): Promise<EndingCopyStageOutcome> {
  const payload = buildEndingCopyPayload(
    input.brief,
    {
      id: input.ending.id,
      title: input.ending.title,
      baseText: input.ending.baseText,
      currentText: input.ending.currentText,
    },
    input.request,
  );
  const repairing = input.repair !== null;

  const result = await compiler.generate({
    schemaName: ENDING_COPY_SCHEMA_NAME,
    schema: EndingCopyOutputSchema,
    instructions: repairing
      ? `${ENDING_COPY_INSTRUCTIONS}\n\n${repairNote(input.repair?.errors ?? [])}`
      : ENDING_COPY_INSTRUCTIONS,
    payload: repairing
      ? buildRepairPayload(payload, input.repair?.candidate ?? null, input.repair?.errors ?? [])
      : payload,
    maxOutputTokens: ENDING_COPY_MAX_OUTPUT_TOKENS,
  });

  const text = result.data.text.trim();
  const candidate = text.length === 0 ? null : input.candidateFor(text);
  if (candidate === null) {
    return {
      kind: "rejected",
      errors: [
        {
          code: "OVERRIDE_UNUSABLE",
          detail:
            "this wording does not satisfy the scene contract, most likely a length or plain-text bound",
        },
      ],
      candidate: result.data,
      resourceLimited: false,
      model: result.model,
      usage: result.usage,
    };
  }

  // The unchanged validator decides. A copy override cannot change a gate or a
  // reachable ending, so what it can fail on is the writing: forbidden wording
  // the brief declared, a text cap, or the whole-scene narrative total.
  const verdict = verifyCandidate(candidate, input.brief, input.approvedApprovalIds);
  if (!verdict.ok) {
    return {
      kind: "rejected",
      errors: verdict.errors,
      candidate: result.data,
      resourceLimited: verdict.resourceLimited,
      model: result.model,
      usage: result.usage,
    };
  }

  return { kind: "committed", text, model: result.model, usage: result.usage };
}
