import { describe, expect, it } from "vitest";

import { SECOND_COPY_BASE, SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import type { Brief } from "../../src/domain/brief";
import {
  BASE_NARRATIVE_COPY_FIELDS,
  BaseNarrativeCopySchema,
} from "../../src/domain/compile";
import {
  ANALYSIS,
  BUDGET,
  FIXED_PORTS,
  REQUIRED_CORE_ACTIONS,
  REQUIRED_ENDING_IDS,
  TERMINAL_ENDING_BY_ACTION,
} from "../../src/domain/limits";
import { hashCanonical } from "../../src/engine/hash";
import {
  BASE_ACTION_IDS,
  BASE_AVAILABILITY,
  BASE_DIALOGUE_IDS,
  BASE_VARIABLE_IDS,
  baseCoreFromCopy,
} from "../../src/server/compile/base";
import { assembleScene, worldFromBrief } from "../../src/server/compile/assemble";
import {
  buildBaseCompilationPayload,
  payloadHash,
} from "../../src/server/compile/payloads";
import { freezeCompilation } from "../../src/server/compile/controller";
import { verifyBase } from "../../src/server/compile/verify";
import { runBaseStage } from "../../src/server/compile/stages";
import { fakeCompiler } from "./support/fake-compiler";
import { approvedProject } from "./support/phase4-harness";
import {
  COMMITMENT_APPROVAL,
  COMMITMENT_APPROVAL_PAYLOAD,
  DISCOVERY_APPROVAL,
  DISCOVERY_APPROVAL_PAYLOAD,
  FORBIDDEN_PHRASE,
  forbiddenWordingBaseCopy,
  nonPlainTextBaseCopy,
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./support/compile-fixtures";

/**
 * The clean base's mechanics belong to the server.
 *
 * This file is the Phase 4 recovery amendment's regression suite, and it is
 * deliberately written against the **assembled structure** rather than against
 * instruction wording. The architecture it replaced was prescribed in prose and
 * checked by asserting that the prose said the right thing; five such commits
 * are in this branch's history, and the live runs in `docs/PHASE4_EVIDENCE.md`
 * show the model failing a different part of that prose each time. Prose the
 * model may ignore is not a mechanism. A field it cannot reach is.
 *
 * Three groups of claim, in order:
 *
 *   1. The skeleton is fixed, and it is the same state machine the
 *      hand-authored Phase 1 fixture already proves.
 *   2. The brief moves the world and the writing and moves nothing mechanical.
 *   3. Every live base failure class is now unrepresentable, not merely
 *      rejected — and the Phase 1 validator still decides the result.
 */

const INPUT_HASH = "d".repeat(48);

function core(brief: Brief = SECOND_COPY_BRIEF, copy = validBaseCopy()) {
  return baseCoreFromCopy(brief, copy);
}

function assemble(brief: Brief = SECOND_COPY_BRIEF, copy = validBaseCopy()) {
  return assembleScene({
    brief,
    inputHash: INPUT_HASH,
    core: baseCoreFromCopy(brief, copy),
    generatedTitle: copy.title,
    modules: [],
    approvals: [],
  });
}

/** The same brief with a completely different world, role, character, and object. */
const OTHER_BRIEF: Brief = {
  ...SECOND_COPY_BRIEF,
  title: "The Loaned Key",
  premise:
    "In the back office of a closing workshop, Tomas asks for the key you were asked to hold for him. You are the night mechanic. Decide what to ask, whether to promise its return, and whether to hand it back, retain it, or leave.",
  player_role: "Night mechanic",
  room: {
    id: "workshop",
    name: "Back office",
    description: "The workshop is shutting for the night. One key is still unreturned.",
  },
  character: { id: "tomas", name: "Tomas", role: "Owner asking for his key" },
  object: { id: "key", name: "Brass key", description: "A single key on a worn fob." },
  tone: "wry",
};

/** Copy with a different voice throughout, so only the writing differs. */
function otherCopy() {
  return {
    title: "The Loaned Key",
    inspect_label: "Turn the key over",
    ask_context_label: "Ask what he needs it for",
    ask_terms_label: "Promise to hand it back",
    give_label: "Hand back the key",
    withhold_label: "Hold on to the key",
    leave_label: "Lock up and go",
    inspect_dialogue: "The fob is worn almost smooth. Tomas is watching the bench, not you.",
    context_dialogue: "I left it with you so I would not lose it. That was the whole arrangement.",
    commitment_dialogue: "Fine. It is yours, and I will not pretend otherwise.",
    give_ending_title: "Handed back",
    give_ending_text: "Tomas pockets the key and the workshop is his problem again.",
    keep_ending_title: "Kept",
    keep_ending_text: "You keep the key, and the arrangement you agreed to is over.",
    leave_ending_title: "Left open",
    leave_ending_text: "You lock the door behind you with the key still in your pocket.",
  };
}

/* ------------------------------------------------- 1. the fixed skeleton */

describe("the deterministic base skeleton", () => {
  it("is identical for the same brief, every time", () => {
    expect(hashCanonical(core())).toBe(hashCanonical(core()));
    expect(core()).toEqual(core());
  });

  it("fixes the action ids and verbs from the validator's own required table", () => {
    expect(core().actions.map((action) => action.id)).toEqual([...BASE_ACTION_IDS]);
    expect(Object.keys(REQUIRED_CORE_ACTIONS)).toEqual([...BASE_ACTION_IDS]);
    for (const action of core().actions) {
      expect(action.verb, action.id).toBe(
        REQUIRED_CORE_ACTIONS[action.id as keyof typeof REQUIRED_CORE_ACTIONS],
      );
    }
  });

  it("fixes the three variable ids, their initial value, and their visibility", () => {
    expect(core().variables).toEqual([
      { id: "core.inspected", label: expect.any(String), initial: false, visible: false },
      { id: "core.context", label: expect.any(String), initial: false, visible: false },
      { id: "core.promised", label: expect.any(String), initial: false, visible: false },
    ]);
    expect(Object.values(BASE_VARIABLE_IDS)).toEqual([
      "core.inspected",
      "core.context",
      "core.promised",
    ]);
  });

  it("fixes the three ending ids and their bindings", () => {
    expect(core().endings.map((ending) => ending.id)).toEqual([...REQUIRED_ENDING_IDS]);
    for (const [actionId, endingId] of Object.entries(TERMINAL_ENDING_BY_ACTION)) {
      const action = core().actions.find((entry) => entry.id === actionId);
      expect(action?.branches[0]?.ending_id, actionId).toBe(endingId);
    }
    // No other action names an ending.
    for (const action of core().actions) {
      if (Object.hasOwn(TERMINAL_ENDING_BY_ACTION, action.id)) continue;
      expect(action.branches[0]?.ending_id, action.id).toBeNull();
    }
  });

  it("derives every target from the verb and the frozen world", () => {
    for (const brief of [SECOND_COPY_BRIEF, OTHER_BRIEF]) {
      for (const action of core(brief).actions) {
        const expected =
          action.verb === "ask"
            ? { kind: "character", id: brief.character.id }
            : action.verb === "leave"
              ? { kind: "room", id: brief.room.id }
              : { kind: "object", id: brief.object.id };
        expect(action.target, `${brief.room.id}/${action.id}`).toEqual(expected);
      }
    }
  });

  it("fixes every availability condition", () => {
    for (const action of core().actions) {
      expect(action.when, action.id).toEqual(
        BASE_AVAILABILITY[action.id as keyof typeof BASE_AVAILABILITY],
      );
      // A required action is never disabled: the degenerate repair a live
      // attempt reached for is not a value any code path here can produce.
      expect(JSON.stringify(action.when), action.id).not.toContain('"never"');
    }
  });

  it("gives every action exactly one always-applicable branch", () => {
    for (const action of core().actions) {
      expect(action.branches, action.id).toHaveLength(1);
      expect(action.branches[0]?.when, action.id).toEqual({ kind: "always" });
      expect(action.branches.length).toBeLessThanOrEqual(BUDGET.branches_per_action);
    }
  });

  it("fixes every effect, and writes set_true itself", () => {
    const effects = core().actions.flatMap((action) =>
      action.branches.flatMap((branch) => branch.effects),
    );
    expect(effects).toEqual([
      { op: "set_true", var_id: "core.inspected" },
      { op: "set_true", var_id: "core.context" },
      { op: "set_true", var_id: "core.promised" },
    ]);
  });

  it("fixes the three dialogue node ids and their speakers", () => {
    expect(core().dialogue.map((node) => node.id)).toEqual([
      BASE_DIALOGUE_IDS.inspect,
      BASE_DIALOGUE_IDS.context,
      BASE_DIALOGUE_IDS.commitment,
    ]);
    expect(core().dialogue.map((node) => node.speaker_id)).toEqual([
      "narrator",
      SECOND_COPY_BRIEF.character.id,
      "player",
    ]);
    // The speaker follows the brief's character, never the copy.
    expect(core(OTHER_BRIEF, otherCopy()).dialogue[1]?.speaker_id).toBe(
      OTHER_BRIEF.character.id,
    );
  });

  it("writes the fixed port table, whatever the copy says", () => {
    const result = assemble();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ports.discovery).toEqual({
      gate_action_ids: [...FIXED_PORTS.discovery.gate_action_ids],
      effect_action_ids: [...FIXED_PORTS.discovery.effect_action_ids],
    });
    expect(result.scene.ports.commitment).toEqual({
      gate_action_ids: [...FIXED_PORTS.commitment.gate_action_ids],
      effect_action_ids: [...FIXED_PORTS.commitment.effect_action_ids],
    });
    // And every port names an action the skeleton really declares.
    const ids = new Set(result.scene.core.actions.map((action) => action.id));
    for (const port of Object.values(FIXED_PORTS)) {
      for (const id of [...port.gate_action_ids, ...port.effect_action_ids]) {
        expect(ids.has(id), `port names ${id}`).toBe(true);
      }
    }
  });

  /**
   * The skeleton is not a new state machine.
   *
   * `fixtures/second_copy.base.json` is the hand-authored Phase 1 artifact that
   * `npm run check:fixtures` validates and that Phase 1's own evidence rests
   * on. Rebuilding it from its own writing has to produce it back, or the
   * amendment changed the product's semantics rather than only its authorship.
   *
   * The three variable *labels* are the one permitted difference, and they are
   * `visible: false`, so no creator and no player ever reads one: the fixture
   * named them after its own letter, and the server names them generically
   * because it has no brief-specific wording to use and no reader to show them
   * to.
   */
  it("reproduces the authoritative Phase 1 base fixture, label for label", () => {
    const rebuilt = baseCoreFromCopy(SECOND_COPY_BRIEF, validBaseCopy());
    const stripLabels = (value: typeof rebuilt) => ({
      ...value,
      variables: value.variables.map(({ label: _label, ...rest }) => rest),
    });
    expect(stripLabels(rebuilt)).toEqual(stripLabels(SECOND_COPY_BASE.core));
    // Everything a player reads is identical, because it came from the fixture.
    expect(rebuilt.actions.map((action) => action.label)).toEqual(
      SECOND_COPY_BASE.core.actions.map((action) => action.label),
    );
    expect(rebuilt.dialogue).toEqual(SECOND_COPY_BASE.core.dialogue);
    expect(rebuilt.endings).toEqual(SECOND_COPY_BASE.core.endings);
  });

  it("stays inside every core budget", () => {
    const value = core();
    expect(value.variables.length).toBeLessThanOrEqual(BUDGET.core_variables);
    expect(value.actions.length).toBeLessThanOrEqual(BUDGET.core_actions);
    expect(value.dialogue.length).toBeLessThanOrEqual(BUDGET.core_dialogue);
    expect(value.endings).toHaveLength(BUDGET.endings);
  });
});

/* --------------------------------------------- 2. what the brief changes */

describe("a different brief changes the world and the writing, not the mechanics", () => {
  it("keeps every mechanical element structurally identical", () => {
    const a = core(SECOND_COPY_BRIEF, validBaseCopy());
    const b = core(OTHER_BRIEF, otherCopy());

    expect(b.actions.map((action) => action.id)).toEqual(a.actions.map((action) => action.id));
    expect(b.actions.map((action) => action.verb)).toEqual(
      a.actions.map((action) => action.verb),
    );
    expect(b.actions.map((action) => action.when)).toEqual(
      a.actions.map((action) => action.when),
    );
    expect(b.actions.map((action) => action.branches.map((branch) => branch.when))).toEqual(
      a.actions.map((action) => action.branches.map((branch) => branch.when)),
    );
    expect(b.actions.map((action) => action.branches.map((branch) => branch.effects))).toEqual(
      a.actions.map((action) => action.branches.map((branch) => branch.effects)),
    );
    expect(
      b.actions.map((action) => action.branches.map((branch) => branch.ending_id)),
    ).toEqual(a.actions.map((action) => action.branches.map((branch) => branch.ending_id)));
    expect(b.variables.map((variable) => variable.id)).toEqual(
      a.variables.map((variable) => variable.id),
    );
    expect(b.variables.map((variable) => variable.label)).toEqual(
      a.variables.map((variable) => variable.label),
    );
    expect(b.dialogue.map((node) => node.id)).toEqual(a.dialogue.map((node) => node.id));
    expect(b.endings.map((ending) => ending.id)).toEqual(a.endings.map((ending) => ending.id));
  });

  it("changes the targets, the speaker, and every string the player reads", () => {
    const b = core(OTHER_BRIEF, otherCopy());
    expect(b.actions[0]?.target).toEqual({ kind: "object", id: "key" });
    expect(b.dialogue[1]?.speaker_id).toBe("tomas");
    expect(b.actions.map((action) => action.label)).toEqual([
      "Turn the key over",
      "Ask what he needs it for",
      "Promise to hand it back",
      "Hand back the key",
      "Hold on to the key",
      "Lock up and go",
    ]);
  });

  it("validates for the other brief too, through the same unchanged validator", () => {
    const result = assemble(OTHER_BRIEF, otherCopy());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdict = verifyBase(result.scene, OTHER_BRIEF);
    expect(verdict.ok, verdict.errors.map((error) => error.code).join(",")).toBe(true);
    expect(verdict.report.graph?.reachable_endings).toEqual([
      "end.give",
      "end.keep",
      "end.leave",
    ]);
  });

  /**
   * The ownership model for the base input hash, stated as a hash test.
   *
   * The base is keyed to the frozen brief and to nothing else, so an approval
   * cannot regenerate it and a brief change must. The copy is *not* in the key:
   * it is the stage's output, not its input.
   */
  it("keys the base input to the brief alone", () => {
    const base = payloadHash(buildBaseCompilationPayload(SECOND_COPY_BRIEF));
    expect(payloadHash(buildBaseCompilationPayload(SECOND_COPY_BRIEF))).toBe(base);
    expect(payloadHash(buildBaseCompilationPayload(OTHER_BRIEF))).not.toBe(base);
    // A brief that differs only in its room description is a different base.
    expect(
      payloadHash(
        buildBaseCompilationPayload({
          ...SECOND_COPY_BRIEF,
          room: { ...SECOND_COPY_BRIEF.room, description: "The station is already dark." },
        }),
      ),
    ).not.toBe(base);
  });

  it("does not move the base input hash when the approvals change", async () => {
    const compiler = fakeCompiler({
      base: [{ output: validBaseCopy() }],
      module: [{ output: validDiscoveryOutput() }, { output: validCommitmentOutput() }],
    });
    const state = await approvedProject(["discovery", "commitment"], compiler);
    const project = state.h.gateway.projects.get(state.projectId);
    expect(project).toBeDefined();
    if (project === undefined) return;

    const frozen = (slots: readonly ("discovery" | "commitment")[]) => {
      const approvals = slots.map((slot) =>
        slot === "discovery" ? DISCOVERY_APPROVAL : COMMITMENT_APPROVAL,
      );
      const payloads = new Map(
        slots.map((slot) => [
          slot,
          slot === "discovery" ? DISCOVERY_APPROVAL_PAYLOAD : COMMITMENT_APPROVAL_PAYLOAD,
        ]),
      );
      return freezeCompilation({
        project,
        brief: SECOND_COPY_BRIEF,
        approvals,
        approvalPayloads: payloads,
        baseHash: null,
        now: new Date("2026-10-04T12:00:00.000Z"),
      });
    };

    // The brief-only key is the same whichever approvals are frozen, which is
    // the mechanism behind "changing approvals must not regenerate the base".
    const one = frozen(["discovery"]);
    const two = frozen(["discovery", "commitment"]);
    expect(one.baseInputHash).toBe(two.baseInputHash);
    expect(one.baseInputHash).toBe(
      payloadHash(buildBaseCompilationPayload(SECOND_COPY_BRIEF)),
    );
    // The *module* keys do move with the approvals, which is why only the
    // affected slot recompiles.
    expect(two.moduleInputHashes.commitment).toBeDefined();
    expect(one.moduleInputHashes.commitment).toBeUndefined();
    expect(one.moduleInputHashes.discovery).toBe(two.moduleInputHashes.discovery);
    // And the whole compilation key moves, so the composed version is fresh.
    expect(one.inputHash).not.toBe(two.inputHash);
  });

  it("does not put an approval, an artist, or any evidence in the base payload", () => {
    const bytes = JSON.stringify(buildBaseCompilationPayload(SECOND_COPY_BRIEF));
    for (const forbidden of [
      DISCOVERY_APPROVAL.approval_id,
      DISCOVERY_APPROVAL.approved_text,
      DISCOVERY_APPROVAL.reference_name,
      COMMITMENT_APPROVAL.approval_id,
      COMMITMENT_APPROVAL.approved_text,
      DISCOVERY_APPROVAL_PAYLOAD.evidence[0]!.text,
    ]) {
      expect(bytes, `the base payload carried ${forbidden}`).not.toContain(forbidden);
    }
    // And no executable mechanics: the payload is the brief, not a skeleton.
    for (const mechanic of ["core.", "end.", "set_true", "var_id", "branches", "when"]) {
      expect(bytes, `the base payload carried ${mechanic}`).not.toContain(mechanic);
    }
  });
});

/* ------------------------------- 3. the live failure classes, by construction */

describe("the base contract can no longer carry a mechanic", () => {
  it("declares sixteen plain string fields and nothing else", () => {
    expect(BASE_NARRATIVE_COPY_FIELDS).toEqual([
      "title",
      "inspect_label",
      "ask_context_label",
      "ask_terms_label",
      "give_label",
      "withhold_label",
      "leave_label",
      "inspect_dialogue",
      "context_dialogue",
      "commitment_dialogue",
      "give_ending_title",
      "give_ending_text",
      "keep_ending_title",
      "keep_ending_text",
      "leave_ending_title",
      "leave_ending_text",
    ]);
    for (const value of Object.values(validBaseCopy())) {
      expect(typeof value).toBe("string");
    }
  });

  /**
   * Each entry is a field the first architecture let the model control and a
   * live run then got wrong. The contract has no such field, so the attempt is
   * rejected at the boundary rather than by the validator.
   */
  it("rejects every mechanical field a live failure came from", () => {
    const mechanics: readonly [string, unknown][] = [
      ["variables", [{ id: "core.inspected", label: "x", visible: false }]],
      ["actions", [{ id: "core.inspect", verb: "inspect", label: "x" }]],
      ["endings", [{ id: "end.give", title: "x", text: "y" }]],
      ["dialogue", [{ id: "core.inspect_text", speaker_id: "narrator", text: "x" }]],
      ["when", { kind: "never" }],
      ["branches", [{ when: { kind: "always" }, effects: [] }]],
      ["effects", [{ var_id: "core.inspected" }]],
      ["ending_id", "end.give"],
      ["dialogue_id", "core.inspect_text"],
      ["ports", { discovery: { gate_action_ids: ["core.give"] } }],
      ["inspect_id", "core.inspect"],
      ["give_ending_id", "end.give"],
    ];
    for (const [field, value] of mechanics) {
      const parsed = BaseNarrativeCopySchema.safeParse({ ...validBaseCopy(), [field]: value });
      expect(parsed.success, `the base contract accepted a "${field}" field`).toBe(false);
    }
  });

  it("rejects an extra action's or an extra ending's copy", () => {
    for (const extra of ["second_ask_label", "fourth_ending_title", "fourth_ending_text"]) {
      const parsed = BaseNarrativeCopySchema.safeParse({ ...validBaseCopy(), [extra]: "x" });
      expect(parsed.success, extra).toBe(false);
    }
  });

  it("rejects a missing or empty copy field", () => {
    for (const field of BASE_NARRATIVE_COPY_FIELDS) {
      const without = { ...validBaseCopy() };
      delete (without as Record<string, unknown>)[field];
      expect(BaseNarrativeCopySchema.safeParse(without).success, `missing ${field}`).toBe(false);
      expect(
        BaseNarrativeCopySchema.safeParse({ ...validBaseCopy(), [field]: "" }).success,
        `empty ${field}`,
      ).toBe(false);
    }
  });

  /**
   * The seven live base failures of `docs/PHASE4_EVIDENCE.md` §6, each checked
   * against the assembled value rather than against an instruction.
   *
   * Every one of them was a property of the mechanics. The server now owns the
   * mechanics, so each is a property of this application's own code, provable
   * once rather than hoped for on every attempt.
   */
  it("makes each live failure class impossible by construction", () => {
    const result = assemble();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.scene;
    const value = scene.core;

    // NAMESPACE_INVALID: every declared id of all three kinds is in core.
    for (const id of [
      ...value.variables.map((variable) => variable.id),
      ...value.actions.map((action) => action.id),
      ...value.dialogue.map((node) => node.id),
    ]) {
      expect(id, "every core id is namespaced").toMatch(/^core\./u);
    }
    // And an ending id is never any of those three kinds.
    for (const endingId of REQUIRED_ENDING_IDS) {
      expect(value.dialogue.some((node) => node.id === endingId)).toBe(false);
      expect(value.actions.some((action) => action.id === endingId)).toBe(false);
      expect(value.variables.some((variable) => variable.id === endingId)).toBe(false);
    }

    // VARIABLE_NEVER_READ / VARIABLE_NEVER_WRITTEN: both, for all three.
    const conditions = JSON.stringify(value.actions.map((action) => action.when));
    const written = new Set(
      value.actions.flatMap((action) =>
        action.branches.flatMap((branch) => branch.effects.map((effect) => effect.var_id)),
      ),
    );
    for (const variable of value.variables) {
      expect(conditions, `${variable.id} is read`).toContain(variable.id);
      expect(written.has(variable.id), `${variable.id} is written`).toBe(true);
    }

    // A required action disabled by {kind: never}.
    for (const action of value.actions) {
      expect(action.when.kind, action.id).not.toBe("never");
    }

    // AMBIGUOUS_BRANCH: one branch per action cannot overlap with a second.
    for (const action of value.actions) expect(action.branches, action.id).toHaveLength(1);

    // NO_PROGRESS: every nonterminal action writes a variable that was false.
    for (const action of value.actions) {
      const terminal = action.branches[0]?.ending_id !== null;
      if (terminal) continue;
      expect(action.branches[0]?.effects.length, `${action.id} progresses`).toBeGreaterThan(0);
    }

    // And the graph layer agrees, from the real engine.
    const verdict = verifyBase(scene, SECOND_COPY_BRIEF);
    expect(verdict.ok, verdict.errors.map((error) => error.code).join(",")).toBe(true);
    expect(verdict.report.graph?.reachable_endings).toEqual([
      "end.give",
      "end.keep",
      "end.leave",
    ]);
    expect(verdict.report.findings).toEqual([]);
  });

  it("keeps every ending at least three actions away", () => {
    const result = assemble();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // core.inspect, core.ask_context, then an ending: the engine's own bound.
    expect(ANALYSIS.min_actions_to_ending).toBe(3);
    const verdict = verifyBase(result.scene, SECOND_COPY_BRIEF);
    expect(
      verdict.errors.map((error) => error.code),
      "no ending is reachable too early",
    ).not.toContain("ENDING_TOO_EARLY");
  });
});

/* --------------------------------------------------- assembly and the gate */

describe("assembled base copy still answers to the real validator", () => {
  it("maps each copy field onto its authoritative mechanical slot", () => {
    const copy = validBaseCopy();
    const value = core(SECOND_COPY_BRIEF, copy);
    expect(value.actions.find((action) => action.id === "core.inspect")?.label).toBe(
      copy.inspect_label,
    );
    expect(value.actions.find((action) => action.id === "core.ask_context")?.label).toBe(
      copy.ask_context_label,
    );
    expect(value.actions.find((action) => action.id === "core.ask_terms")?.label).toBe(
      copy.ask_terms_label,
    );
    expect(value.actions.find((action) => action.id === "core.give")?.label).toBe(copy.give_label);
    expect(value.actions.find((action) => action.id === "core.withhold")?.label).toBe(
      copy.withhold_label,
    );
    expect(value.actions.find((action) => action.id === "core.leave")?.label).toBe(
      copy.leave_label,
    );
    expect(value.dialogue.find((node) => node.id === BASE_DIALOGUE_IDS.inspect)?.text).toBe(
      copy.inspect_dialogue,
    );
    expect(value.dialogue.find((node) => node.id === BASE_DIALOGUE_IDS.context)?.text).toBe(
      copy.context_dialogue,
    );
    expect(value.dialogue.find((node) => node.id === BASE_DIALOGUE_IDS.commitment)?.text).toBe(
      copy.commitment_dialogue,
    );
    expect(value.endings.find((ending) => ending.id === "end.give")).toEqual({
      id: "end.give",
      title: copy.give_ending_title,
      text: copy.give_ending_text,
    });
    expect(value.endings.find((ending) => ending.id === "end.keep")).toEqual({
      id: "end.keep",
      title: copy.keep_ending_title,
      text: copy.keep_ending_text,
    });
    expect(value.endings.find((ending) => ending.id === "end.leave")).toEqual({
      id: "end.leave",
      title: copy.leave_ending_title,
      text: copy.leave_ending_text,
    });
  });

  it("passes the real Phase 1 validator, with nothing special-cased", () => {
    const result = assemble();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdict = verifyBase(result.scene, SECOND_COPY_BRIEF);
    expect(verdict.ok).toBe(true);
    expect(verdict.resourceLimited).toBe(false);
    // The brief's own world, unchanged by anything the model wrote.
    expect(result.scene.world).toEqual(worldFromBrief(SECOND_COPY_BRIEF));
  });

  it("rejects copy with a control character, through the scene contract", () => {
    const result = assemble(SECOND_COPY_BRIEF, nonPlainTextBaseCopy());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]!.code).toBe("SCHEMA_INVALID");
  });

  it("rejects copy that uses a phrase the brief forbids", () => {
    const brief: Brief = { ...SECOND_COPY_BRIEF, forbidden_wording: [FORBIDDEN_PHRASE] };
    const result = assemble(brief, forbiddenWordingBaseCopy());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdict = verifyBase(result.scene, brief);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("FORBIDDEN_WORDING");
  });

  it("gives a copy repair the findings and no mechanic", async () => {
    const brief: Brief = { ...SECOND_COPY_BRIEF, forbidden_wording: [FORBIDDEN_PHRASE] };
    const compiler = fakeCompiler({
      base: [{ output: forbiddenWordingBaseCopy() }, { output: validBaseCopy() }],
    });

    const rejected = await runBaseStage(
      { brief, inputHash: INPUT_HASH, repair: null },
      compiler,
    );
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") return;
    expect(rejected.errors.map((error) => error.code)).toContain("FORBIDDEN_WORDING");

    // The one permitted repair, shown its own copy and its own findings.
    const repaired = await runBaseStage(
      {
        brief,
        inputHash: INPUT_HASH,
        repair: { candidate: rejected.candidate, errors: rejected.errors },
      },
      compiler,
    );
    expect(repaired.kind).toBe("committed");
    expect(compiler.calls()).toBe(2);

    const payload = compiler.requests[1]!.payload as {
      stage: string;
      rejected_output: Record<string, unknown>;
      findings: { code: string }[];
    };
    expect(payload.stage).toBe("repair");
    // The rejected candidate is copy, field for field. No mechanic to change.
    expect(Object.keys(payload.rejected_output).sort()).toEqual(
      [...BASE_NARRATIVE_COPY_FIELDS].sort(),
    );
    expect(payload.findings.map((finding) => finding.code)).toContain("FORBIDDEN_WORDING");
  });
});
