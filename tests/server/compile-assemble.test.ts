import { describe, expect, it } from "vitest";

import {
  SECOND_COPY_BASE,
  SECOND_COPY_BRIEF,
  SECOND_COPY_DISCOVERY_V1,
} from "../../fixtures/second-copy";
import { FIXED_PORTS } from "../../src/domain/limits";
import { ModuleCompilationOutputSchema } from "../../src/domain/compile";
import {
  assembleScene,
  coreFromModelOutput,
  mechanicIdsOf,
  moduleFromModelOutput,
  sceneApprovalAllowlist,
  sceneApprovalId,
  sceneIdFor,
  sceneReferenceId,
  worldFromBrief,
} from "../../src/server/compile/assemble";
import {
  sceneWithOnlySlot,
  verifyBase,
  verifyCandidate,
  verifyModule,
} from "../../src/server/compile/verify";
import {
  COMMITMENT_APPROVAL,
  DISCOVERY_APPROVAL,
  badNamespaceBaseOutput,
  badNamespaceModuleOutput,
  coreWriteModuleOutput,
  crossSlotModuleOutput,
  fourEndingBaseOutput,
  illegalVerbBaseOutput,
  mechanicallyEmptyModuleOutput,
  missingCoreActionBaseOutput,
  terminalModuleOutput,
  validBaseOutput,
  validCommitmentOutput,
  validDiscoveryOutput,
  wrongPortModuleOutput,
} from "./support/compile-fixtures";

/**
 * Assembly assigns authority; the Phase 1 engine decides acceptability.
 *
 * Every rejection below comes from `validateScene`, `validateSceneSubsets`, or
 * `findMechanicalWitness`. Nothing here is a second validator, and nothing
 * here asks a model to judge its own output.
 */

const INPUT_HASH = "a".repeat(48);
const APPROVALS = [DISCOVERY_APPROVAL, COMMITMENT_APPROVAL];

function assemble(
  base = validBaseOutput(),
  modules: { slot: "discovery" | "commitment"; output: ReturnType<typeof validDiscoveryOutput> }[] = [],
  approvals = APPROVALS,
) {
  const world = worldFromBrief(SECOND_COPY_BRIEF);
  return assembleScene({
    brief: SECOND_COPY_BRIEF,
    inputHash: INPUT_HASH,
    core: coreFromModelOutput(base, world),
    generatedTitle: base.title,
    modules: modules.map((entry) =>
      moduleFromModelOutput(
        entry.output,
        entry.slot,
        // A module whose slot has no frozen approval still gets compiled by
        // the stage; assembly is what refuses to carry it.
        (approvals.find((approval) => approval.slot === entry.slot) ?? APPROVALS.find((approval) => approval.slot === entry.slot)!)
          .approval_id,
        world,
      ),
    ),
    approvals: approvals.filter((approval) =>
      modules.some((entry) => entry.slot === approval.slot),
    ),
  });
}

function sceneOf(result: ReturnType<typeof assemble>) {
  if (!result.ok) throw new Error(`assembly failed: ${JSON.stringify(result.findings)}`);
  return result.scene;
}

describe("the server assigns every authority", () => {
  it("builds the world from the frozen brief, not from model output", () => {
    const world = worldFromBrief(SECOND_COPY_BRIEF);
    expect(world.room).toEqual(SECOND_COPY_BRIEF.room);
    expect(world.characters).toHaveLength(1);
    expect(world.characters[0]).toEqual(SECOND_COPY_BRIEF.character);
    expect(world.object).toEqual(SECOND_COPY_BRIEF.object);
  });

  it("writes set_true itself, so no other effect operator is representable", () => {
    const core = coreFromModelOutput(validBaseOutput(), worldFromBrief(SECOND_COPY_BRIEF));
    const effects = core.actions.flatMap((action) =>
      action.branches.flatMap((branch) => branch.effects),
    );
    expect(effects.length).toBeGreaterThan(0);
    for (const effect of effects) expect(effect.op).toBe("set_true");
  });

  it("derives every action target from the verb and the frozen world", () => {
    const core = coreFromModelOutput(validBaseOutput(), worldFromBrief(SECOND_COPY_BRIEF));
    for (const action of core.actions) {
      const expected =
        action.verb === "ask"
          ? { kind: "character", id: SECOND_COPY_BRIEF.character.id }
          : action.verb === "leave"
            ? { kind: "room", id: SECOND_COPY_BRIEF.room.id }
            : { kind: "object", id: SECOND_COPY_BRIEF.object.id };
      expect(action.target).toEqual(expected);
    }
  });

  it("writes the fixed port table, which model output cannot alter", () => {
    const scene = sceneOf(assemble());
    expect(scene.ports.discovery).toEqual({
      gate_action_ids: [...FIXED_PORTS.discovery.gate_action_ids],
      effect_action_ids: [...FIXED_PORTS.discovery.effect_action_ids],
    });
    expect(scene.ports.commitment).toEqual({
      gate_action_ids: [...FIXED_PORTS.commitment.gate_action_ids],
      effect_action_ids: [...FIXED_PORTS.commitment.effect_action_ids],
    });
  });

  it("binds the slot, the approval, the source kind, and the provenance itself", () => {
    const scene = sceneOf(
      assemble(validBaseOutput(), [{ slot: "discovery", output: validDiscoveryOutput() }]),
    );
    const module = scene.modules[0]!;
    expect(module.slot).toBe("discovery");
    // The scene carries the opaque application form, never the database id.
    expect(module.approval_id).toBe(sceneApprovalId(DISCOVERY_APPROVAL.approval_id));
    expect(module.approval_id).not.toBe(DISCOVERY_APPROVAL.approval_id);
    expect(scene.influences).toEqual([
      {
        approval_id: sceneApprovalId(DISCOVERY_APPROVAL.approval_id),
        reference_id: sceneReferenceId(DISCOVERY_APPROVAL.reference_id),
        source_kind: "qloo",
        approved_text: DISCOVERY_APPROVAL.approved_text,
        intended_effect: DISCOVERY_APPROVAL.intended_effect,
      },
    ]);
    expect(scene.provenance).toEqual([
      {
        approval_id: sceneApprovalId(DISCOVERY_APPROVAL.approval_id),
        mechanic_ids: mechanicIdsOf(module),
      },
    ]);
  });

  it("drops a module whose approval is not in the frozen set", () => {
    const result = assemble(
      validBaseOutput(),
      [{ slot: "commitment", output: validCommitmentOutput() }],
      [DISCOVERY_APPROVAL],
    );
    // No approval authorised a commitment module, so neither the module nor an
    // invented influence reference reaches the candidate.
    expect(sceneOf(result).modules).toEqual([]);
    expect(sceneOf(result).influences).toEqual([]);
  });

  it("derives the scene id from the frozen input, never from the model", () => {
    expect(sceneIdFor(INPUT_HASH)).toBe(sceneIdFor(INPUT_HASH));
    expect(sceneIdFor(INPUT_HASH)).not.toBe(sceneIdFor("b".repeat(48)));
    expect(sceneOf(assemble()).scene_id).toBe(sceneIdFor(INPUT_HASH));
  });

  it("prefers the brief's title over the one the model wrote", () => {
    const base = { ...validBaseOutput(), title: "A title the model chose" };
    expect(sceneOf(assemble(base)).title).toBe(SECOND_COPY_BRIEF.title);
  });

  it("composes modules in the fixed slot order whatever order they arrive in", () => {
    const forwards = sceneOf(
      assemble(validBaseOutput(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: validCommitmentOutput() },
      ]),
    );
    const backwards = sceneOf(
      assemble(validBaseOutput(), [
        { slot: "commitment", output: validCommitmentOutput() },
        { slot: "discovery", output: validDiscoveryOutput() },
      ]),
    );
    expect(forwards.modules.map((module) => module.slot)).toEqual([
      "discovery",
      "commitment",
    ]);
    expect(backwards.modules.map((module) => module.slot)).toEqual(
      forwards.modules.map((module) => module.slot),
    );
  });
});

describe("base generation", () => {
  it("accepts a base the real validator passes", () => {
    const verdict = verifyBase(sceneOf(assemble()), SECOND_COPY_BRIEF);
    expect(verdict.ok, verdict.errors.map((error) => error.code).join(",")).toBe(true);
    expect(verdict.report.graph?.reachable_endings).toEqual([
      "end.give",
      "end.keep",
      "end.leave",
    ]);
  });

  it("matches the frozen brief's world exactly", () => {
    const scene = sceneOf(assemble());
    expect(scene.world.room).toEqual(SECOND_COPY_BRIEF.room);
    expect(scene.world.object).toEqual(SECOND_COPY_BRIEF.object);
  });

  it("rejects an identifier outside the core namespace", () => {
    const verdict = verifyBase(sceneOf(assemble(badNamespaceBaseOutput())), SECOND_COPY_BRIEF);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("NAMESPACE_INVALID");
  });

  it("rejects a base missing a required core action", () => {
    const verdict = verifyBase(
      sceneOf(assemble(missingCoreActionBaseOutput())),
      SECOND_COPY_BRIEF,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("CORE_ACTION_MISSING");
  });

  it("rejects a fourth ending", () => {
    const result = assemble(fourEndingBaseOutput());
    // The strict contract rejects it during assembly: exactly three endings.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.findings[0]!.code).toBe("SCHEMA_INVALID");
  });

  it("rejects an illegal verb for a required core action", () => {
    const verdict = verifyBase(sceneOf(assemble(illegalVerbBaseOutput())), SECOND_COPY_BRIEF);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("CORE_VERB_MISMATCH");
  });

  it("produces a base whose hash does not depend on any approval", () => {
    // Two assemblies of the same base output, with different frozen approval
    // sets, produce the identical clean core.
    const withBoth = coreFromModelOutput(validBaseOutput(), worldFromBrief(SECOND_COPY_BRIEF));
    const withNone = coreFromModelOutput(validBaseOutput(), worldFromBrief(SECOND_COPY_BRIEF));
    expect(JSON.stringify(withBoth)).toBe(JSON.stringify(withNone));
  });
});

describe("module generation", () => {
  function moduleVerdict(
    slot: "discovery" | "commitment",
    output: ReturnType<typeof validDiscoveryOutput>,
  ) {
    const scene = sceneOf(assemble(validBaseOutput(), [{ slot, output }]));
    return verifyModule(scene, SECOND_COPY_BRIEF, slot, sceneApprovalAllowlist(APPROVALS));
  }

  it("accepts a Discovery module with a real mechanical witness", () => {
    const verdict = moduleVerdict("discovery", validDiscoveryOutput());
    expect(verdict.ok, verdict.errors.map((error) => error.code).join(",")).toBe(true);
    const witness = verdict.report.module_witnesses.discovery;
    expect(witness?.mechanical).toBe(true);
  });

  it("accepts a Commitment module with a real mechanical witness", () => {
    const verdict = moduleVerdict("commitment", validCommitmentOutput());
    expect(verdict.ok, verdict.errors.map((error) => error.code).join(",")).toBe(true);
    expect(verdict.report.module_witnesses.commitment?.mechanical).toBe(true);
  });

  it("rejects a module that reads the other slot's state", () => {
    const verdict = moduleVerdict("commitment", crossSlotModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("VAR_UNRESOLVED");
  });

  it("rejects a module that writes a core variable", () => {
    const verdict = moduleVerdict("commitment", coreWriteModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("FOREIGN_WRITE");
  });

  it("rejects a module attached to a port it does not own", () => {
    const verdict = moduleVerdict("commitment", wrongPortModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("GATE_PORT_INVALID");
  });

  it("rejects a module action that ends the scene directly", () => {
    const verdict = moduleVerdict("commitment", terminalModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("MODULE_ACTION_TERMINATES");
  });

  it("rejects an identifier outside the module's slot namespace", () => {
    const verdict = moduleVerdict("commitment", badNamespaceModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("NAMESPACE_INVALID");
  });

  it("rejects a mechanically empty module even though it is structurally legal", () => {
    const verdict = moduleVerdict("commitment", mechanicallyEmptyModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("MODULE_WITNESS_MISSING");
    expect(verdict.report.module_witnesses.commitment?.mechanical).toBe(false);
  });

  it("validates one module against the clean base alone, so no finding can name the other slot", () => {
    const both = sceneOf(
      assemble(validBaseOutput(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: crossSlotModuleOutput() },
      ]),
    );
    const isolated = sceneWithOnlySlot(both, "commitment");
    expect(isolated.modules.map((module) => module.slot)).toEqual(["commitment"]);
    const verdict = verifyModule(
      isolated,
      SECOND_COPY_BRIEF,
      "commitment",
      sceneApprovalAllowlist([COMMITMENT_APPROVAL]),
    );
    expect(verdict.ok).toBe(false);
    const text = JSON.stringify(verdict.errors);
    // The sentinel-bearing Discovery approval text is not in the candidate the
    // findings were computed from, so it cannot appear in them.
    expect(text).not.toContain(DISCOVERY_APPROVAL.approved_text);
  });
});

describe("subset validation", () => {
  it("validates the base, each module alone, and both together", () => {
    const scene = sceneOf(
      assemble(validBaseOutput(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: validCommitmentOutput() },
      ]),
    );
    const verdict = verifyCandidate(
      scene,
      SECOND_COPY_BRIEF,
      sceneApprovalAllowlist(APPROVALS),
    );
    expect(verdict.ok, JSON.stringify(verdict.summary.finding_codes)).toBe(true);
    expect(verdict.summary.subsets.map((subset) => subset.slots)).toEqual([
      [],
      ["commitment"],
      ["discovery"],
      ["discovery", "commitment"],
    ]);
    for (const subset of verdict.summary.subsets) expect(subset.ok).toBe(true);
    expect(verdict.summary.witnesses.map((witness) => witness.slot).sort()).toEqual([
      "commitment",
      "discovery",
    ]);
    for (const witness of verdict.summary.witnesses) {
      expect(witness.mechanical).toBe(true);
      expect(witness.sentence.length).toBeGreaterThan(10);
    }
  });

  it("requires a witness for every active module", () => {
    const scene = sceneOf(
      assemble(validBaseOutput(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: mechanicallyEmptyModuleOutput() },
      ]),
    );
    const verdict = verifyCandidate(
      scene,
      SECOND_COPY_BRIEF,
      sceneApprovalAllowlist(APPROVALS),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.summary.finding_codes).toContain("MODULE_WITNESS_MISSING");
  });

  it("reports a single-module candidate's subsets as base and that module", () => {
    const scene = sceneOf(
      assemble(validBaseOutput(), [{ slot: "discovery", output: validDiscoveryOutput() }]),
    );
    const verdict = verifyCandidate(
      scene,
      SECOND_COPY_BRIEF,
      sceneApprovalAllowlist([DISCOVERY_APPROVAL]),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.summary.subsets.map((subset) => subset.slots)).toEqual([
      [],
      ["discovery"],
    ]);
  });

  it("treats the hand-authored fixture the same way, which is the control", () => {
    const verdict = verifyCandidate(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF, [
      "approval_discovery_v1",
    ]);
    expect(verdict.ok, JSON.stringify(verdict.summary.finding_codes)).toBe(true);
    expect(SECOND_COPY_BASE.modules).toEqual([]);
  });
});

/**
 * The hook port is the server's to write, not the module's to name.
 *
 * A real live Discovery module attached its hook to `core.ask_context`, which
 * is the Commitment slot's effect port. The validator rejected it correctly
 * with `HOOK_PORT_INVALID`, the one permitted repair did not recover, and the
 * compilation failed — all of which behaved as designed. But a slot has exactly
 * one effect port, so there was never a choice to delegate: the module was
 * being asked to restate something the server already knew, and the only
 * possible wrong answer was the other slot's port.
 *
 * `ModelOnActionSchema` therefore has no `action_id`, and
 * `moduleFromModelOutput` writes the slot's port itself. These assertions keep
 * that true from both directions: the contract refuses the field, and the
 * assembled module carries the right port for each slot.
 */
describe("a module cannot name the port it attaches to", () => {
  it("has no action field on a hook in the model-facing contract", () => {
    const withPort = {
      ...validCommitmentOutput(),
      on_actions: [
        {
          id: "commitment.context_hook",
          // The field a live attempt mis-filled. It is no longer accepted.
          action_id: "core.inspect",
          when: { kind: "always" } as const,
          effects: [{ var_id: "commitment.cost_named" }],
          dialogue_id: "commitment.named_text",
        },
      ],
    };
    const parsed = ModuleCompilationOutputSchema.safeParse(withPort);
    expect(parsed.success, "a hook must not be able to name an action").toBe(false);
  });

  it("attaches every hook to its own slot's effect port", () => {
    for (const slot of ["discovery", "commitment"] as const) {
      const output = slot === "discovery" ? validDiscoveryOutput() : validCommitmentOutput();
      const built = moduleFromModelOutput(
        output,
        slot,
        slot === "discovery" ? DISCOVERY_APPROVAL.approval_id : COMMITMENT_APPROVAL.approval_id,
        worldFromBrief(SECOND_COPY_BRIEF),
      );
      const expected = FIXED_PORTS[slot].effect_action_ids[0];
      expect(built.on_actions.length, `${slot} must declare a hook`).toBeGreaterThan(0);
      for (const hook of built.on_actions) {
        expect(hook.action_id, `${slot} hook ${hook.id}`).toBe(expected);
      }
    }
  });

  it("still lets a gate name its port, because that choice is a real one", () => {
    // Commitment really has two gate ports, so that stays the module's choice
    // and `GATE_PORT_INVALID` keeps checking it — see the wrong-port case in
    // "one module against the clean base" above. A hook has no such choice.
    expect(FIXED_PORTS.commitment.gate_action_ids.length).toBe(2);
    expect(FIXED_PORTS.discovery.gate_action_ids.length).toBe(1);
    for (const slot of ["discovery", "commitment"] as const) {
      expect(FIXED_PORTS[slot].effect_action_ids.length, `${slot} effect ports`).toBe(1);
    }
  });
});
