import { describe, expect, it } from "vitest";
import {
  CANONICAL_REPLAY_PREFIX,
  SECOND_COPY_BASE,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
} from "../../fixtures/second-copy";
import { parseScene } from "../../src/domain/scene";
import type { Scene } from "../../src/domain/scene";
import {
  compareVersions,
  findMechanicalWitness,
  mechanicalSignature,
  observeReplayPrefix,
} from "../../src/engine/diff";
import { hashCanonical } from "../../src/engine/hash";
import { rawV1, type Mutable } from "./helpers";

describe("canonical same-prefix replay", () => {
  const observation = observeReplayPrefix(
    SECOND_COPY_DISCOVERY_V1,
    SECOND_COPY_DISCOVERY_V2,
    CANONICAL_REPLAY_PREFIX,
  );

  it("uses the prefix from the specification", () => {
    expect(CANONICAL_REPLAY_PREFIX).toEqual([
      "core.inspect",
      "core.ask_context",
      "discovery.ask_identity",
    ]);
    expect(observation.prefix_legal_in_before).toBe(true);
    expect(observation.prefix_legal_in_after).toBe(true);
  });

  it("makes core.give available in v1 and unavailable in v2", () => {
    expect(observation.before["core.give"]).toBe("enabled");
    expect(observation.after["core.give"]).toBe("locked");
  });

  it("changes nothing else about the available choices", () => {
    expect(observation.changed_action_ids).toEqual(["core.give"]);
    for (const id of ["core.ask_terms", "core.withhold", "core.leave"]) {
      expect(observation.before[id]).toBe("enabled");
      expect(observation.after[id]).toBe("enabled");
    }
  });
});

describe("mechanical versus wording changes", () => {
  it("calls the v1 to v2 revision mechanical and preserves the foundation", () => {
    const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V2, {
      replayPrefix: CANONICAL_REPLAY_PREFIX,
    });
    expect(diff.mechanical_change).toBe(true);
    expect(diff.wording_change_only).toBe(false);
    expect(diff.unchanged.world).toBe(true);
    expect(diff.unchanged.core).toBe(true);
    expect(diff.unchanged.ports).toBe(true);
    expect(diff.changed_slots).toEqual(["discovery"]);
    expect(diff.changed_gate_bindings.map((change) => change.gate_id)).toEqual([
      "discovery.return_gate",
    ]);
    expect(diff.summary[0]).toContain("core.give");
  });

  it("does not call an ending wording edit mechanical", () => {
    const kinder: Scene = {
      ...SECOND_COPY_DISCOVERY_V1,
      scene_id: "fixture_second_copy_v1_kinder",
      ending_copy_overrides: [
        {
          ending_id: "end.keep",
          text: "You keep the letter tonight, and you tell her so plainly.",
          creator_edit_id: "edit_kinder_keep",
        },
      ],
    };
    const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, kinder);
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(true);
    expect(diff.structure_identical).toBe(true);
    expect(diff.copy_only_changes.map((change) => change.ending_id)).toEqual([
      "end.keep",
    ]);
    expect(diff.summary[0]).toBe("Wording changed; interaction unchanged.");
  });

  it("does not call changed dialogue prose mechanical", () => {
    const scene = rawV1() as Mutable;
    scene.scene_id = "fixture_second_copy_v1_prose";
    scene.core.dialogue[0].text =
      "The envelope is sealed. She watches your hands, not your face.";
    scene.modules[0].dialogue[1].text =
      "Both names are mine. Ask which promise I can keep tonight.";
    const edited = parseScene(scene);
    const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, edited);
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(true);
    expect(diff.structure_identical).toBe(true);
    expect(hashCanonical(mechanicalSignature(SECOND_COPY_DISCOVERY_V1))).toBe(
      hashCanonical(mechanicalSignature(edited)),
    );
  });

  it("does not call a consistently renamed flag mechanical", () => {
    const renamed = parseScene(
      JSON.parse(
        JSON.stringify(rawV1()).replaceAll("discovery.disclosed", "discovery.spoken"),
      ),
    );
    const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, renamed);
    // The signature necessarily differs, which is exactly why the replay
    // witness, not the signature, decides.
    expect(diff.structure_identical).toBe(false);
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(true);
  });

  it("does not call a changed provenance label mechanical", () => {
    const scene = rawV1() as Mutable;
    scene.scene_id = "fixture_second_copy_v1_relabelled";
    scene.influences[0].reference_id = "fixture_other_reference";
    scene.influences[0].approved_text =
      "A different wording of the same approved interpretation.";
    const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, parseScene(scene));
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(true);
  });

  it("reports no change when the versions are identical", () => {
    const diff = compareVersions(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_DISCOVERY_V1);
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(false);
    expect(diff.summary[0]).toBe("No change.");
  });
});

describe("module present versus absent", () => {
  it("proves a mechanical witness for Discovery v1", () => {
    const witness = findMechanicalWitness(
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V1,
    );
    expect(witness.mechanical).toBe(true);
    expect(witness.overflow).toBe(false);
    const availability = witness.observations.find(
      (observation) => observation.kind === "action_availability",
    );
    expect(availability?.action_id).toBe("core.give");
  });

  it("proves a mechanical witness for Discovery v2 through the added action", () => {
    const witness = findMechanicalWitness(
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V2,
    );
    expect(witness.mechanical).toBe(true);
    // In v2 the gate only closes after the module's own action, so the
    // traversal has to follow the introduced action to its consequence.
    expect(
      witness.observations.some(
        (observation) =>
          observation.kind === "action_availability" &&
          observation.action_id === "core.give" &&
          observation.prefix.includes("discovery.ask_identity"),
      ),
    ).toBe(true);
  });

  it("reports the introduced action as a structural change, not as the witness", () => {
    const witness = findMechanicalWitness(
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V1,
    );
    const added = witness.observations.find(
      (observation) => observation.kind === "action_set",
    );
    expect(added?.action_id).toBe("discovery.ask_identity");
    expect(added?.before).toBe("absent");
  });

  it("reports overflow rather than claiming no difference", () => {
    const witness = findMechanicalWitness(
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V2,
      { maxPairs: 1 },
    );
    expect(witness.overflow).toBe(true);
  });

  it("finds no witness for a module that only adds prose", () => {
    const scene = rawV1() as Mutable;
    scene.modules[0].gates = [];
    scene.modules[0].actions[0].when = { kind: "any", clauses: [[{ var_id: "discovery.found", equals: true }, { var_id: "discovery.disclosed", equals: false }]] };
    scene.provenance[0].mechanic_ids = [
      "discovery.ask_identity",
      "discovery.inspect_hook",
    ];
    const proseOnlyModule = parseScene(scene);
    const witness = findMechanicalWitness(SECOND_COPY_BASE, proseOnlyModule);
    expect(witness.mechanical).toBe(false);
    expect(witness.overflow).toBe(false);
  });
});
