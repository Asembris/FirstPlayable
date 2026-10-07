import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SECOND_COPY_BASE, SECOND_COPY_BRIEF, SECOND_COPY_VERSIONS } from "../../fixtures/second-copy";
import withMoonJson from "../../docs/phase6-canonical-pair/with-moon.version.json";
import withoutMoonJson from "../../docs/phase6-canonical-pair/without-moon.version.json";
import {
  DILEMMA_TRADE_NAMES,
  DilemmaCompilationOutputSchema,
  type DilemmaCompilationOutput,
} from "../../src/domain/compile";
import { DILEMMA_TRADES, TERMINAL_ENDING_BY_ACTION } from "../../src/domain/limits";
import type { Id, InfluenceModule, Scene } from "../../src/domain/scene";
import { parseScene } from "../../src/domain/scene";
import { removeModule, viewOf } from "../../src/engine/compose";
import { describeDilemma, dilemmaMoment } from "../../src/engine/dilemma";
import { exploreScene } from "../../src/engine/graph";
import { hashCanonical } from "../../src/engine/hash";
import { availableActions, isTrue, replay, step } from "../../src/engine/interpreter";
import { validateScene, validateSceneSubsets } from "../../src/engine/validate";
import { BASE_VARIABLE_IDS, baseCoreFromCopy } from "../../src/server/compile/base";
import {
  assembleScene,
  coreHash,
  DILEMMA_WAITS_ON,
  dilemmaModuleFromModelOutput,
  mechanicIdsOf,
  moduleFromModelOutput,
  moduleHash,
  sceneApprovalAllowlist,
  sceneApprovalId,
  worldFromBrief,
} from "../../src/server/compile/assemble";
import { DILEMMA_INSTRUCTIONS } from "../../src/server/compile/instructions";
import { runModuleStage } from "../../src/server/compile/stages";
import {
  COMMITMENT_APPROVAL,
  COMMITMENT_APPROVAL_PAYLOAD,
  DISCOVERY_APPROVAL,
  SENTINELS_FORBIDDEN_IN_COMMITMENT,
  legacyCommitmentOutput,
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./support/compile-fixtures";
import { fakeCompiler } from "./support/fake-compiler";

/**
 * The consequential dilemma, end to end through the production wiring.
 *
 * Every scene below is built by the same `dilemmaModuleFromModelOutput` and
 * `assembleScene` the commitment stage uses, from a model-shaped output, and is
 * judged by the real engine. The properties are checked twice where it
 * matters: once through the validator's own findings, and once directly over
 * the explored graph, so a regression in the validator's dilemma rules cannot
 * hide a regression in the wiring.
 */

const BRIEF = SECOND_COPY_BRIEF;
const WORLD = worldFromBrief(BRIEF);
const CORE = baseCoreFromCopy(BRIEF, validBaseCopy());
const INPUT_HASH = "d".repeat(48);
const ALLOWED = sceneApprovalAllowlist([DISCOVERY_APPROVAL, COMMITMENT_APPROVAL]);
const ENDINGS = ["end.give", "end.keep", "end.leave"];
/** The shortest route to the choice: the request explained, the object seen. */
const TO_CHOICE = ["core.inspect", "core.ask_context"];

type Trade = keyof typeof DILEMMA_TRADES;

function dilemmaOutput(trade: Trade): DilemmaCompilationOutput {
  return { ...validCommitmentOutput(), trade };
}

function dilemmaModule(trade: Trade): InfluenceModule {
  return dilemmaModuleFromModelOutput(
    dilemmaOutput(trade),
    "commitment",
    COMMITMENT_APPROVAL.approval_id,
    WORLD,
  );
}

function build(trade: Trade | null, withDiscovery = false): Scene {
  const modules: InfluenceModule[] = [];
  const approvals = [];
  if (withDiscovery) {
    modules.push(
      moduleFromModelOutput(validDiscoveryOutput(), "discovery", DISCOVERY_APPROVAL.approval_id, WORLD),
    );
    approvals.push(DISCOVERY_APPROVAL);
  }
  if (trade !== null) {
    modules.push(dilemmaModule(trade));
    approvals.push(COMMITMENT_APPROVAL);
  }
  const result = assembleScene({
    brief: BRIEF,
    inputHash: INPUT_HASH,
    core: CORE,
    generatedTitle: validBaseCopy().title,
    modules,
    approvals,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.findings));
  return result.scene;
}

/** Bits after a legal replay, failing loudly if any step was refused. */
function stateAfter(scene: Scene, prefix: readonly Id[]): number {
  const run = replay(scene, prefix);
  expect(run.stopped_at, `replay refused at ${run.stopped_at}`).toBeNull();
  return run.state.bits;
}

function availabilityOf(scene: Scene, bits: number, actionId: Id): string {
  const entry = availableActions(scene, { bits }).find((candidate) => candidate.action_id === actionId);
  return entry === undefined ? "hidden" : entry.enabled ? "enabled" : "locked";
}

const RESPONSES = ["commitment.action_1", "commitment.action_2"] as const;
const FLAGS = ["commitment.state_1", "commitment.state_2"] as const;

/** Every trade, alone and composed with an independent Discovery prerequisite. */
const CASES = DILEMMA_TRADE_NAMES.flatMap((trade) => [
  { trade, withDiscovery: false, name: `${trade}` },
  { trade, withDiscovery: true, name: `${trade} with Discovery` },
]);

describe("a dilemma compiles to a scene the engine accepts", () => {
  it.each(CASES)("$name: validates, with every removal subset and all three endings", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const report = validateScene(scene, BRIEF, { approvedApprovalIds: ALLOWED });
    expect(report.ok, report.findings.map((finding) => finding.code).join(",")).toBe(true);
    expect([...(report.graph?.reachable_endings ?? [])].sort()).toEqual(ENDINGS);
    expect(report.module_witnesses.commitment?.mechanical).toBe(true);

    const subsets = validateSceneSubsets(scene, BRIEF, { approvedApprovalIds: ALLOWED });
    expect(subsets.ok).toBe(true);
    expect(subsets.subsets).toHaveLength(withDiscovery ? 4 : 2);
  });

  it("names the trade's two endings as the stakes, in order", () => {
    for (const trade of DILEMMA_TRADE_NAMES) {
      const module = dilemmaModule(trade);
      expect(module.dilemma?.responses.map((response) => response.secures_action_id)).toEqual(
        DILEMMA_TRADES[trade],
      );
      expect(module.gates.map((gate) => gate.action_id)).toEqual(DILEMMA_TRADES[trade]);
    }
  });
});

describe("the two responses are mutually exclusive", () => {
  it.each(CASES)("$name: taking either response withdraws the other", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const choice = stateAfter(scene, TO_CHOICE);
    expect(availabilityOf(scene, choice, RESPONSES[0])).toBe("enabled");
    expect(availabilityOf(scene, choice, RESPONSES[1])).toBe("enabled");

    for (const [taken, other] of [RESPONSES, [...RESPONSES].reverse()] as const) {
      const after = step(scene, { bits: choice }, taken);
      expect(after.ok).toBe(true);
      if (!after.ok) continue;
      const refused = step(scene, after.state, other);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.code).toBe("ACTION_UNAVAILABLE");
    }
  });

  it.each(CASES)("$name: no reachable state has taken both", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const explored = exploreScene(scene);
    expect(explored.ok).toBe(true);
    if (!explored.ok) return;
    const view = viewOf(scene);
    const both = explored.graph.states.filter((bits) =>
      FLAGS.every((flag) => isTrue(view, { bits }, flag)),
    );
    expect(both).toEqual([]);
  });
});

describe("each response has a visible gain and a visible sacrifice", () => {
  it.each(CASES)("$name: the secured ending opens, the forfeited one stays locked with its reason", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const output = dilemmaOutput(trade);
    const [first, second] = DILEMMA_TRADES[trade];
    // Discovery gates `core.give` behind its own action; take it first so the
    // reading isolates the dilemma's own gates.
    const prefix = withDiscovery ? [...TO_CHOICE, "discovery.action_1"] : TO_CHOICE;
    const choice = stateAfter(scene, prefix);

    // Before the choice, both stakes are offered and both are locked.
    expect(availabilityOf(scene, choice, first)).toBe("locked");
    expect(availabilityOf(scene, choice, second)).toBe("locked");

    const afterFirst = stateAfter(scene, [...prefix, RESPONSES[0]]);
    expect(availabilityOf(scene, afterFirst, first)).toBe("enabled");
    expect(availabilityOf(scene, afterFirst, second)).toBe("locked");
    expect(availableActions(scene, { bits: afterFirst }).find((a) => a.action_id === second)?.blocked?.text).toBe(
      output.second_response.lock_text,
    );

    const afterSecond = stateAfter(scene, [...prefix, RESPONSES[1]]);
    expect(availabilityOf(scene, afterSecond, second)).toBe("enabled");
    expect(availabilityOf(scene, afterSecond, first)).toBe("locked");
    expect(availableActions(scene, { bits: afterSecond }).find((a) => a.action_id === first)?.blocked?.text).toBe(
      output.first_response.lock_text,
    );
  });

  it("speaks the tension when the request is explained, before the choice", () => {
    const scene = build("return_or_keep");
    const asked = step(scene, { bits: 0 }, "core.ask_context");
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.dialogue.map((line) => line.text)).toContain(validCommitmentOutput().tension_text);
  });
});

describe("the player cannot obtain both benefits", () => {
  it.each(CASES)("$name: no reachable state enables both stakes, and each needs its own response", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const explored = exploreScene(scene);
    expect(explored.ok).toBe(true);
    if (!explored.ok) return;
    const view = viewOf(scene);
    const stakes = DILEMMA_TRADES[trade];
    for (const bits of explored.graph.states) {
      const availability = explored.graph.availability.get(bits)!;
      const enabled = stakes.map((stake) => availability.get(stake) === "enabled");
      expect(enabled[0] && enabled[1], `both stakes open in state ${bits}`).toBe(false);
      stakes.forEach((stake, index) => {
        if (availability.get(stake) !== "enabled") return;
        expect(isTrue(view, { bits }, FLAGS[index]!), `${stake} open without its response`).toBe(true);
      });
    }
  });
});

describe("the choice changes later play", () => {
  it.each(CASES)("$name: each response closes the ending the other secures", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const report = describeDilemma(scene);
    expect(report).not.toBeNull();
    if (report === null) return;
    const [first, second] = DILEMMA_TRADES[trade].map(
      (action) => TERMINAL_ENDING_BY_ACTION[action as keyof typeof TERMINAL_ENDING_BY_ACTION],
    );
    const [sideA, sideB] = report.sides;
    expect(sideA.endings_after).toContain(first);
    expect(sideA.endings_after).not.toContain(second);
    expect(sideB.endings_after).toContain(second);
    expect(sideB.endings_after).not.toContain(first);
    expect(sideA.endings_closed).toEqual([second]);
    expect(sideB.endings_closed).toEqual([first]);
    expect(sideA.endings_after).not.toEqual(sideB.endings_after);
  });

  it("gives the three trades three different consequence structures", () => {
    const shapes = DILEMMA_TRADE_NAMES.map((trade) => {
      const report = describeDilemma(build(trade))!;
      return report.sides.map((side) => side.endings_after.join("+")).join(" | ");
    });
    expect(new Set(shapes).size).toBe(3);
  });
});

describe("no softlocks", () => {
  it.each(CASES)("$name: every reachable state can still reach an ending", ({ trade, withDiscovery }) => {
    const explored = exploreScene(build(trade, withDiscovery));
    expect(explored.ok).toBe(true);
    if (!explored.ok) return;
    const stuck = explored.graph.states.filter(
      (bits) => (explored.graph.endingsFrom.get(bits)?.size ?? 0) === 0,
    );
    expect(stuck).toEqual([]);
  });

  it.each(CASES)("$name: skipping the dilemma still ends the scene through the untouched ending", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const untouched = (["core.give", "core.withhold", "core.leave"] as const).find(
      (action) => !(DILEMMA_TRADES[trade] as readonly string[]).includes(action),
    )!;
    const prefix = withDiscovery && untouched === "core.give" ? [...TO_CHOICE, "discovery.action_1"] : TO_CHOICE;
    const run = replay(scene, [...prefix, untouched]);
    expect(run.stopped_at).toBeNull();
    expect(run.ending?.id).toBe(TERMINAL_ENDING_BY_ACTION[untouched]);
  });
});

describe("removing the influence restores the clean foundation", () => {
  it.each(CASES)("$name: removal recomposes to exactly the scene built without it", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const removed = removeModule(scene, "commitment");
    const without = build(null, withDiscovery);
    expect(hashCanonical(removed)).toBe(hashCanonical(without));
    expect(removed.core).toEqual(CORE);
    expect(removed.ports).toEqual(scene.ports);
    expect(removed.influences.some((entry) => entry.approval_id === sceneApprovalId(COMMITMENT_APPROVAL.approval_id))).toBe(false);
    expect(describeDilemma(removed)).toBeNull();
    const report = validateScene(removed, BRIEF, { approvedApprovalIds: ALLOWED });
    expect(report.ok, report.findings.map((finding) => finding.code).join(",")).toBe(true);
  });

  it("plays the clean foundation's own availability again once removed", () => {
    const removed = removeModule(build("return_or_walk_away"), "commitment");
    const choice = stateAfter(removed, TO_CHOICE);
    for (const action of ["core.give", "core.withhold", "core.leave"]) {
      expect(availabilityOf(removed, choice, action)).toBe("enabled");
    }
  });
});

describe("provenance stays honest", () => {
  it("binds the approval to exactly the module's own actions, gates, and tension hook", () => {
    const scene = build("keep_or_walk_away");
    const module = scene.modules.find((candidate) => candidate.slot === "commitment")!;
    const binding = scene.provenance.find((entry) => entry.approval_id === module.approval_id)!;
    expect(binding.mechanic_ids).toEqual(mechanicIdsOf(module));
    expect(binding.mechanic_ids).toEqual([
      "commitment.action_1",
      "commitment.action_2",
      "commitment.gate_1",
      "commitment.gate_2",
      "commitment.hook_1",
    ]);
    const influence = scene.influences.find((entry) => entry.approval_id === module.approval_id)!;
    expect(influence.source_kind).toBe(COMMITMENT_APPROVAL.source_kind);
    expect(influence.approved_text).toBe(COMMITMENT_APPROVAL.approved_text);
  });

  it("has no field in the model contract for an id, a condition, a port, a source, or a provenance claim", () => {
    const schema = JSON.stringify(z.toJSONSchema(DilemmaCompilationOutputSchema));
    for (const forbidden of [
      "var_id",
      "action_id",
      "ending_id",
      "approval",
      "provenance",
      "source_kind",
      "clauses",
      "gate_port",
      "slot",
      "qloo",
    ]) {
      expect(schema, `the dilemma contract exposes ${forbidden}`).not.toContain(forbidden);
    }
    expect(DILEMMA_TRADE_NAMES).toEqual(["return_or_keep", "return_or_walk_away", "keep_or_walk_away"]);
  });

  it("never credits the source with the mechanic", () => {
    expect(DILEMMA_INSTRUCTIONS).toContain("Never claim the");
    expect(DILEMMA_INSTRUCTIONS).toContain("source recommended a mechanic");
    expect(DILEMMA_INSTRUCTIONS.toLowerCase()).not.toContain("qloo");
  });
});

describe("deterministic replay explains the consequence", () => {
  it.each(CASES)("$name: the report is reproducible and every reading replays", ({ trade, withDiscovery }) => {
    const scene = build(trade, withDiscovery);
    const report = describeDilemma(scene)!;
    expect(describeDilemma(structuredClone(scene))).toEqual(report);
    expect(report.tension_line).toBe(validCommitmentOutput().tension_text);

    for (const side of report.sides) {
      const bits = stateAfter(scene, side.prefix);
      expect(availabilityOf(scene, bits, side.secures.action_id)).toBe(side.secures.status);
      expect(availabilityOf(scene, bits, side.forfeits.action_id)).toBe(side.forfeits.status);
      expect(side.forfeits.status).toBe("locked");
      expect(side.forfeits.blocked_text).not.toBeNull();
    }
    expect(report.sides[0].prefix.slice(0, -1)).toEqual(report.choice_prefix);
  });

  it("tells the player what is open and what was given up", () => {
    const scene = build("return_or_keep");
    expect(dilemmaMoment(scene, 0)).toBeNull();
    const choice = stateAfter(scene, TO_CHOICE);
    expect(dilemmaMoment(scene, choice)).toEqual({ kind: "open", response_action_ids: [...RESPONSES] });
    const taken = stateAfter(scene, [...TO_CHOICE, RESPONSES[1]]);
    const output = validCommitmentOutput();
    expect(dilemmaMoment(scene, taken)).toEqual({
      kind: "taken",
      response_label: output.second_response.action_label,
      forfeited_label: validBaseCopy().give_label,
    });
  });
});

/* ------------------------------------------------- the validator's authority */

type Mutable = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function tampered(edit: (module: Mutable) => void, trade: Trade = "return_or_keep"): string[] {
  const scene = structuredClone(build(trade)) as Mutable;
  edit(scene.modules.find((module: Mutable) => module.slot === "commitment"));
  const report = validateScene(scene as Scene, BRIEF, { approvedApprovalIds: ALLOWED });
  expect(report.ok).toBe(false);
  return report.findings.map((finding) => finding.code);
}

describe("the validator refuses a forged or broken dilemma", () => {
  it("refuses a stake gate outside the fixed ports when no dilemma is declared", () => {
    expect(tampered((module) => delete module.dilemma)).toContain("GATE_PORT_INVALID");
  });

  it("refuses a stake that is not one of the three terminal actions", () => {
    const codes = tampered((module) => {
      module.dilemma.responses[0].secures_action_id = "core.ask_terms";
    });
    expect(codes).toContain("DILEMMA_STAKE_INVALID");
  });

  it("refuses a declaration whose stake has no gate", () => {
    const codes = tampered((module) => {
      module.gates = module.gates.slice(0, 1);
    });
    expect(codes).toContain("DILEMMA_STAKE_UNGATED");
  });

  it("refuses an extra gate the declaration does not name", () => {
    const codes = tampered((module) => {
      module.gates.push({ ...module.gates[0], id: "commitment.gate_3", action_id: "core.ask_terms" });
    });
    expect(codes).toContain("DILEMMA_GATE_UNDECLARED");
  });

  it("refuses a response that does not set exactly its own flag", () => {
    const codes = tampered((module) => {
      module.actions[0].branches[0].effects.push({ op: "set_true", var_id: "commitment.state_2" });
    });
    expect(codes).toContain("DILEMMA_RESPONSE_SHAPE");
  });

  it("refuses a tension that is not one of the module's own hooks", () => {
    const codes = tampered((module) => {
      module.dilemma.tension_hook_id = "commitment.hook_9";
    });
    expect(codes).toContain("DILEMMA_TENSION_UNRESOLVED");
  });

  it("refuses a dilemma declared outside the commitment slot", () => {
    const scene = structuredClone(build("return_or_keep")) as Mutable;
    const legacy = moduleFromModelOutput(validDiscoveryOutput(), "discovery", DISCOVERY_APPROVAL.approval_id, WORLD);
    scene.modules.unshift({ ...legacy, dilemma: scene.modules[0].dilemma });
    const codes = validateScene(scene as Scene, BRIEF, { approvedApprovalIds: ALLOWED }).findings.map(
      (finding) => finding.code,
    );
    expect(codes).toContain("DILEMMA_SLOT_INVALID");
  });

  it("refuses responses that can both be taken", () => {
    const codes = tampered((module) => {
      module.actions[1].when = {
        kind: "any",
        clauses: [[{ var_id: DILEMMA_WAITS_ON, equals: true }, { var_id: "commitment.state_2", equals: false }]],
      };
    });
    expect(codes).toContain("DILEMMA_NOT_EXCLUSIVE");
  });

  it("refuses a benefit available without paying for it", () => {
    const codes = tampered((module) => {
      module.gates[0].when = {
        kind: "any",
        clauses: [[{ var_id: "commitment.state_1", equals: true }], [{ var_id: "commitment.state_2", equals: true }]],
      };
    });
    expect(codes).toContain("DILEMMA_BENEFIT_UNGUARDED");
  });

  it("refuses a choice that changes nothing later", () => {
    const either = {
      kind: "any",
      clauses: [[{ var_id: "commitment.state_1", equals: true }], [{ var_id: "commitment.state_2", equals: true }]],
    };
    const codes = tampered((module) => {
      module.gates[0].when = either;
      module.gates[1].when = either;
    });
    expect(codes).toContain("DILEMMA_INCONSEQUENTIAL");
  });
});

/* ---------------------------------------------- backward compatibility */

describe("existing scenes and modules are unchanged", () => {
  it("re-parses every stored fixture and the canonical pair to the hashes they were stored with", () => {
    for (const stored of [withMoonJson, withoutMoonJson]) {
      const scene = parseScene(stored.scene);
      expect(coreHash(scene.core)).toBe(stored.base_hash);
      for (const module of scene.modules) {
        expect(module.dilemma).toBeUndefined();
        expect(moduleHash(module)).toBe((stored.module_hashes as Record<string, string>)[module.slot]);
      }
      expect(describeDilemma(scene)).toBeNull();
    }
    for (const version of SECOND_COPY_VERSIONS) {
      expect(hashCanonical(parseScene(JSON.parse(JSON.stringify(version.scene))))).toBe(
        hashCanonical(version.scene),
      );
    }
  });

  it("still accepts a legacy prerequisite commitment module, judged by the old rules", () => {
    const legacy = moduleFromModelOutput(legacyCommitmentOutput(), "commitment", COMMITMENT_APPROVAL.approval_id, WORLD);
    expect(legacy.dilemma).toBeUndefined();
    const result = assembleScene({
      brief: BRIEF,
      inputHash: INPUT_HASH,
      core: CORE,
      generatedTitle: validBaseCopy().title,
      modules: [legacy],
      approvals: [COMMITMENT_APPROVAL],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = validateScene(result.scene, BRIEF, { approvedApprovalIds: ALLOWED });
    expect(report.ok, report.findings.map((finding) => finding.code).join(",")).toBe(true);
    expect(describeDilemma(result.scene)).toBeNull();
  });

  it("keeps the fixture base valid and dilemma-free", () => {
    expect(validateScene(SECOND_COPY_BASE, BRIEF).ok).toBe(true);
    expect(describeDilemma(SECOND_COPY_BASE)).toBeNull();
  });
});

/* -------------------------------------------------------- the stage */

describe("the commitment stage compiles a dilemma", () => {
  it("asks for the dilemma contract with the dilemma instructions, and commits", async () => {
    const compiler = fakeCompiler({ module: [{ output: validCommitmentOutput() }] });
    const outcome = await runModuleStage(
      {
        brief: BRIEF,
        inputHash: INPUT_HASH,
        core: CORE,
        baseTitle: validBaseCopy().title,
        slot: "commitment",
        approval: COMMITMENT_APPROVAL,
        approvalPayload: COMMITMENT_APPROVAL_PAYLOAD,
        repair: null,
      },
      compiler,
    );
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.artifact.module.dilemma).toBeDefined();
    expect(compiler.requests[0]!.instructions).toBe(DILEMMA_INSTRUCTIONS);
    const bytes = JSON.stringify(compiler.requests[0]);
    for (const sentinel of SENTINELS_FORBIDDEN_IN_COMMITMENT) {
      expect(bytes, `the dilemma stage leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("never names the other slot in its instructions", () => {
    expect(DILEMMA_INSTRUCTIONS).not.toContain("discovery");
  });

  it("waits on the base flag the base skeleton actually declares", () => {
    expect(DILEMMA_WAITS_ON).toBe(BASE_VARIABLE_IDS.context);
  });
});
