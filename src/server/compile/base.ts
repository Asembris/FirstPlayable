/**
 * The deterministic clean-base skeleton (specification section 4; Phase 4
 * recovery amendment).
 *
 * **The server owns every mechanical element of the clean base.** This file is
 * the whole of that ownership, and it is plain data plus one pure function.
 * Nothing a model returns reaches a variable id, a variable definition, an
 * action id, a verb, a target, an availability condition, a branch count, a
 * branch condition, an effect, a dialogue node id, a dialogue speaker, an
 * ending id, an ending binding, or an attachment port.
 *
 * ## Why this exists
 *
 * Phase 4's first architecture asked the model to emit the base's mechanics and
 * then rejected what the validator refused. `docs/PHASE4_EVIDENCE.md` records
 * what that measured: seven live base compilations, six distinct deterministic
 * finding codes, and one clean commit. After five successive instruction fixes
 * the mechanical skeleton was fully prescribed in prose — the three variables,
 * every availability condition, one `{kind: always}` branch per action, and
 * which field each ending id belongs in — and the model still failed some part
 * of it on most attempts, a different part each time. Every one of those values
 * had exactly one legal answer. A field with one legal answer is the server's
 * to write, which is the same principle that already removed the module slot,
 * the approval authority, the hook attachment port, and the effect operator
 * from model output.
 *
 * ## What is *not* determinized
 *
 * Only the clean base. The Discovery and Commitment modules remain
 * independently model-compiled, because a module's mechanic is a genuine
 * creative choice: which base action to gate, what the player must do first,
 * and what that costs are not fixed by the product contract. This file takes no
 * position on them and cannot see them.
 *
 * ## The semantics, and where they come from
 *
 * The skeleton below is the one the hand-authored Phase 1 fixture
 * `fixtures/second_copy.base.json` already proves, value for value. It is not a
 * new state machine: the brief changes the world, the role, the character, the
 * object, the tone, and all of the writing, and it does not change the clean
 * base's state machine, which is what Phase 1 froze. `tests/server/compile-base.test.ts`
 * reads that fixture and asserts the two agree, so they cannot drift apart.
 */

import type { Brief } from "@/domain/brief";
import type { BaseNarrativeCopy } from "@/domain/compile";
import {
  REQUIRED_CORE_ACTIONS,
  REQUIRED_ENDING_IDS,
  TERMINAL_ENDING_BY_ACTION,
} from "@/domain/limits";
import type {
  Action,
  Condition,
  CoreScene,
  DialogueNode,
  Ending,
  StateVariable,
  World,
} from "@/domain/scene";
import { targetFor, worldFromBrief } from "./assemble";

/* ---------------------------------------------------------------- the ids */

/**
 * The three state variables, with the labels the server assigns.
 *
 * All three are `visible: false`, so no creator and no player ever reads a
 * label: these are internal names for the flag, which is why they are fixed
 * constants rather than anything a brief or a model supplies.
 */
export const BASE_VARIABLE_IDS = {
  inspected: "core.inspected",
  context: "core.context",
  promised: "core.promised",
} as const;

export const BASE_VARIABLE_LABELS: Readonly<Record<string, string>> = {
  [BASE_VARIABLE_IDS.inspected]: "Object inspected",
  [BASE_VARIABLE_IDS.context]: "Request understood",
  [BASE_VARIABLE_IDS.promised]: "Return promised",
};

/** The three dialogue node ids, one per nonterminal action. */
export const BASE_DIALOGUE_IDS = {
  inspect: "core.inspect_text",
  context: "core.context_text",
  commitment: "core.promise_text",
} as const;

/**
 * The six core action ids, in the skeleton's fixed order.
 *
 * Read from {@link REQUIRED_CORE_ACTIONS} so the skeleton and the validator's
 * own required-action table cannot disagree.
 */
export const BASE_ACTION_IDS = Object.keys(
  REQUIRED_CORE_ACTIONS,
) as readonly (keyof typeof REQUIRED_CORE_ACTIONS)[];

/* -------------------------------------------------------- the conditions */

/** One `{kind: any}` condition over a single clause of flag requirements. */
function requires(...atoms: readonly [string, boolean][]): Condition {
  return {
    kind: "any",
    clauses: [atoms.map(([var_id, equals]) => ({ var_id, equals }))],
  };
}

const { inspected, context, promised } = BASE_VARIABLE_IDS;

/**
 * Each core action's availability condition.
 *
 * This is the whole consequence structure of the clean base, and every
 * property the validator checks follows from it:
 *
 *   * `core.inspect` and `core.ask_context` each require their own flag to
 *     still be false, so each can be taken exactly once and then stops being
 *     offered. That is also where those two flags are *read*, which is what
 *     `VARIABLE_NEVER_READ` is about.
 *   * `core.ask_terms` requires both prior flags, so the explicit commitment
 *     is only available once the player understands the request, and requires
 *     `core.promised` to still be false so it too is a once-only action.
 *   * `core.give` and `core.leave` require the base understanding, and nothing
 *     else, so both remain legal after the commitment: all three endings stay
 *     reachable.
 *   * `core.withhold` additionally requires `core.promised` to be false, so
 *     stating the commitment closes off keeping the object. That read is the
 *     second place `core.promised` appears, and it is the consequential choice
 *     the engine's witness search and `NO_CONSEQUENTIAL_CHOICE` look for.
 *   * Every ending is therefore at least three actions away, which is
 *     `min_actions_to_ending`.
 */
export const BASE_AVAILABILITY: Readonly<
  Record<(typeof BASE_ACTION_IDS)[number], Condition>
> = {
  "core.inspect": requires([inspected, false]),
  "core.ask_context": requires([context, false]),
  "core.ask_terms": requires([inspected, true], [context, true], [promised, false]),
  "core.give": requires([inspected, true], [context, true]),
  "core.withhold": requires([inspected, true], [context, true], [promised, false]),
  "core.leave": requires([inspected, true], [context, true]),
};

/**
 * What each nonterminal action's one branch sets, and which dialogue it shows.
 *
 * Every nonterminal action progresses state — that is what makes `NO_PROGRESS`
 * unreachable by construction — and each flag written here is read by
 * {@link BASE_AVAILABILITY} above.
 */
const BASE_PROGRESS: Readonly<
  Record<string, { readonly var_id: string; readonly dialogue_id: string }>
> = {
  "core.inspect": { var_id: inspected, dialogue_id: BASE_DIALOGUE_IDS.inspect },
  "core.ask_context": { var_id: context, dialogue_id: BASE_DIALOGUE_IDS.context },
  "core.ask_terms": { var_id: promised, dialogue_id: BASE_DIALOGUE_IDS.commitment },
};

/* --------------------------------------------------------------- the copy */

/** Which copy field supplies each action's label. */
const LABEL_FIELD: Readonly<Record<string, keyof BaseNarrativeCopy>> = {
  "core.inspect": "inspect_label",
  "core.ask_context": "ask_context_label",
  "core.ask_terms": "ask_terms_label",
  "core.give": "give_label",
  "core.withhold": "withhold_label",
  "core.leave": "leave_label",
};

/** Which copy field supplies each dialogue node's text, and who speaks it. */
const DIALOGUE_COPY: readonly {
  readonly id: string;
  readonly field: keyof BaseNarrativeCopy;
  /** `"character"` resolves to the frozen brief's one character id. */
  readonly speaker: "narrator" | "player" | "character";
}[] = [
  { id: BASE_DIALOGUE_IDS.inspect, field: "inspect_dialogue", speaker: "narrator" },
  { id: BASE_DIALOGUE_IDS.context, field: "context_dialogue", speaker: "character" },
  { id: BASE_DIALOGUE_IDS.commitment, field: "commitment_dialogue", speaker: "player" },
];

/** Which copy fields supply each ending's title and prose. */
const ENDING_COPY: readonly {
  readonly id: (typeof REQUIRED_ENDING_IDS)[number];
  readonly title: keyof BaseNarrativeCopy;
  readonly text: keyof BaseNarrativeCopy;
}[] = [
  { id: "end.give", title: "give_ending_title", text: "give_ending_text" },
  { id: "end.keep", title: "keep_ending_title", text: "keep_ending_text" },
  { id: "end.leave", title: "leave_ending_title", text: "leave_ending_text" },
];

/* ----------------------------------------------------------- the skeleton */

function baseVariables(): StateVariable[] {
  return [inspected, context, promised].map((id) => ({
    id,
    label: BASE_VARIABLE_LABELS[id]!,
    initial: false,
    visible: false,
  }));
}

function baseActions(copy: BaseNarrativeCopy, world: World): Action[] {
  return BASE_ACTION_IDS.map((id) => {
    const verb = REQUIRED_CORE_ACTIONS[id];
    const progress = BASE_PROGRESS[id];
    const endingId =
      TERMINAL_ENDING_BY_ACTION[id as keyof typeof TERMINAL_ENDING_BY_ACTION] ?? null;
    return {
      id,
      verb,
      label: copy[LABEL_FIELD[id]!],
      target: targetFor(verb, world),
      when: BASE_AVAILABILITY[id],
      // Exactly one branch, always applicable: the availability condition above
      // is where all of this scene's consequence lives, so two branches on one
      // action could only ever be an ambiguity.
      branches: [
        {
          when: { kind: "always" as const },
          effects:
            progress === undefined
              ? []
              : [{ op: "set_true" as const, var_id: progress.var_id }],
          dialogue_id: progress?.dialogue_id ?? null,
          ending_id: endingId,
        },
      ],
    };
  });
}

function baseDialogue(copy: BaseNarrativeCopy, world: World): DialogueNode[] {
  return DIALOGUE_COPY.map((entry) => ({
    id: entry.id,
    speaker_id:
      entry.speaker === "character" ? world.characters[0]!.id : entry.speaker,
    text: copy[entry.field],
  }));
}

function baseEndings(copy: BaseNarrativeCopy): Ending[] {
  return ENDING_COPY.map((entry) => ({
    id: entry.id,
    title: copy[entry.title],
    text: copy[entry.text],
  }));
}

/**
 * Builds the clean base's `CoreScene` from the frozen brief and validated
 * narrative copy.
 *
 * Deterministic and total: the same brief and the same copy always produce the
 * identical value, and two briefs that differ only in their prose produce cores
 * that differ only in their prose. It makes no judgement — assembly and the
 * Phase 1 validator decide whether the result is acceptable, exactly as before,
 * and this function is not a second validator.
 */
export function baseCoreFromCopy(brief: Brief, copy: BaseNarrativeCopy): CoreScene {
  const world = worldFromBrief(brief);
  return {
    variables: baseVariables(),
    actions: baseActions(copy, world),
    dialogue: baseDialogue(copy, world),
    endings: baseEndings(copy),
  };
}
