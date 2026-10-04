import { describe, expect, it } from "vitest";

import { SECOND_COPY_BASE, SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import { ModelError } from "../../src/server/model/openai";
import {
  BASE_SCHEMA_NAME,
  MODULE_SCHEMA_NAME,
  openAiCompiler,
} from "../../src/server/compile/compiler";
import { runBaseStage, runModuleStage, repairNote } from "../../src/server/compile/stages";
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
