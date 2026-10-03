import { describe, expect, it } from "vitest";
import { parseScene } from "../../src/domain/scene";
import {
  SECOND_COPY_BASE,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
} from "../../fixtures/second-copy";
import { viewOf } from "../../src/engine/compose";
import {
  availableActions,
  enabledActions,
  initialState,
  replay,
  step,
  trueFlags,
} from "../../src/engine/interpreter";
import { findAction, rawBase, rawV1, whenFlags, type Mutable } from "./helpers";

const ids = (scene: typeof SECOND_COPY_BASE, bits: number): string[] =>
  enabledActions(scene, { bits })
    .map((action) => action.action_id)
    .sort();

describe("transition semantics", () => {
  it("starts with every flag false", () => {
    const state = initialState(SECOND_COPY_DISCOVERY_V1);
    expect(state.bits).toBe(0);
    expect(trueFlags(viewOf(SECOND_COPY_DISCOVERY_V1), state)).toEqual([]);
  });

  it("offers only the two opening actions at the start", () => {
    expect(ids(SECOND_COPY_BASE, 0)).toEqual(["core.ask_context", "core.inspect"]);
    expect(ids(SECOND_COPY_DISCOVERY_V1, 0)).toEqual([
      "core.ask_context",
      "core.inspect",
    ]);
  });

  it("refuses an action whose own condition is false", () => {
    const result = step(SECOND_COPY_BASE, initialState(SECOND_COPY_BASE), "core.give");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_UNAVAILABLE");
  });

  it("refuses an unknown action id", () => {
    const result = step(SECOND_COPY_BASE, { bits: 0 }, "core.nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_ACTION");
  });

  it("applies set_true effects atomically and reports what became true", () => {
    const result = step(SECOND_COPY_DISCOVERY_V1, { bits: 0 }, "core.inspect");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One action, two owners: the core branch effect and the Discovery hook
    // effect commit together from the same pre-action state.
    expect([...result.set_true].sort()).toEqual([
      "core.inspected",
      "discovery.found",
    ]);
  });

  it("emits branch dialogue first, then owned hook dialogue", () => {
    const result = step(SECOND_COPY_DISCOVERY_V1, { bits: 0 }, "core.inspect");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dialogue.map((line) => line.dialogue_id)).toEqual([
      "core.inspect_text",
      "discovery.inspect_text",
    ]);
    expect(result.dialogue.map((line) => line.owner)).toEqual(["core", "discovery"]);
  });

  it("evaluates hook conditions against the pre-action state", () => {
    const scene = rawV1() as Mutable;
    // This hook may only fire while the flag it sets is still false, which is
    // only true before the write commits.
    scene.modules[0].on_actions[0].when = whenFlags([["discovery.found", false]]);
    const parsed = parseScene(scene);
    const result = step(parsed, { bits: 0 }, "core.inspect");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.set_true].sort()).toEqual([
      "core.inspected",
      "discovery.found",
    ]);
  });

  it("evaluates branch conditions against the pre-action state", () => {
    const scene = rawBase() as Mutable;
    const inspect = findAction(scene, "core.inspect");
    inspect.branches = [
      {
        when: whenFlags([["core.inspected", false]]),
        effects: [{ op: "set_true", var_id: "core.inspected" }],
        dialogue_id: "core.inspect_text",
        ending_id: null,
      },
      {
        when: whenFlags([["core.inspected", true]]),
        effects: [{ op: "set_true", var_id: "core.context" }],
        dialogue_id: "core.context_text",
        ending_id: null,
      },
    ];
    const parsed = parseScene(scene);
    const result = step(parsed, { bits: 0 }, "core.inspect");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The second branch would apply only to the post-action state; it must not.
    expect(result.set_true).toEqual(["core.inspected"]);
  });

  it("refuses an action when no branch or more than one branch applies", () => {
    const none = rawBase() as Mutable;
    findAction(none, "core.inspect").branches[0].when = { kind: "never" };
    const noneResult = step(parseScene(none), { bits: 0 }, "core.inspect");
    expect(noneResult.ok).toBe(false);
    if (!noneResult.ok) expect(noneResult.code).toBe("NO_APPLICABLE_BRANCH");

    const many = rawBase() as Mutable;
    const inspect = findAction(many, "core.inspect");
    inspect.branches = [
      structuredClone(inspect.branches[0]),
      structuredClone(inspect.branches[0]),
    ];
    const manyResult = step(parseScene(many), { bits: 0 }, "core.inspect");
    expect(manyResult.ok).toBe(false);
    if (!manyResult.ok) expect(manyResult.code).toBe("AMBIGUOUS_BRANCH");
  });

  it("never lets a module write a core flag even if the scene claims it does", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].on_actions[0].effects.push({
      op: "set_true",
      var_id: "core.promised",
    });
    const parsed = parseScene(scene);
    const result = step(parsed, { bits: 0 }, "core.inspect");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.set_true).not.toContain("core.promised");
  });

  it("resolves an ending and stops the run", () => {
    const run = replay(SECOND_COPY_BASE, [
      "core.inspect",
      "core.ask_context",
      "core.give",
    ]);
    expect(run.stopped_at).toBeNull();
    expect(run.ending?.id).toBe("end.give");
    expect(run.steps).toHaveLength(3);
  });

  it("reaches all three endings in the base", () => {
    expect(replay(SECOND_COPY_BASE, ["core.inspect", "core.ask_context", "core.give"]).ending?.id).toBe("end.give");
    expect(replay(SECOND_COPY_BASE, ["core.inspect", "core.ask_context", "core.withhold"]).ending?.id).toBe("end.keep");
    expect(replay(SECOND_COPY_BASE, ["core.inspect", "core.ask_context", "core.leave"]).ending?.id).toBe("end.leave");
  });

  it("closes the keep ending once the return is promised", () => {
    const run = replay(SECOND_COPY_BASE, [
      "core.inspect",
      "core.ask_context",
      "core.ask_terms",
    ]);
    expect(ids(SECOND_COPY_BASE, run.state.bits)).toEqual([
      "core.give",
      "core.leave",
    ]);
  });
});

describe("gate semantics: Gate.when is an allow condition", () => {
  const prefix = ["core.inspect", "core.ask_context"] as const;

  it("v1 locks the return until the contradiction has been discussed", () => {
    const before = replay(SECOND_COPY_DISCOVERY_V1, [...prefix]);
    const locked = availableActions(SECOND_COPY_DISCOVERY_V1, before.state).find(
      (action) => action.action_id === "core.give",
    );
    expect(locked?.enabled).toBe(false);
    expect(locked?.blocked?.gate_id).toBe("discovery.return_gate");
    expect(locked?.blocked?.slot).toBe("discovery");
    expect(locked?.blocked?.text).toMatch(/before returning the letter/i);

    const after = replay(SECOND_COPY_DISCOVERY_V1, [
      ...prefix,
      "discovery.ask_identity",
    ]);
    const unlocked = availableActions(SECOND_COPY_DISCOVERY_V1, after.state).find(
      (action) => action.action_id === "core.give",
    );
    expect(unlocked?.enabled).toBe(true);
  });

  it("v2 allows the return only while the contradiction has NOT been raised", () => {
    const before = replay(SECOND_COPY_DISCOVERY_V2, [...prefix]);
    const open = availableActions(SECOND_COPY_DISCOVERY_V2, before.state).find(
      (action) => action.action_id === "core.give",
    );
    expect(open?.enabled).toBe(true);

    const after = replay(SECOND_COPY_DISCOVERY_V2, [
      ...prefix,
      "discovery.ask_identity",
    ]);
    const closed = availableActions(SECOND_COPY_DISCOVERY_V2, after.state).find(
      (action) => action.action_id === "core.give",
    );
    expect(closed?.enabled).toBe(false);
    expect(closed?.blocked?.text).toMatch(/refused/i);
  });

  it("a gated action is refused by step, not silently executed", () => {
    const before = replay(SECOND_COPY_DISCOVERY_V1, [...prefix]);
    const result = step(SECOND_COPY_DISCOVERY_V1, before.state, "core.give");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ACTION_GATED");
      expect(result.blocked?.gate_id).toBe("discovery.return_gate");
    }
  });

  it("replay stops at the first action the version no longer allows", () => {
    const run = replay(SECOND_COPY_DISCOVERY_V2, [
      "core.inspect",
      "core.ask_context",
      "discovery.ask_identity",
      "core.give",
    ]);
    expect(run.stopped_at).toBe("core.give");
    expect(run.ending).toBeNull();
  });
});
