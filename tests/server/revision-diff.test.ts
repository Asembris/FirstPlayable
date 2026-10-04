import { describe, expect, it } from "vitest";

import {
  CANONICAL_REPLAY_PREFIX,
  SECOND_COPY_BASE,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
} from "../../fixtures/second-copy";
import { RevisionDiffViewSchema } from "../../src/domain/revision";
import type { Scene } from "../../src/domain/scene";
import { parseScene } from "../../src/domain/scene";
import { sceneHashes } from "../../src/engine/diff";
import { preserved } from "../../src/server/revision/recompose";
import { revisionDiffView } from "../../src/server/revision/diff";
import {
  creatorEditId,
  previewHash,
  readEndingCopyOverrides,
  withOverride,
} from "../../src/server/revision/overrides";

const V1 = { versionId: "11111111-1111-4111-8111-111111111111", scene: SECOND_COPY_DISCOVERY_V1 };
const V2 = { versionId: "22222222-2222-4222-8222-222222222222", scene: SECOND_COPY_DISCOVERY_V2 };
const BASE = { versionId: "33333333-3333-4333-8333-333333333333", scene: SECOND_COPY_BASE };

/** The same scene with one ending reworded through a creator override. */
function withKinderEnding(scene: Scene): Scene {
  const ending = scene.core.endings[0]!;
  const text = `${ending.text} She thanks you, and means it.`;
  return parseScene({
    ...scene,
    ending_copy_overrides: [
      { ending_id: ending.id, text, creator_edit_id: creatorEditId(ending.id, text) },
    ],
  });
}

describe("the stored revision diff is the engine's own comparison", () => {
  it("satisfies its own contract for the canonical influence revision", () => {
    const diff = revisionDiffView({ before: V1, after: V2, changedBy: "edit" });
    expect(diff).not.toBeNull();
    expect(RevisionDiffViewSchema.safeParse(diff).success).toBe(true);
  });

  it("labels the canonical same-prefix divergence mechanical", () => {
    const diff = revisionDiffView({ before: V1, after: V2, changedBy: "edit" })!;
    expect(diff.label).toBe("mechanical");
    expect(diff.mechanical_change).toBe(true);
    expect(diff.wording_change_only).toBe(false);
    // The replay it stored is a legal prefix in both versions, and the action
    // whose availability moved is named by the diff rather than by prose.
    expect(diff.replay).not.toBeNull();
    expect(diff.replay!.prefix_legal_in_before).toBe(true);
    expect(diff.replay!.prefix_legal_in_after).toBe(true);
    expect(diff.changed_slots).toEqual(["discovery"]);
  });

  it("preserves the world, the core and the ports across that revision", () => {
    const diff = revisionDiffView({ before: V1, after: V2, changedBy: "edit" })!;
    expect(diff.unchanged.world).toBe(true);
    expect(diff.unchanged.core).toBe(true);
    expect(diff.unchanged.ports).toBe(true);
    // And the hashes it reports are the engine's, not a restatement.
    expect(diff.hashes.before_scene).toBe(sceneHashes(V1.scene).scene);
    expect(diff.hashes.after_scene).toBe(sceneHashes(V2.scene).scene);
  });

  it("records the canonical replay prefix when the caller supplies one", () => {
    const diff = revisionDiffView({
      before: V1,
      after: V2,
      changedBy: "edit",
      replayPrefix: CANONICAL_REPLAY_PREFIX,
    })!;
    expect(diff.replay!.prefix).toEqual([...CANONICAL_REPLAY_PREFIX]);
    // The witness of the canonical revision: the same three choices leave
    // `core.give` available in v1 and unavailable in v2.
    expect(diff.replay!.before["core.give"]).toBe("enabled");
    expect(diff.replay!.after["core.give"]).not.toBe("enabled");
    expect(diff.replay!.changed_action_ids).toContain("core.give");
  });

  it("reports a removal as the module and its bindings disappearing", () => {
    const diff = revisionDiffView({ before: V1, after: BASE, changedBy: "remove" })!;
    expect(diff.changed_slots).toEqual(["discovery"]);
    expect(diff.unchanged.world).toBe(true);
    expect(diff.unchanged.core).toBe(true);
    expect(diff.unchanged.ports).toBe(true);
    expect(diff.unchanged.modules.discovery).toBe(false);
    expect(diff.removed_action_ids.length).toBeGreaterThan(0);
    expect(diff.added_action_ids).toEqual([]);
    expect(diff.changed_by).toBe("remove");
  });

  it("calls a reworded ending a wording change and never a mechanical one", () => {
    const after = { versionId: V2.versionId, scene: withKinderEnding(V1.scene) };
    const diff = revisionDiffView({ before: V1, after, changedBy: "ending_copy_apply" })!;
    expect(diff.label).toBe("wording");
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(true);
    expect(diff.structure_identical).toBe(true);
    expect(diff.summary[0]).toBe("Wording changed; interaction unchanged.");
    expect(diff.copy_only_changes.map((change) => change.ending_id)).toEqual([
      V1.scene.core.endings[0]!.id,
    ]);
    // Every mechanical object is byte-identical, including the module.
    expect(diff.unchanged.world).toBe(true);
    expect(diff.unchanged.core).toBe(true);
    expect(diff.unchanged.ports).toBe(true);
    expect(diff.unchanged.modules.discovery).toBe(true);
  });

  it("reports no comparison at all for a first version", () => {
    expect(revisionDiffView({ before: null, after: V1, changedBy: null })).toBeNull();
  });

  it("keeps the summary within the three lines the product shows", () => {
    for (const pair of [
      { before: V1, after: V2, changedBy: "edit" as const },
      { before: V1, after: BASE, changedBy: "remove" as const },
    ]) {
      const diff = revisionDiffView(pair)!;
      expect(diff.summary.length).toBeGreaterThan(0);
      expect(diff.summary.length).toBeLessThanOrEqual(3);
      expect(diff.summary[diff.summary.length - 1]).toContain("Fixed details preserved");
    }
  });
});

describe("preservation is a refusal, not a report", () => {
  it("accepts a removal that leaves the untouched slot alone", () => {
    const diff = revisionDiffView({ before: V1, after: BASE, changedBy: "remove" })!;
    // Nothing survives in this fixture pair, so nothing has to be preserved.
    expect(preserved(diff, [])).toBe(true);
    // And the slot that was removed cannot be claimed as preserved.
    expect(preserved(diff, ["discovery"])).toBe(false);
  });

  it("accepts a wording change that keeps every module byte-identical", () => {
    const after = { versionId: V2.versionId, scene: withKinderEnding(V1.scene) };
    const diff = revisionDiffView({ before: V1, after, changedBy: "ending_copy_apply" })!;
    expect(preserved(diff, ["discovery"])).toBe(true);
  });

  it("refuses anything that moved the world, the core or the ports", () => {
    const retitled = parseScene({
      ...V1.scene,
      world: {
        ...V1.scene.world,
        room: { ...V1.scene.world.room, name: "A different room entirely" },
      },
    });
    const diff = revisionDiffView({
      before: V1,
      after: { versionId: V2.versionId, scene: retitled },
      changedBy: "ending_copy_apply",
    })!;
    expect(diff.unchanged.world).toBe(false);
    expect(preserved(diff, [])).toBe(false);
  });
});

describe("ending-copy overrides", () => {
  it("drops a stored entry that no longer satisfies the scene contract", () => {
    const good = {
      ending_id: "end.give",
      text: "A kinder close.",
      creator_edit_id: creatorEditId("end.give", "A kinder close."),
    };
    expect(readEndingCopyOverrides([good])).toEqual([good]);
    expect(readEndingCopyOverrides([{ ending_id: "end.give" }])).toEqual([]);
    expect(readEndingCopyOverrides([{ ...good, extra: true }])).toEqual([]);
    expect(readEndingCopyOverrides("not an array")).toEqual([]);
    expect(readEndingCopyOverrides(null)).toEqual([]);
  });

  it("keeps one override per ending, whatever the stored order", () => {
    const first = { ending_id: "end.give", text: "One.", creator_edit_id: creatorEditId("end.give", "One.") };
    const second = { ending_id: "end.give", text: "Two.", creator_edit_id: creatorEditId("end.give", "Two.") };
    expect(readEndingCopyOverrides([first, second])).toEqual([first]);
    expect(withOverride([first], second)).toEqual([second]);
    expect(withOverride([first], { ending_id: "end.give", remove: true })).toEqual([]);
  });

  it("stays inside the three-override budget", () => {
    const many = ["end.give", "end.keep", "end.leave", "end.extra"].map((id) => ({
      ending_id: id,
      text: `Close ${id}.`,
      creator_edit_id: creatorEditId(id, `Close ${id}.`),
    }));
    expect(readEndingCopyOverrides(many)).toHaveLength(3);
  });

  it("derives a stable edit id and preview hash from the wording itself", () => {
    expect(creatorEditId("end.give", "same")).toBe(creatorEditId("end.give", "same"));
    expect(creatorEditId("end.give", "same")).not.toBe(creatorEditId("end.keep", "same"));
    expect(previewHash("end.give", "same")).toBe(previewHash("end.give", "same"));
    expect(previewHash("end.give", "same")).not.toBe(previewHash("end.give", "other"));
    // A scene identifier, so it uses the identifier alphabet.
    expect(creatorEditId("end.give", "same")).toMatch(/^edit\.[0-9a-f]{24}$/);
  });
});
