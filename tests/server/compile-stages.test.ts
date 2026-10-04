import { describe, expect, it } from "vitest";

import { SECOND_COPY_BASE, SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import { ModelError } from "../../src/server/model/openai";
import {
  BASE_SCHEMA_NAME,
  MODULE_SCHEMA_NAME,
  openAiCompiler,
} from "../../src/server/compile/compiler";
import { runBaseStage, runModuleStage, repairNote } from "../../src/server/compile/stages";
import {
  BASE_INSTRUCTIONS,
  moduleInstructions,
} from "../../src/server/compile/instructions";
import { scriptedModel } from "./support/phase3-harness";
import {
  fakeCompiler,
  malformedOutput,
  providerRefusal,
  providerTransportFailure,
  providerTruncation,
} from "./support/fake-compiler";
import {
  COMMITMENT_APPROVAL,
  COMMITMENT_APPROVAL_PAYLOAD,
  DISCOVERY_APPROVAL,
  DISCOVERY_APPROVAL_PAYLOAD,
  SENTINELS,
  SENTINELS_FORBIDDEN_IN_COMMITMENT,
  SENTINELS_FORBIDDEN_IN_DISCOVERY,
  badNamespaceBaseOutput,
  crossSlotModuleOutput,
  mechanicallyEmptyModuleOutput,
  missingCoreActionBaseOutput,
  validBaseOutput,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./support/compile-fixtures";

/**
 * One stage, one provider attempt.
 *
 * Every test here calls a stage function exactly once and asserts that exactly
 * one provider call happened. The repair is a *second* stage call made by the
 * controller, which is covered in `compile-controller.test.ts` where the
 * database's own attempt ceiling is in play.
 */

const INPUT_HASH = "c".repeat(48);

function baseInput(repair: Parameters<typeof runBaseStage>[0]["repair"] = null) {
  return { brief: SECOND_COPY_BRIEF, inputHash: INPUT_HASH, repair };
}

function moduleInput(
  slot: "discovery" | "commitment",
  repair: Parameters<typeof runModuleStage>[0]["repair"] = null,
) {
  const approval = slot === "discovery" ? DISCOVERY_APPROVAL : COMMITMENT_APPROVAL;
  const approvalPayload =
    slot === "discovery" ? DISCOVERY_APPROVAL_PAYLOAD : COMMITMENT_APPROVAL_PAYLOAD;
  return {
    brief: SECOND_COPY_BRIEF,
    inputHash: INPUT_HASH,
    core: SECOND_COPY_BASE.core,
    baseTitle: SECOND_COPY_BASE.title,
    slot,
    approval,
    approvalPayload,
    repair,
  };
}

describe("the base stage", () => {
  it("commits a valid foundation in one provider call", async () => {
    const compiler = fakeCompiler({ base: [{ output: validBaseOutput() }] });
    const outcome = await runBaseStage(baseInput(), compiler);
    expect(compiler.calls()).toBe(1);
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.artifact.core.actions.map((action) => action.id)).toContain("core.give");
    expect(outcome.hash).toHaveLength(64);
    expect(outcome.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("sends the brief-only payload and nothing else", async () => {
    const compiler = fakeCompiler({ base: [{ output: validBaseOutput() }] });
    await runBaseStage(
      { ...baseInput(), brief: { ...SECOND_COPY_BRIEF, cultural_anchor_query: SENTINELS.artist } },
      compiler,
    );
    const request = compiler.requests[0]!;
    expect(request.schemaName).toBe(BASE_SCHEMA_NAME);
    const bytes = JSON.stringify(request);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(bytes, `base stage leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("rejects a candidate the real validator refuses, keeping it for one repair", async () => {
    const compiler = fakeCompiler({ base: [{ output: missingCoreActionBaseOutput() }] });
    const outcome = await runBaseStage(baseInput(), compiler);
    expect(compiler.calls()).toBe(1);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors.map((error) => error.code)).toContain("CORE_ACTION_MISSING");
    expect(outcome.candidate).toEqual(missingCoreActionBaseOutput());
    // Still one call: a stage never repairs itself.
    expect(compiler.calls()).toBe(1);
  });

  it("rejects output the authoritative contract itself refuses", async () => {
    const compiler = fakeCompiler({ base: [malformedOutput()] });
    await expect(runBaseStage(baseInput(), compiler)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelError && error.code === "MODEL_INVALID_OUTPUT",
    );
    expect(compiler.calls()).toBe(1);
  });

  it("lets a provider refusal, truncation, and transport failure through as one spent attempt", async () => {
    for (const failure of [providerRefusal(), providerTruncation(), providerTransportFailure()]) {
      const compiler = fakeCompiler({ base: [failure] });
      await expect(runBaseStage(baseInput(), compiler)).rejects.toBeInstanceOf(ModelError);
      expect(compiler.calls()).toBe(1);
    }
  });

  it("shows a repair the same brief-only context plus its own failure", async () => {
    const rejected = badNamespaceBaseOutput();
    const compiler = fakeCompiler({ base: [{ output: validBaseOutput() }] });
    const outcome = await runBaseStage(
      baseInput({
        candidate: rejected,
        errors: [{ code: "NAMESPACE_INVALID", detail: 'core variable id "rogue.inspected"' }],
      }),
      compiler,
    );
    expect(outcome.kind).toBe("committed");
    expect(compiler.calls()).toBe(1);

    const request = compiler.requests[0]!;
    const payload = request.payload as { stage: string; context: unknown; rejected_output: unknown };
    expect(payload.stage).toBe("repair");
    expect(payload.rejected_output).toEqual(rejected);
    // The context is the same brief-only payload, not a widened one.
    expect(payload.context).toEqual({
      stage: "base",
      brief: expect.objectContaining({ premise: SECOND_COPY_BRIEF.premise }),
    });
    expect(request.instructions).toContain("NAMESPACE_INVALID");
  });
});

describe("the module stage", () => {
  it("commits a valid Discovery module in one provider call", async () => {
    const compiler = fakeCompiler({ module: [{ output: validDiscoveryOutput() }] });
    const outcome = await runModuleStage(moduleInput("discovery"), compiler);
    expect(compiler.calls()).toBe(1);
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.artifact.module.slot).toBe("discovery");
    expect(outcome.artifact.scene.modules).toHaveLength(1);
  });

  it("commits a valid Commitment module in one provider call", async () => {
    const compiler = fakeCompiler({ module: [{ output: validCommitmentOutput() }] });
    const outcome = await runModuleStage(moduleInput("commitment"), compiler);
    expect(outcome.kind).toBe("committed");
    expect(compiler.calls()).toBe(1);
  });

  it("sends each slot only its own approval and its own port", async () => {
    const discovery = fakeCompiler({ module: [{ output: validDiscoveryOutput() }] });
    await runModuleStage(moduleInput("discovery"), discovery);
    const discoveryBytes = JSON.stringify(discovery.requests[0]);
    expect(discovery.requests[0]!.schemaName).toBe(MODULE_SCHEMA_NAME);
    for (const sentinel of SENTINELS_FORBIDDEN_IN_DISCOVERY) {
      expect(discoveryBytes, `discovery stage leaked ${sentinel}`).not.toContain(sentinel);
    }

    const commitment = fakeCompiler({ module: [{ output: validCommitmentOutput() }] });
    await runModuleStage(moduleInput("commitment"), commitment);
    const commitmentBytes = JSON.stringify(commitment.requests[0]);
    for (const sentinel of SENTINELS_FORBIDDEN_IN_COMMITMENT) {
      expect(commitmentBytes, `commitment stage leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("rejects a mechanically empty module, which is the point of the witness", async () => {
    const compiler = fakeCompiler({ module: [{ output: mechanicallyEmptyModuleOutput() }] });
    const outcome = await runModuleStage(moduleInput("commitment"), compiler);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.errors.map((error) => error.code)).toContain("MODULE_WITNESS_MISSING");
  });

  it("rejects a cross-slot read and keeps the finding free of the other approval", async () => {
    const compiler = fakeCompiler({ module: [{ output: crossSlotModuleOutput() }] });
    const outcome = await runModuleStage(moduleInput("commitment"), compiler);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    const text = JSON.stringify(outcome.errors);
    expect(text).not.toContain(SENTINELS.discoveryApproval);
  });

  it("shows a module repair its own context, candidate, and findings only", async () => {
    const rejected = mechanicallyEmptyModuleOutput();
    const compiler = fakeCompiler({ module: [{ output: validCommitmentOutput() }] });
    const outcome = await runModuleStage(
      moduleInput("commitment", {
        candidate: rejected,
        errors: [
          {
            code: "MODULE_WITNESS_MISSING",
            detail: "the commitment module changes no legal action availability",
          },
        ],
      }),
      compiler,
    );
    expect(outcome.kind).toBe("committed");
    expect(compiler.calls()).toBe(1);

    const request = compiler.requests[0]!;
    const payload = request.payload as {
      stage: string;
      context: { slot: string };
      rejected_output: unknown;
      findings: { code: string }[];
    };
    expect(payload.stage).toBe("repair");
    expect(payload.context.slot).toBe("commitment");
    expect(payload.rejected_output).toEqual(rejected);
    expect(payload.findings.map((finding) => finding.code)).toEqual([
      "MODULE_WITNESS_MISSING",
    ]);
    const bytes = JSON.stringify(request);
    for (const sentinel of SENTINELS_FORBIDDEN_IN_COMMITMENT) {
      expect(bytes, `module repair leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("compiles one module independently of the other", async () => {
    // Two separate stage calls, each with its own compiler. Neither can see
    // what the other sent, because neither received it.
    const first = fakeCompiler({ module: [{ output: validDiscoveryOutput() }] });
    const second = fakeCompiler({ module: [{ output: validCommitmentOutput() }] });
    await runModuleStage(moduleInput("discovery"), first);
    await runModuleStage(moduleInput("commitment"), second);
    expect(JSON.stringify(first.requests)).not.toContain(SENTINELS.commitmentApproval);
    expect(JSON.stringify(second.requests)).not.toContain(SENTINELS.discoveryApproval);
  });
});

describe("the repair note", () => {
  it("names the findings and grants no new capability", () => {
    const note = repairNote([
      { code: "GATE_NEVER_BLOCKS", detail: 'gate "commitment.terms_gate" never blocks' },
    ]);
    expect(note).toContain("GATE_NEVER_BLOCKS");
    expect(note).toContain("commitment.terms_gate");
    expect(note.toLowerCase()).not.toContain("retrieve");
  });

  it("is bounded, so a long finding list cannot become the whole prompt", () => {
    const note = repairNote(
      Array.from({ length: 40 }, (_value, index) => ({
        code: `CODE_${index}`,
        detail: `detail ${index}`,
      })),
    );
    expect(note).toContain("CODE_0");
    expect(note).not.toContain("CODE_20");
  });
});

describe("the production compiler over a scripted transport", () => {
  it("drives the real pinned adapter, including its own checks", async () => {
    const model = scriptedModel([{ parsed: validBaseOutput() }]);
    const outcome = await runBaseStage(
      baseInput(),
      openAiCompiler({ client: model.client }),
    );
    expect(outcome.kind).toBe("committed");

    const request = model.requests[0]!;
    expect(request["model"]).toBe("gpt-4o-mini-2024-07-18");
    // No conversation handle and no stored state can cross a stage boundary.
    expect(request["store"]).toBe(false);
    expect(request).not.toHaveProperty("previous_response_id");
    expect(String(request["input"])).not.toContain(SENTINELS.artist);
  });

  it("refuses a substituted model rather than accepting the output", async () => {
    const model = scriptedModel([
      { parsed: validBaseOutput(), model: "gpt-4o-mini-2024-07-19" },
    ]);
    await expect(
      runBaseStage(baseInput(), openAiCompiler({ client: model.client })),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ModelError && error.code === "MODEL_MISMATCH",
    );
  });

  it("treats a refusal as a failed stage, never as partial output", async () => {
    const model = scriptedModel([{ refusal: "I cannot help with that." }]);
    await expect(
      runModuleStage(moduleInput("discovery"), openAiCompiler({ client: model.client })),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ModelError && error.code === "MODEL_REFUSED",
    );
  });

  it("never parses a truncated body as a scene", async () => {
    const model = scriptedModel([
      { text: '{"title":"half a bas', status: "incomplete" },
    ]);
    await expect(
      runBaseStage(baseInput(), openAiCompiler({ client: model.client })),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ModelError && error.code === "MODEL_TRUNCATED",
    );
  });
});

/**
 * What the fixed instruction blocks have to say out loud.
 *
 * A real live base compilation failed twice on the same brief because the model
 * namespaced its dialogue nodes `dialogue.*` and its variables after their
 * field names, which the Phase 1 validator correctly rejected as
 * `NAMESPACE_INVALID`. The rule was stated, but every worked example in the
 * block was an action, so the only concrete evidence the model had pointed at
 * one of the three kinds the rule covers.
 *
 * The repair path behaved exactly as designed throughout — one extra attempt,
 * the real findings, no third attempt — so the defect was the instruction's
 * worked examples, not the ceiling and not the validator. These assertions keep
 * the examples present for all three declared kinds, and keep the two rules the
 * live failure actually tripped stated in a form that names its consequence.
 */
describe("the fixed instruction blocks state the id rules with worked examples", () => {
  it("names the core namespace for variables, actions, and dialogue nodes alike", () => {
    expect(BASE_INSTRUCTIONS).toContain('"core."');
    expect(BASE_INSTRUCTIONS).toMatch(/variable, an action, or a dialogue node/);
    // A worked example for each declared kind, not only for the six actions.
    expect(BASE_INSTRUCTIONS).toMatch(/core\.inspect_line/);
    expect(BASE_INSTRUCTIONS).toMatch(/core\.inspected/);
    expect(BASE_INSTRUCTIONS).toMatch(/core\.inspect\b/);
    // And the wrong forms the live failure produced, named as wrong.
    expect(BASE_INSTRUCTIONS).toMatch(/never dialogue\.inspect_line/);
    expect(BASE_INSTRUCTIONS).toMatch(/never variable\.inspected/);
  });

  it("says what happens to a variable that is never read, and where to read it", () => {
    expect(BASE_INSTRUCTIONS).toMatch(/set by some effect and read by some condition/);
    expect(BASE_INSTRUCTIONS).toMatch(/only ever set is rejected/);
    // Both idioms the hand-authored fixture uses, named as the two places a
    // condition can read a variable.
    expect(BASE_INSTRUCTIONS).toMatch(/the action that sets it, requiring it to still be false/);
    expect(BASE_INSTRUCTIONS).toMatch(/an action it constrains/);
  });

  /**
   * The prescribed skeleton has to be the one the hand-authored fixture really
   * uses, or the block teaches the model a shape the validator will reject.
   *
   * Three live base compilations failed in a row before the skeleton was
   * prescribed: the block fixed the six action ids and verbs but left their
   * availability conditions to the model, which declared variables nothing
   * read. Because a layer A finding skips graph analysis entirely, the one
   * permitted repair never saw the downstream consequences of its own fix, and
   * on one attempt it "fixed" an unread variable by setting that action's
   * condition to {kind: never} — disabling a required action. The ceiling and
   * the validator were both right; the instruction was underspecified.
   *
   * This reads the fixture and asserts the block and the fixture agree, so the
   * two cannot drift apart.
   */
  it("prescribes the availability skeleton the valid fixture really uses", () => {
    const reads = (when: unknown, varId: string, equals: boolean): boolean =>
      JSON.stringify(when).includes(
        JSON.stringify({ var_id: varId, equals }).replace(/[{}]/gu, ""),
      ) ||
      JSON.stringify(when).includes(
        JSON.stringify({ equals, var_id: varId }).replace(/[{}]/gu, ""),
      );
    const named = (id: string) =>
      SECOND_COPY_BASE.core.actions.find((action) => action.id === id);

    // The three variables the block names are exactly the fixture's.
    expect(SECOND_COPY_BASE.core.variables.map((variable) => variable.id)).toEqual([
      "core.inspected",
      "core.context",
      "core.promised",
    ]);
    for (const id of ["core.inspected", "core.context", "core.promised"]) {
      expect(BASE_INSTRUCTIONS, id).toContain(id);
    }

    // Each prescribed availability condition, checked against the fixture.
    const expected: readonly [string, readonly [string, boolean][]][] = [
      ["core.inspect", [["core.inspected", false]]],
      ["core.ask_context", [["core.context", false]]],
      [
        "core.ask_terms",
        [
          ["core.inspected", true],
          ["core.context", true],
          ["core.promised", false],
        ],
      ],
      [
        "core.give",
        [
          ["core.inspected", true],
          ["core.context", true],
        ],
      ],
      [
        "core.withhold",
        [
          ["core.inspected", true],
          ["core.context", true],
          ["core.promised", false],
        ],
      ],
      [
        "core.leave",
        [
          ["core.inspected", true],
          ["core.context", true],
        ],
      ],
    ];
    for (const [actionId, atoms] of expected) {
      const action = named(actionId);
      expect(action, `the fixture must declare ${actionId}`).toBeDefined();
      for (const [varId, equals] of atoms) {
        expect(
          reads(action?.when, varId, equals),
          `${actionId} must require ${varId} to be ${String(equals)}`,
        ).toBe(true);
      }
    }

    // And the block forbids the degenerate repair a live attempt reached for.
    expect(BASE_INSTRUCTIONS).toMatch(/may not be\s+\{kind: never\}/);
    expect(BASE_INSTRUCTIONS).toMatch(/Never make a required action unavailable/);
  });

  /**
   * One branch per action, as the fixture has it.
   *
   * A live base attempt gave `core.inspect` two branches that both applied,
   * which the graph layer rejected as `AMBIGUOUS_BRANCH` and which cascaded
   * into every ending being unreachable. The block prescribed the availability
   * conditions but said nothing about how many branches an action should have,
   * so this states the fixture's answer and checks the two agree.
   */
  it("prescribes the single-branch shape the valid fixture uses", () => {
    expect(BASE_INSTRUCTIONS).toMatch(/Give every action exactly one branch/);
    expect(BASE_INSTRUCTIONS).toMatch(/\{kind: always\}/);

    for (const action of SECOND_COPY_BASE.core.actions) {
      expect(action.branches.length, `${action.id} branch count`).toBe(1);
      expect(action.branches[0]?.when.kind, `${action.id} branch condition`).toBe("always");
    }

    // The three ending actions, each naming its own ending on that one branch.
    const endings: Readonly<Record<string, string>> = {
      "core.give": "end.give",
      "core.withhold": "end.keep",
      "core.leave": "end.leave",
    };
    for (const [actionId, endingId] of Object.entries(endings)) {
      const action = SECOND_COPY_BASE.core.actions.find((entry) => entry.id === actionId);
      expect(action?.branches[0]?.ending_id, actionId).toBe(endingId);
      expect(BASE_INSTRUCTIONS).toContain(endingId);
    }

    /*
     * An ending id is not a dialogue id.
     *
     * The first wording of the single-branch rule said core.give "names"
     * end.give, and a live attempt read that as licence to declare dialogue
     * nodes called end.give, end.keep, and end.leave — three
     * NAMESPACE_INVALID findings caused by this block's own ambiguity. The
     * rule now says which field each id belongs in, and says where an ending
     * id may not appear.
     */
    expect(BASE_INSTRUCTIONS).toMatch(/sets ending_id to end\.give/);
    expect(BASE_INSTRUCTIONS).toMatch(/never a dialogue node id/);
    expect(BASE_INSTRUCTIONS).toMatch(/dialogue_id is either null/);
    for (const node of SECOND_COPY_BASE.core.dialogue) {
      expect(node.id, "a fixture dialogue id is never an ending id").toMatch(/^core\./u);
    }
    // And every other action's one branch names no ending.
    for (const action of SECOND_COPY_BASE.core.actions) {
      if (Object.hasOwn(endings, action.id)) continue;
      expect(action.branches[0]?.ending_id, `${action.id} must end nothing`).toBeNull();
    }
  });

  it("leaves the writing to the model even though the skeleton is fixed", () => {
    expect(BASE_INSTRUCTIONS).toMatch(/Write the title, the dialogue, and the three endings/);
    // No action in the fixture has a never-available condition.
    for (const action of SECOND_COPY_BASE.core.actions) {
      expect(JSON.stringify(action.when), action.id).not.toContain('"never"');
    }
  });

  it("still asks each module for its own slot namespace, with no example from another", () => {
    for (const slot of ["discovery", "commitment"] as const) {
      const other = slot === "discovery" ? "commitment" : "discovery";
      const block = moduleInstructions(slot);
      expect(block).toContain(`starts with "${slot}."`);
      expect(block).not.toContain(other);
    }
  });

});

/**
 * The module block has to teach the same wiring the base block does.
 *
 * A real live Discovery module declared a variable nothing set and nothing
 * read, alongside the hook-port mistake. The rule was stated; the working
 * shape was not, exactly as in the base block before it was corrected.
 */
describe("the module block shows how a module variable is wired", () => {
  it("names the set-once, read-in-the-gate shape for each slot", () => {
    for (const slot of ["discovery", "commitment"] as const) {
      const block = moduleInstructions(slot);
      expect(block, slot).toMatch(/only ever set, or only ever read, is\s+rejected/);
      expect(block, slot).toContain(`${slot}.learned`);
      expect(block, slot).toMatch(/taken once/);
      expect(block, slot).toMatch(/gated base action opens only after/);
    }
  });

  it("still names no other slot anywhere in a module block", () => {
    for (const slot of ["discovery", "commitment"] as const) {
      const other = slot === "discovery" ? "commitment" : "discovery";
      expect(moduleInstructions(slot), `${slot} must not mention ${other}`).not.toContain(other);
    }
  });

  it("tells each module that its hook port is not its to name", () => {
    expect(moduleInstructions("discovery")).toMatch(
      /a hook has no action field, and this application\s+attaches every hook you return to core\.inspect/,
    );
    expect(moduleInstructions("commitment")).toMatch(
      /a hook has no action field, and this application\s+attaches every hook you return to core\.ask_context/,
    );
  });
});
