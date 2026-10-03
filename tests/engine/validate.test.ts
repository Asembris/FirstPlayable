import { describe, expect, it } from "vitest";
import {
  APPROVED_APPROVAL_IDS,
  SECOND_COPY_BASE,
  SECOND_COPY_BRIEF,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
} from "../../fixtures/second-copy";
import { parseBrief } from "../../src/domain/brief";
import { parseScene } from "../../src/domain/scene";
import type { Scene } from "../../src/domain/scene";
import { validateScene, validateSceneSubsets } from "../../src/engine/validate";
import type { ValidationReport } from "../../src/engine/validate";
import briefJson from "../../fixtures/second_copy.brief.json";
import { findAction, rawBase, rawV1, whenFlags, type Mutable } from "./helpers";

const authorized = { approvedApprovalIds: APPROVED_APPROVAL_IDS };

const codes = (report: ValidationReport): string[] => [
  ...new Set(report.findings.map((finding) => finding.code)),
];

const validateRaw = (
  scene: unknown,
  options: Parameters<typeof validateScene>[2] = authorized,
): ValidationReport => validateScene(parseScene(scene), SECOND_COPY_BRIEF, options);

describe("the canonical fixtures validate", () => {
  it("validates the clean base", () => {
    const report = validateScene(SECOND_COPY_BASE, SECOND_COPY_BRIEF, authorized);
    expect(codes(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.graph?.reachable_nonterminal_states).toBe(5);
    expect(report.graph?.reachable_endings).toEqual([
      "end.give",
      "end.keep",
      "end.leave",
    ]);
  });

  it("validates Discovery v1 and v2 with eight reachable nonterminal states each", () => {
    for (const scene of [SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V2]) {
      const report = validateScene(scene, SECOND_COPY_BRIEF, authorized);
      expect(codes(report)).toEqual([]);
      expect(report.graph?.reachable_nonterminal_states).toBe(8);
      expect(report.graph?.reachable_endings).toEqual([
        "end.give",
        "end.keep",
        "end.leave",
      ]);
      expect(report.module_witnesses.discovery?.mechanical).toBe(true);
    }
  });

  it("requires at least three actions to reach any ending", () => {
    for (const scene of [
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V1,
      SECOND_COPY_DISCOVERY_V2,
    ]) {
      const report = validateScene(scene, SECOND_COPY_BRIEF, authorized);
      for (const depth of Object.values(report.graph?.min_actions_to_ending ?? {})) {
        expect(depth).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("keeps end.give reachable in three actions in v2, before disclosure", () => {
    const report = validateScene(
      SECOND_COPY_DISCOVERY_V2,
      SECOND_COPY_BRIEF,
      authorized,
    );
    expect(report.graph?.min_actions_to_ending["end.give"]).toBe(3);
  });

  it("finds a nonterminal choice that strictly reduces the reachable endings", () => {
    for (const scene of [
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V1,
      SECOND_COPY_DISCOVERY_V2,
    ]) {
      const report = validateScene(scene, SECOND_COPY_BRIEF, authorized);
      expect(report.graph?.ending_closing_edges).toBeGreaterThan(0);
    }
  });

  it("validates the base and every active-module subset", () => {
    for (const scene of [SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V2]) {
      const result = validateSceneSubsets(scene, SECOND_COPY_BRIEF, authorized);
      expect(result.subsets.map((entry) => entry.slots)).toEqual([[], ["discovery"]]);
      expect(result.ok).toBe(true);
    }
  });

  it("records that approval authority was not checked without an allowlist", () => {
    const report = validateScene(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF);
    expect(report.ok).toBe(true);
    expect(report.notes.join(" ")).toMatch(/approval authority was not checked/);
  });
});

describe("graph failures", () => {
  it("fails a repeatable action that makes no progress", () => {
    const scene = rawBase() as Mutable;
    scene.core.actions.push({
      id: "core.recheck",
      verb: "inspect",
      label: "Look again",
      target: { kind: "object", id: "letter" },
      when: { kind: "always" },
      branches: [
        {
          when: { kind: "always" },
          effects: [{ op: "set_true", var_id: "core.inspected" }],
          dialogue_id: null,
          ending_id: null,
        },
      ],
    });
    expect(codes(validateRaw(scene))).toContain("NO_PROGRESS");
  });

  it("fails a soft-lock where a reachable state can reach no ending", () => {
    const scene = rawBase() as Mutable;
    for (const id of ["core.give", "core.leave"]) {
      findAction(scene, id).when = whenFlags([
        ["core.inspected", true],
        ["core.context", true],
        ["core.promised", false],
      ]);
    }
    expect(codes(validateRaw(scene))).toContain("SOFTLOCK");
  });

  it("fails an unreachable ending and the dead action behind it", () => {
    const scene = rawBase() as Mutable;
    findAction(scene, "core.withhold").when = { kind: "never" };
    const found = codes(validateRaw(scene));
    expect(found).toContain("ENDING_UNREACHABLE");
    expect(found).toContain("DEAD_ACTION");
  });

  it("fails a branch that is never selected", () => {
    const scene = rawBase() as Mutable;
    const inspect = findAction(scene, "core.inspect");
    inspect.branches.push({
      when: { kind: "never" },
      effects: [{ op: "set_true", var_id: "core.context" }],
      dialogue_id: null,
      ending_id: null,
    });
    expect(codes(validateRaw(scene))).toContain("DEAD_BRANCH");
  });

  it("fails a decorative gate that never blocks, and reports no witness", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].gates[0].when = { kind: "always" };
    const found = codes(validateRaw(scene));
    expect(found).toContain("GATE_NEVER_BLOCKS");
    expect(found).toContain("MODULE_WITNESS_MISSING");
  });

  it("fails a hook that never fires", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].on_actions[0].when = { kind: "never" };
    expect(codes(validateRaw(scene))).toContain("DEAD_HOOK");
  });

  it("fails explicitly on a resource limit instead of reporting success", () => {
    const report = validateScene(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF, {
      ...authorized,
      explore: { maxStates: 3 },
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["VALIDATION_RESOURCE_LIMIT"]);
    expect(report.graph).toBeNull();
  });

  it("fails explicitly when the graph time ceiling is exhausted", () => {
    const report = validateScene(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF, {
      ...authorized,
      explore: { timeBudgetMs: -1 },
    });
    expect(codes(report)).toEqual(["VALIDATION_RESOURCE_LIMIT"]);
  });

  it("fails a witness search that overflows its pair bound", () => {
    const report = validateScene(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF, {
      ...authorized,
      witness: { maxPairs: 1 },
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("WITNESS_SEARCH_OVERFLOW");
  });
});

describe("ownership and authority", () => {
  it("rejects a module writing a core flag", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].on_actions[0].effects.push({
      op: "set_true",
      var_id: "core.promised",
    });
    expect(codes(validateRaw(scene))).toContain("FOREIGN_WRITE");
  });

  it("rejects a module reading or writing another slot's flag", () => {
    const base = rawV1() as Mutable;
    base.modules.push({
      slot: "commitment",
      approval_id: "approval_commitment_x",
      variables: [
        { id: "commitment.sure", label: "Sure", initial: false, visible: false },
      ],
      actions: [
        {
          id: "commitment.ask_more",
          verb: "ask",
          label: "Ask what she will accept",
          target: { kind: "character", id: "nia" },
          when: whenFlags([["commitment.sure", false]]),
          branches: [
            {
              when: { kind: "always" },
              effects: [{ op: "set_true", var_id: "commitment.sure" }],
              dialogue_id: null,
              ending_id: null,
            },
          ],
        },
      ],
      dialogue: [],
      gates: [],
      on_actions: [],
    });
    base.influences.push({
      approval_id: "approval_commitment_x",
      reference_id: "fixture_other",
      source_kind: "design_fixture",
      approved_text: "A second slot used only to prove isolation.",
      intended_effect: "No cross-slot access is permitted.",
    });
    base.provenance.push({
      approval_id: "approval_commitment_x",
      mechanic_ids: ["commitment.ask_more"],
    });

    const read = structuredClone(base) as Mutable;
    read.modules[1].actions[0].when = whenFlags([["discovery.disclosed", true]]);
    expect(codes(validateRaw(read))).toContain("CROSS_SLOT_READ");

    const write = structuredClone(base) as Mutable;
    write.modules[1].actions[0].branches[0].effects.push({
      op: "set_true",
      var_id: "discovery.disclosed",
    });
    expect(codes(validateRaw(write))).toContain("FOREIGN_WRITE");
  });

  it("rejects a gate or hook outside the slot's fixed port", () => {
    const gate = rawV1() as Mutable;
    gate.modules[0].gates[0].action_id = "core.withhold";
    expect(codes(validateRaw(gate))).toContain("GATE_PORT_INVALID");

    const hook = rawV1() as Mutable;
    hook.modules[0].on_actions[0].action_id = "core.ask_context";
    expect(codes(validateRaw(hook))).toContain("HOOK_PORT_INVALID");
  });

  it("rejects an altered attachment port table", () => {
    const scene = rawV1() as Mutable;
    scene.ports.discovery.gate_action_ids = ["core.give", "core.leave"];
    expect(codes(validateRaw(scene))).toContain("PORTS_ALTERED");
  });

  it("rejects a module action that ends the scene", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].actions[0].branches[0].ending_id = "end.give";
    expect(codes(validateRaw(scene))).toContain("MODULE_ACTION_TERMINATES");
  });

  it("rejects a module action using a terminal verb", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].actions[0].verb = "give";
    scene.modules[0].actions[0].target = { kind: "object", id: "letter" };
    expect(codes(validateRaw(scene))).toContain("MODULE_VERB_INVALID");
  });

  it("rejects definitions outside their namespace", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].variables[0].id = "core.smuggled";
    const found = codes(validateRaw(scene));
    expect(found).toContain("NAMESPACE_INVALID");
  });

  it("rejects an unresolved reference of every kind", () => {
    const ending = rawBase() as Mutable;
    findAction(ending, "core.give").branches[0].ending_id = "end.other";
    expect(codes(validateRaw(ending))).toContain("ENDING_UNRESOLVED");

    const dialogue = rawBase() as Mutable;
    findAction(dialogue, "core.inspect").branches[0].dialogue_id = "core.missing";
    expect(codes(validateRaw(dialogue))).toContain("DIALOGUE_UNRESOLVED");

    const variable = rawBase() as Mutable;
    findAction(variable, "core.inspect").when = whenFlags([["core.ghost", false]]);
    expect(codes(validateRaw(variable))).toContain("VAR_UNRESOLVED");

    const target = rawBase() as Mutable;
    findAction(target, "core.inspect").target = { kind: "object", id: "parcel" };
    expect(codes(validateRaw(target))).toContain("TARGET_UNRESOLVED");

    const speaker = rawBase() as Mutable;
    speaker.core.dialogue[1].speaker_id = "stranger";
    expect(codes(validateRaw(speaker))).toContain("SPEAKER_UNRESOLVED");

    const gateAction = rawV1() as Mutable;
    gateAction.modules[0].gates[0].action_id = "core.absent";
    expect(codes(validateRaw(gateAction))).toContain("GATE_ACTION_UNRESOLVED");
  });

  it("rejects a world id that collides with a reserved speaker", () => {
    let text = JSON.stringify(rawBase());
    text = text.replaceAll('"nia"', '"narrator"');
    const scene = JSON.parse(text) as Mutable;
    scene.world.characters[0].id = "narrator";
    const report = validateScene(parseScene(scene), SECOND_COPY_BRIEF, authorized);
    expect(codes(report)).toContain("RESERVED_SPEAKER_COLLISION");
  });

  it("rejects an unattached variable", () => {
    const unread = rawBase() as Mutable;
    unread.core.variables.push({
      id: "core.spare",
      label: "Spare flag",
      initial: false,
      visible: false,
    });
    findAction(unread, "core.inspect").branches[0].effects.push({
      op: "set_true",
      var_id: "core.spare",
    });
    expect(codes(validateRaw(unread))).toContain("VARIABLE_NEVER_READ");

    const unwritten = rawBase() as Mutable;
    unwritten.core.variables.push({
      id: "core.spare",
      label: "Spare flag",
      initial: false,
      visible: false,
    });
    findAction(unwritten, "core.leave").when = whenFlags([
      ["core.inspected", true],
      ["core.context", true],
      ["core.spare", false],
    ]);
    expect(codes(validateRaw(unwritten))).toContain("VARIABLE_NEVER_WRITTEN");
  });

  it("rejects a scene that tries to authorize its own approval", () => {
    const report = validateScene(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF, {
      approvedApprovalIds: ["approval_someone_else"],
    });
    expect(codes(report)).toContain("APPROVAL_NOT_AUTHORIZED");
  });

  it("rejects provenance that claims or omits the wrong mechanics", () => {
    const extra = rawV1() as Mutable;
    extra.provenance[0].mechanic_ids.push("core.give");
    expect(codes(validateRaw(extra))).toContain("PROVENANCE_UNRESOLVED");

    const missing = rawV1() as Mutable;
    missing.provenance[0].mechanic_ids = ["discovery.ask_identity"];
    expect(codes(validateRaw(missing))).toContain("PROVENANCE_INCOMPLETE");

    const orphan = rawV1() as Mutable;
    orphan.influences[0].approval_id = "approval_unknown";
    const found = codes(validateRaw(orphan));
    expect(found).toContain("ORPHAN_INFLUENCE");
    expect(found).toContain("APPROVAL_REFERENCE_INVALID");
  });

  it("rejects a world that drifts from the frozen brief", () => {
    const scene = rawBase() as Mutable;
    scene.world.characters[0].name = "Mira";
    expect(codes(validateRaw(scene))).toContain("BRIEF_MISMATCH");
  });

  it("reports forbidden wording as a literal match only", () => {
    const brief = parseBrief({ ...briefJson, forbidden_wording: ["sealed"] });
    const report = validateScene(SECOND_COPY_BASE, brief, authorized);
    expect(codes(report)).toContain("FORBIDDEN_WORDING");

    const unrelated = parseBrief({ ...briefJson, forbidden_wording: ["seal"] });
    const clean = validateScene(SECOND_COPY_BASE, unrelated, authorized);
    expect(codes(clean)).not.toContain("FORBIDDEN_WORDING");
  });

  it("reports a schema failure instead of attempting graph analysis", () => {
    const broken = { ...SECOND_COPY_BASE, schema_version: "2.0" } as unknown as Scene;
    const report = validateScene(broken, SECOND_COPY_BRIEF, authorized);
    expect(codes(report)).toEqual(["SCHEMA_INVALID"]);
    expect(report.graph).toBeNull();
  });
});
