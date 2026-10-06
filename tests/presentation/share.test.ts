import { describe, expect, it } from "vitest";
import type { SceneVersionSummary } from "../../src/domain/compile";
import {
  shortVersion,
  slotsLabel,
  versionOptionLabel,
  whenLabel,
} from "../../src/presentation/share";

const version: SceneVersionSummary = {
  id: "9e3e4f60-7c8d-4ea0-9012-334455667788",
  parent_version_id: null,
  state: "active",
  created_at: "2026-10-04T18:22:00.000Z",
  base_hash: "a".repeat(64),
  module_hashes: {},
  active_slots: ["discovery"],
  model_identifier: null,
  compiler_identifier: null,
  validator_identifier: null,
  revision_label: null,
};

describe("share copy", () => {
  it("reads a version as what it is, keeping a short id to tell versions apart", () => {
    expect(versionOptionLabel(version)).toBe(
      "Current version · with Discovery · built 4 Oct 2026 · 9e3e4f60",
    );
    expect(versionOptionLabel({ ...version, state: "superseded", active_slots: [] })).toBe(
      "Earlier version · foundation only, no influence · built 4 Oct 2026 · 9e3e4f60",
    );
  });

  it("never shows a raw state word or slot id", () => {
    const label = versionOptionLabel({ ...version, active_slots: ["discovery", "commitment"] });
    expect(label).not.toMatch(/active|superseded|discovery|commitment/);
    expect(slotsLabel(["discovery", "commitment"])).toBe("with Discovery + Commitment");
  });

  it("falls back to the stored text for an unreadable date", () => {
    expect(whenLabel("not a date")).toBe("not a date");
    expect(shortVersion(version.id)).toBe("9e3e4f60");
  });
});
