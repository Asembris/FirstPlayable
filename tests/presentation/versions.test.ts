import { describe, expect, it } from "vitest";
import withInfluenceJson from "../../docs/phase6-canonical-pair/with-influence.version.json";
import withoutInfluenceJson from "../../docs/phase6-canonical-pair/without-influence.version.json";
import { parseScene } from "../../src/domain/scene";
import { compareVersions } from "../../src/presentation/versions";

/**
 * The studio's previous-against-current rows, on the stored removal of
 * Halcyon Relay: the active version carried Halcyon Relay, the revision removed it.
 */

const withInfluence = parseScene(withInfluenceJson.scene);
const withoutInfluence = parseScene(withoutInfluenceJson.scene);
const recorded = withoutInfluenceJson.revision_diff.replay!.prefix;

describe("removing Halcyon Relay, at the stored replay point", () => {
  const comparison = compareVersions(withInfluence, withoutInfluence, recorded);

  it("names the choices by their labels", () => {
    expect(comparison.prefixLabels).toEqual(["Ask Nia why she needs it back", "Examine the letter"]);
    expect(comparison.stoppedAt).toBeNull();
  });

  it("finds exactly the three changes the stored diff recorded", () => {
    const changed = comparison.rows.filter((row) => row.kind !== "unchanged").map((row) => row.id);
    expect(changed.sort()).toEqual(
      [...withoutInfluenceJson.revision_diff.replay!.changed_action_ids].sort(),
    );
    expect(comparison.changedCount).toBe(3);
    expect(comparison.unchangedCount).toBe(3);
  });

  it("names both requirements where Return was locked, and its ending where it opens", () => {
    const give = comparison.rows.find((row) => row.id === "core.give")!;
    expect(give.kind).toBe("changed");
    expect(give.previous.note).toBe(
      "Locked · needs: ask Nia who the other name belongs to, and examine the envelope closely",
    );
    expect(give.current.note).toMatch(/^Open · ends the scene: /);
  });

  it("says a removed action is not in this version, and keeps unchanged rows single", () => {
    const removed = comparison.rows.filter((row) => row.kind === "removed");
    expect(removed).toHaveLength(2);
    for (const row of removed) {
      expect(row.previous.note).toBe("Open");
      expect(row.current.note).toBe("Not in this version");
    }
    // This version's actions come first, in scene order; removed ones follow.
    expect(comparison.rows.slice(-2).map((row) => row.kind)).toEqual(["removed", "removed"]);
  });
});

describe("adding Halcyon Relay back", () => {
  it("marks the module's actions as added in this version", () => {
    const comparison = compareVersions(withoutInfluence, withInfluence, recorded);
    const added = comparison.rows.filter((row) => row.kind === "added");
    expect(added).toHaveLength(2);
    for (const row of added) {
      expect(row.previous.note).toBe("Not in this version");
      expect(row.current.note).toBe("Added in this version · open now");
    }
  });
});

describe("a choice the previous version does not have", () => {
  it("stops, names the choice, and claims no change it could not observe", () => {
    const moduleAction = withInfluenceJson.scene.modules[0]!.actions[0]!;
    const comparison = compareVersions(withoutInfluence, withInfluence, ["core.inspect", moduleAction.id]);
    expect(comparison.stoppedAt).toEqual({ id: moduleAction.id, label: moduleAction.label });
    expect(comparison.changedCount).toBe(0);
    for (const row of comparison.rows) {
      expect(row.previous.note).toBe("Replay stopped before this point");
    }
  });
});
