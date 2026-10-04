import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SECOND_COPY_BASE,
  SECOND_COPY_BRIEF,
  SECOND_COPY_DISCOVERY_V1,
} from "../../fixtures/second-copy";
import { FIXED_PORTS, RESERVED_SPEAKER_IDS } from "../../src/domain/limits";
import { baseCoreFromCopy } from "../../src/server/compile/base";
import {
  MODULE_SPEAKERS,
  type ModuleCompilationOutput,
  ModuleCompilationOutputSchema,
  moduleOutputSchemaFor,
} from "../../src/domain/compile";
import {
  assembleScene,
  mechanicIdsOf,
  moduleFromModelOutput,
  sceneApprovalAllowlist,
  sceneApprovalId,
  sceneIdFor,
  sceneReferenceId,
  mechanicIds,
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
  overBudgetModuleOutput,
  twoMechanicCommitmentOutput,
  nonPlainTextBaseCopy,
  validBaseCopy,
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
  copy = validBaseCopy(),
  modules: { slot: "discovery" | "commitment"; output: ReturnType<typeof validDiscoveryOutput> }[] = [],
  approvals = APPROVALS,
) {
  const world = worldFromBrief(SECOND_COPY_BRIEF);
  return assembleScene({
    brief: SECOND_COPY_BRIEF,
    inputHash: INPUT_HASH,
    // Deterministic mechanics, model copy. The base is no longer model output.
    core: baseCoreFromCopy(SECOND_COPY_BRIEF, copy),
    generatedTitle: copy.title,
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
    const core = baseCoreFromCopy(SECOND_COPY_BRIEF, validBaseCopy());
    const effects = core.actions.flatMap((action) =>
      action.branches.flatMap((branch) => branch.effects),
    );
    expect(effects.length).toBeGreaterThan(0);
    for (const effect of effects) expect(effect.op).toBe("set_true");
  });

  it("derives every action target from the verb and the frozen world", () => {
    const core = baseCoreFromCopy(SECOND_COPY_BRIEF, validBaseCopy());
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
      assemble(validBaseCopy(), [{ slot: "discovery", output: validDiscoveryOutput() }]),
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
      validBaseCopy(),
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
    const base = { ...validBaseCopy(), title: "A title the model chose" };
    expect(sceneOf(assemble(base)).title).toBe(SECOND_COPY_BRIEF.title);
  });

  it("composes modules in the fixed slot order whatever order they arrive in", () => {
    const forwards = sceneOf(
      assemble(validBaseCopy(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: validCommitmentOutput() },
      ]),
    );
    const backwards = sceneOf(
      assemble(validBaseCopy(), [
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

  /*
   * The four base rejections this suite used to assert — an identifier outside
   * the core namespace, a missing required core action, a fourth ending, and an
   * illegal verb — are no longer representable, because no model output reaches
   * any of those fields. `compile-base.test.ts` asserts that unrepresentability
   * directly, which is a stronger statement than a rejection test.
   *
   * What a base candidate can still fail on is its copy, so that is what is
   * asserted here: the validator remains the final authority over the
   * assembled structure, and nothing special-cases a server-authored core.
   */
  it("still rejects copy the authoritative scene contract refuses", () => {
    const result = assemble(nonPlainTextBaseCopy());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.findings[0]!.code).toBe("SCHEMA_INVALID");
      expect(result.findings[0]!.detail).toContain("plain text");
    }
  });

  it("produces a base whose core does not depend on any approval", () => {
    // Two assemblies of the same brief and copy, with different frozen approval
    // sets, produce the identical clean core.
    const withBoth = sceneOf(
      assemble(validBaseCopy(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: validCommitmentOutput() },
      ]),
    );
    const withNone = sceneOf(assemble());
    expect(JSON.stringify(withBoth.core)).toBe(JSON.stringify(withNone.core));
  });
});

describe("module generation", () => {
  function moduleVerdict(
    slot: "discovery" | "commitment",
    output: ReturnType<typeof validDiscoveryOutput>,
  ) {
    const scene = sceneOf(assemble(validBaseCopy(), [{ slot, output }]));
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

  it("accepts two mechanics in one module, each earning a different base action", () => {
    const verdict = moduleVerdict("commitment", twoMechanicCommitmentOutput());
    expect(verdict.ok, verdict.errors.map((error) => error.code).join(",")).toBe(true);
    expect(verdict.report.module_witnesses.commitment?.mechanical).toBe(true);
  });

  /**
   * The live failure classes, each one now unrepresentable.
   *
   * These are the exact deterministic codes the real provider produced against
   * the previous module contract, recorded in `docs/PHASE4_EVIDENCE.md`. Each
   * assertion is about the contract rather than the validator: the validator
   * still contains every one of these checks, and the engine suite still
   * exercises them against directly constructed scenes. What changed is that a
   * module can no longer express the mistake.
   */
  it("gives a module no field in which to write a foundation variable", () => {
    const schema = z.toJSONSchema(ModuleCompilationOutputSchema);
    const mechanic = ((schema as Record<string, Record<string, Record<string, Record<string, unknown>>>>)[
      "properties"
    ]?.["mechanics"]?.["items"] ?? {}) as Record<string, unknown>;
    const fields = Object.keys((mechanic["properties"] ?? {}) as object).sort();

    // The whole model-facing surface of a module, in one assertion.
    expect(fields).toEqual(
      [
        "action_label",
        "dialogue_speaker",
        "dialogue_text",
        "flag_label",
        "flag_visible",
        "gate_port",
        "gate_blocked_text",
        "hook",
        "verb",
      ].sort(),
    );
    expect(mechanic["additionalProperties"]).toBe(false);

    // Nothing anywhere in the contract can carry an identifier, a condition,
    // an effect, a branch, or an ending binding.
    const whole = JSON.stringify(schema);
    for (const absent of [
      "var_id",
      "variable_index",
      "effects",
      "branches",
      "ending_id",
      "dialogue_id",
      "action_id",
      "clauses",
      "initial",
      "target",
    ]) {
      expect(whole, `a module must not be able to name ${absent}`).not.toContain(`"${absent}"`);
    }
  });

  it("writes every identifier, condition, and effect itself", () => {
    const module = moduleFromModelOutput(
      twoMechanicCommitmentOutput(),
      "commitment",
      COMMITMENT_APPROVAL.approval_id,
      worldFromBrief(SECOND_COPY_BRIEF),
    );

    const own = new Set(module.variables.map((variable) => variable.id));
    expect(own.size).toBe(2);
    for (const [index, variable] of module.variables.entries()) {
      expect(variable.id).toBe(mechanicIds("commitment", index).flag);
      // Every flag begins false; that is a contract literal, not a choice.
      expect(variable.initial).toBe(false);
    }

    const written = [
      ...module.actions.flatMap((action) => action.branches).flatMap((branch) => branch.effects),
      ...module.on_actions.flatMap((hook) => hook.effects),
    ];
    expect(written.length).toBeGreaterThan(0);
    for (const effect of written) {
      expect(effect.op).toBe("set_true");
      // FOREIGN_WRITE, and a cross-slot VAR_UNRESOLVED, are unreachable: the
      // only variable an effect can name is one this module declared.
      expect(own.has(effect.var_id)).toBe(true);
    }

    // Every declared flag is both written and read, which is what
    // VARIABLE_NEVER_WRITTEN and VARIABLE_NEVER_READ check.
    const read = new Set<string>();
    const collect = (condition: { kind: string; clauses?: { var_id: string }[][] }): void => {
      for (const clause of condition.clauses ?? []) {
        for (const atom of clause) read.add(atom.var_id);
      }
    };
    for (const action of module.actions) {
      collect(action.when);
      // No module action may end the scene, and none can say it does.
      for (const branch of action.branches) expect(branch.ending_id).toBeNull();
      // Exactly one branch, whose condition always applies.
      expect(action.branches).toHaveLength(1);
      expect(action.branches[0]?.when).toEqual({ kind: "always" });
    }
    for (const gate of module.gates) collect(gate.when);
    for (const id of own) {
      expect(
        written.some((effect) => effect.var_id === id),
        `${id} is written`,
      ).toBe(true);
      expect(read.has(id), `${id} is read`).toBe(true);
    }

    // Every identifier is this application's, inside the slot's namespace.
    for (const id of [
      ...module.variables.map((variable) => variable.id),
      ...module.actions.map((action) => action.id),
      ...module.gates.map((gate) => gate.id),
      ...module.on_actions.map((hook) => hook.id),
      ...module.dialogue.map((node) => node.id),
    ]) {
      expect(id.startsWith("commitment.")).toBe(true);
    }
  });

  it("resolves the speaker from its enumeration, so an unresolved one cannot occur", () => {
    const world = worldFromBrief(SECOND_COPY_BRIEF);
    const allowed = new Set<string>([...RESERVED_SPEAKER_IDS, world.characters[0].id]);
    for (const speaker of MODULE_SPEAKERS) {
      const first = validCommitmentOutput().mechanics[0] as ModuleCompilationOutput["mechanics"][number];
      const module = moduleFromModelOutput(
        { mechanics: [{ ...first, dialogue_speaker: speaker }] },
        "commitment",
        COMMITMENT_APPROVAL.approval_id,
        world,
      );
      for (const node of module.dialogue) expect(allowed.has(node.speaker_id)).toBe(true);
    }
  });

  it("offers each slot only its own gate ports", () => {
    for (const slot of ["discovery", "commitment"] as const) {
      const schema = JSON.stringify(z.toJSONSchema(moduleOutputSchemaFor(slot)));
      for (const port of FIXED_PORTS[slot].gate_action_ids) {
        expect(schema, `${slot} may gate ${port}`).toContain(port);
      }
      const foreign = slot === "discovery" ? "commitment" : "discovery";
      for (const port of FIXED_PORTS[foreign].gate_action_ids) {
        expect(schema, `${slot} may not gate ${port}`).not.toContain(port);
      }
    }
  });

  it("still enforces the port rule underneath the narrowed contract", () => {
    // Unrepresentable in what the provider is given, and still a finding if it
    // ever arrives: the validator was not relieved of the check.
    const verdict = moduleVerdict("commitment", wrongPortModuleOutput());
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.map((error) => error.code)).toContain("GATE_PORT_INVALID");
  });

  it("refuses more mechanics than the module budget allows, during assembly", () => {
    // The budgets live in the authoritative scene contract, so an over-budget
    // module never reaches the validator: assembly refuses to carry it.
    const result = assemble(validBaseCopy(), [
      { slot: "commitment", output: overBudgetModuleOutput() },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.map((finding) => finding.code)).toContain("SCHEMA_INVALID");
  });

  it("validates one module against the clean base alone, so no finding can name the other slot", () => {
    const both = sceneOf(
      assemble(validBaseCopy(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: wrongPortModuleOutput() },
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
      assemble(validBaseCopy(), [
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
    /*
     * A module that changes nothing mechanical is no longer expressible: every
     * mechanic a module can return gates a base action. The check it would
     * have tripped is still in the validator, so this builds the gateless
     * module directly instead of asking the contract for one — the validator
     * level is where the rule lives and where it has to keep holding.
     */
    const composed = sceneOf(
      assemble(validBaseCopy(), [
        { slot: "discovery", output: validDiscoveryOutput() },
        { slot: "commitment", output: validCommitmentOutput() },
      ]),
    );
    const scene = {
      ...composed,
      modules: composed.modules.map((module) =>
        module.slot === "commitment"
          ? {
              ...module,
              // A gate that always allows its action blocks nothing, so the
              // module changes no availability and no reachable ending.
              gates: module.gates.map((gate) => ({
                ...gate,
                when: { kind: "always" } as const,
              })),
            }
          : module,
      ),
    };
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
      assemble(validBaseCopy(), [{ slot: "discovery", output: validDiscoveryOutput() }]),
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
    const first = validCommitmentOutput().mechanics[0] as ModuleCompilationOutput["mechanics"][number];
    const withPort = {
      mechanics: [
        {
          ...first,
          // The field a live attempt mis-filled. It is no longer accepted, and
          // the hook object it lived on no longer has anywhere to put it.
          hook: {
            action_id: "core.inspect",
            dialogue_speaker: "narrator" as const,
            dialogue_text: "A line.",
          },
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
