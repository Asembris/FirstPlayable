import { describe, expect, it } from "vitest";
import {
  SECOND_COPY_BASE,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
} from "../../fixtures/second-copy";
import type { Scene } from "../../src/domain/scene";
import {
  cleanBase,
  composeScene,
  moduleSubsets,
  removeModule,
  viewOf,
} from "../../src/engine/compose";
import { canonicalJson, hashCanonical } from "../../src/engine/hash";
import { sceneHashes } from "../../src/engine/diff";

const withoutSceneId = (scene: Scene): string => {
  const { scene_id: _id, ...rest } = scene;
  return canonicalJson(rest);
};

describe("composer", () => {
  it("does not mutate its inputs", () => {
    const coreBefore = canonicalJson(SECOND_COPY_DISCOVERY_V1.core);
    const modulesBefore = canonicalJson(SECOND_COPY_DISCOVERY_V1.modules);
    const overridesBefore = canonicalJson(
      SECOND_COPY_DISCOVERY_V1.ending_copy_overrides,
    );
    composeScene(
      SECOND_COPY_DISCOVERY_V1.core,
      SECOND_COPY_DISCOVERY_V1.modules,
      SECOND_COPY_DISCOVERY_V1.ending_copy_overrides,
    );
    expect(canonicalJson(SECOND_COPY_DISCOVERY_V1.core)).toBe(coreBefore);
    expect(canonicalJson(SECOND_COPY_DISCOVERY_V1.modules)).toBe(modulesBefore);
    expect(canonicalJson(SECOND_COPY_DISCOVERY_V1.ending_copy_overrides)).toBe(
      overridesBefore,
    );
  });

  it("keeps ownership attached to every composed definition", () => {
    const view = viewOf(SECOND_COPY_DISCOVERY_V1);
    expect(view.variableOwner.get("core.inspected")).toBe("core");
    expect(view.variableOwner.get("discovery.found")).toBe("discovery");
    expect(view.actionById.get("discovery.ask_identity")?.owner).toBe("discovery");
    expect(view.activeSlots).toEqual(["discovery"]);
  });

  it("orders variables core-first, then modules in fixed slot order", () => {
    const view = viewOf(SECOND_COPY_DISCOVERY_V1);
    expect(view.variables.map((entry) => entry.variable.id)).toEqual([
      "core.inspected",
      "core.context",
      "core.promised",
      "discovery.found",
      "discovery.disclosed",
    ]);
  });

  it("applies an ending copy override to that ending's text only", () => {
    const overridden: Scene = {
      ...SECOND_COPY_BASE,
      ending_copy_overrides: [
        {
          ending_id: "end.keep",
          text: "You keep the letter for one more night, and say so plainly.",
          creator_edit_id: "edit_kinder_keep",
        },
      ],
    };
    const view = viewOf(overridden);
    expect(view.endingById.get("end.keep")?.text).toMatch(/one more night/);
    expect(view.endingById.get("end.give")?.text).toBe(
      viewOf(SECOND_COPY_BASE).endingById.get("end.give")?.text,
    );
  });

  it("removing Discovery recomposes the exact clean base", () => {
    for (const scene of [SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V2]) {
      const removed = removeModule(scene, "discovery");
      expect(removed.modules).toEqual([]);
      expect(withoutSceneId(removed)).toBe(withoutSceneId(SECOND_COPY_BASE));
    }
  });

  it("removing a module drops its influence and provenance records", () => {
    const stripped = cleanBase(SECOND_COPY_DISCOVERY_V1);
    expect(stripped.influences).toEqual([]);
    expect(stripped.provenance).toEqual([]);
  });

  it("enumerates the base-first module subsets", () => {
    expect(moduleSubsets(SECOND_COPY_DISCOVERY_V1)).toEqual([[], ["discovery"]]);
    expect(moduleSubsets(SECOND_COPY_BASE)).toEqual([[]]);
  });
});

describe("hashes", () => {
  it("keeps world, core, and ports identical across all three versions", () => {
    const [base, v1, v2] = [
      sceneHashes(SECOND_COPY_BASE),
      sceneHashes(SECOND_COPY_DISCOVERY_V1),
      sceneHashes(SECOND_COPY_DISCOVERY_V2),
    ];
    expect(new Set([base.world, v1.world, v2.world]).size).toBe(1);
    expect(new Set([base.core, v1.core, v2.core]).size).toBe(1);
    expect(new Set([base.ports, v1.ports, v2.ports]).size).toBe(1);
  });

  it("gives the two Discovery modules different hashes", () => {
    expect(sceneHashes(SECOND_COPY_DISCOVERY_V1).modules.discovery).not.toBe(
      sceneHashes(SECOND_COPY_DISCOVERY_V2).modules.discovery,
    );
  });

  it("is insensitive to key order and stable across calls", () => {
    expect(hashCanonical({ a: 1, b: [2, 3] })).toBe(hashCanonical({ b: [2, 3], a: 1 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });
});
