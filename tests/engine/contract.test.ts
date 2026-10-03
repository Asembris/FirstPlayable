import { describe, expect, it } from "vitest";
import { parseBrief } from "../../src/domain/brief";
import { parseScene, safeParseScene } from "../../src/domain/scene";
import { rawV1, findAction, type Mutable } from "./helpers";
import briefJson from "../../fixtures/second_copy.brief.json";

const reject = (scene: unknown): readonly string[] => {
  const result = safeParseScene(scene);
  expect(result.ok, "expected the strict contract to reject this scene").toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
};

describe("scene contract", () => {
  it("accepts the canonical fixture", () => {
    expect(parseScene(rawV1()).scene_id).toBe("fixture_second_copy_v1");
  });

  it("rejects unknown fields at the root and nested", () => {
    reject({ ...rawV1(), surprise: true });
    const nested = rawV1() as Mutable;
    nested.world.room.colour = "blue";
    reject(nested);
    const inAction = rawV1() as Mutable;
    findAction(inAction, "core.inspect").priority = 1;
    reject(inAction);
  });

  it("rejects verbs outside the fixed vocabulary", () => {
    const scene = rawV1() as Mutable;
    findAction(scene, "core.inspect").verb = "attack";
    reject(scene);
  });

  it("rejects a verb pointed at the wrong entity kind", () => {
    const scene = rawV1() as Mutable;
    // `ask` must target the NPC, never the room.
    findAction(scene, "core.ask_context").target = { kind: "room", id: "counter" };
    reject(scene);
  });

  it("rejects identifiers outside the id grammar", () => {
    for (const bad of ["Core.inspect", "9lives", "core inspect", "core/inspect", ""]) {
      const scene = rawV1() as Mutable;
      findAction(scene, "core.inspect").id = bad;
      reject(scene);
    }
  });

  it("rejects expression strings and executable conditions", () => {
    const scene = rawV1() as Mutable;
    findAction(scene, "core.inspect").when = "core.inspected == false";
    reject(scene);
    const fn = rawV1() as Mutable;
    findAction(fn, "core.inspect").when = { kind: "js", source: "() => true" };
    reject(fn);
  });

  it("rejects malformed conditions", () => {
    const empty = rawV1() as Mutable;
    findAction(empty, "core.inspect").when = { kind: "any", clauses: [] };
    reject(empty);

    const tooMany = rawV1() as Mutable;
    findAction(tooMany, "core.inspect").when = {
      kind: "any",
      clauses: Array.from({ length: 5 }, () => [
        { var_id: "core.inspected", equals: false },
      ]),
    };
    reject(tooMany);

    const contradictory = rawV1() as Mutable;
    findAction(contradictory, "core.inspect").when = {
      kind: "any",
      clauses: [
        [
          { var_id: "core.inspected", equals: false },
          { var_id: "core.inspected", equals: true },
        ],
      ],
    };
    reject(contradictory);

    const duplicate = rawV1() as Mutable;
    findAction(duplicate, "core.inspect").when = {
      kind: "any",
      clauses: [
        [
          { var_id: "core.inspected", equals: false },
          { var_id: "core.inspected", equals: false },
        ],
      ],
    };
    reject(duplicate);
  });

  it("rejects every effect other than set_true", () => {
    for (const op of ["set_false", "toggle", "increment", "decrement"]) {
      const scene = rawV1() as Mutable;
      findAction(scene, "core.inspect").branches[0].effects = [
        { op, var_id: "core.inspected" },
      ];
      reject(scene);
    }
  });

  it("rejects a variable that does not start false", () => {
    const scene = rawV1() as Mutable;
    scene.core.variables[0].initial = true;
    reject(scene);
  });

  it("rejects over-budget state and actions", () => {
    const coreVars = rawV1() as Mutable;
    coreVars.core.variables = Array.from({ length: 7 }, (_, index) => ({
      id: `core.v${index}`,
      label: `Flag ${index}`,
      initial: false,
      visible: false,
    }));
    reject(coreVars);

    const moduleVars = rawV1() as Mutable;
    moduleVars.modules[0].variables = Array.from({ length: 4 }, (_, index) => ({
      id: `discovery.v${index}`,
      label: `Flag ${index}`,
      initial: false,
      visible: false,
    }));
    reject(moduleVars);

    const coreActions = rawV1() as Mutable;
    coreActions.core.actions = Array.from({ length: 11 }, (_, index) => ({
      ...structuredClone(findAction(rawV1() as Mutable, "core.inspect")),
      id: `core.a${index}`,
    }));
    reject(coreActions);

    const moduleActions = rawV1() as Mutable;
    const template = structuredClone(moduleActions.modules[0].actions[0]);
    moduleActions.modules[0].actions = Array.from({ length: 5 }, (_, index) => ({
      ...structuredClone(template),
      id: `discovery.a${index}`,
    }));
    reject(moduleActions);
  });

  it("rejects more than three branches on one action", () => {
    const scene = rawV1() as Mutable;
    const action = findAction(scene, "core.inspect");
    action.branches = Array.from({ length: 4 }, () =>
      structuredClone(action.branches[0]),
    );
    reject(scene);
  });

  it("rejects a second NPC and anything other than three endings", () => {
    const twoNpcs = rawV1() as Mutable;
    twoNpcs.world.characters.push({ id: "other", name: "Other", role: "Extra" });
    reject(twoNpcs);

    const fourEndings = rawV1() as Mutable;
    fourEndings.core.endings.push({
      id: "end.extra",
      title: "Extra",
      text: "One more ending.",
    });
    reject(fourEndings);
  });

  it("rejects oversized text fields", () => {
    const scene = rawV1() as Mutable;
    findAction(scene, "core.inspect").label = "x".repeat(91);
    reject(scene);

    const dialogue = rawV1() as Mutable;
    dialogue.core.dialogue[0].text = "x".repeat(601);
    reject(dialogue);
  });

  it("rejects control characters in narrative strings", () => {
    const scene = rawV1() as Mutable;
    scene.core.dialogue[0].text = "A line\u0007with a bell";
    reject(scene);
  });

  it("rejects more than one module per slot", () => {
    const scene = rawV1() as Mutable;
    scene.modules.push(structuredClone(scene.modules[0]));
    reject(scene);
  });
});

describe("brief contract", () => {
  it("accepts the canonical brief and keeps no retrieval claim", () => {
    const brief = parseBrief(briefJson);
    expect(brief.cultural_anchor_query).toBeNull();
    expect(brief.tone).toBe("intimate");
  });

  it("rejects a premise outside the declared bounds", () => {
    expect(() => parseBrief({ ...briefJson, premise: "too short" })).toThrow();
    expect(() =>
      parseBrief({ ...briefJson, premise: "x".repeat(601) }),
    ).toThrow();
  });

  it("rejects unknown brief fields", () => {
    expect(() => parseBrief({ ...briefJson, audience: "teens" })).toThrow();
  });
});
