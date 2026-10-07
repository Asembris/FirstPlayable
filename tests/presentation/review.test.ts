import { describe, expect, it } from "vitest";
import provenanceJson from "../../docs/phase6-canonical-pair/provenance.json";
import withInfluenceJson from "../../docs/phase6-canonical-pair/with-influence.version.json";
import withoutInfluenceJson from "../../docs/phase6-canonical-pair/without-influence.version.json";
import { SECOND_COPY_BRIEF, SECOND_COPY_DISCOVERY_V1 } from "../../fixtures/second-copy";
import { PlayableViewSchema } from "../../src/domain/compile";
import type { PlayableView } from "../../src/domain/compile";
import { ApprovedInfluenceSchema } from "../../src/domain/influence";
import type { ApprovedInfluence } from "../../src/domain/influence";
import { parseScene } from "../../src/domain/scene";
import {
  allEndingsReachable,
  buildStatusOf,
  observationsOf,
  sceneApprovalIdOf,
  sceneCarries,
} from "../../src/presentation/review";
import type { Phrase } from "../../src/presentation/rehearsal";
import { verifyCandidate } from "../../src/server/compile/verify";
import { sceneChangedFrom } from "../../src/server/db/versions";

/**
 * The creator-side review model, against the stored Halcyon Relay build (synthetic demonstration).
 *
 * The with-influence version row is exactly what the review screen receives for a
 * candidate build, so every expectation is read back from it.
 */

const withScene = parseScene(withInfluenceJson.scene);
const withoutScene = parseScene(withoutInfluenceJson.scene);
const witness = withInfluenceJson.validation_summary.witnesses[0]!;
const snapshot = withInfluenceJson.approval_snapshot[0]!;
const discovery = withInfluenceJson.scene.modules[0]!;

/** The stored row, in the shape the project read hands the review screen. */
const candidate: PlayableView = PlayableViewSchema.parse({
  version_id: withInfluenceJson.id,
  state: "pending",
  created_at: withInfluenceJson.created_at,
  scene: withInfluenceJson.scene,
  validation: withInfluenceJson.validation_summary,
  scene_changed: [
    {
      approval_id: witness.approval_id,
      slot: witness.slot,
      mechanic_ids: withInfluenceJson.scene.provenance[0]!.mechanic_ids,
      witness,
    },
  ],
  diff: null,
});

/** The creator's approval, as the project read reports it. */
const approval: ApprovedInfluence = ApprovedInfluenceSchema.parse({
  approval_id: provenanceJson.decision.id,
  slot: snapshot.slot,
  reference_id: snapshot.reference_id,
  entity_id: provenanceJson.reference.entity_id,
  reference_name: snapshot.reference_name,
  domain: snapshot.domain,
  capture_id: provenanceJson.capture.id,
  selected_evidence_ids: snapshot.selected_evidence_ids,
  approved_text: snapshot.approved_text,
  intended_effect: snapshot.intended_effect,
  proposed_idea: snapshot.proposed_idea,
  proposed_interaction: provenanceJson.decision.proposal_snapshot.proposal.intended_interaction,
  proposed_relevance: provenanceJson.decision.proposal_snapshot.proposal.relevance,
  edited_by_creator: snapshot.edited_by_creator,
  source_kind: "qloo",
  project_revision: provenanceJson.decision.proposal_snapshot.project_revision,
  predecessor_id: null,
  approved_at: snapshot.approved_at,
});

const label = (id: string) =>
  [...withInfluenceJson.scene.core.actions, ...discovery.actions].find((action) => action.id === id)!.label;
const text = (phrase: Phrase | null) =>
  (phrase ?? []).map((part) => (typeof part === "string" ? part : part.em)).join("");

describe("where an approval stands", () => {
  it("maps an approval to the scene id the compiler wrote, exactly", () => {
    expect(sceneApprovalIdOf(approval.approval_id)).toBe(discovery.approval_id);
    expect(sceneApprovalIdOf(approval.approval_id)).toBe(snapshot.scene_approval_id);
  });

  it("is not built until a build carries it, and approval alone changes nothing", () => {
    expect(buildStatusOf(approval, { pending: null, active: null })).toBe("not-built");
    // The Without version is the same scene with this approval removed.
    expect(sceneCarries(withoutScene, approval)).toBe(false);
    expect(buildStatusOf(approval, { pending: null, active: withoutScene })).toBe("not-built");
  });

  it("is awaiting review while only the candidate carries it, and current only once active", () => {
    expect(buildStatusOf(approval, { pending: withScene, active: null })).toBe("awaiting-review");
    expect(buildStatusOf(approval, { pending: withScene, active: withoutScene })).toBe("awaiting-review");
    expect(buildStatusOf(approval, { pending: null, active: withScene })).toBe("current");
  });

  it("never matches an approval by its wording alone", () => {
    const sameWords = { ...approval, approval_id: "11111111-1111-4111-8111-111111111111" };
    expect(buildStatusOf(sameWords, { pending: withScene, active: withScene })).toBe("not-built");
  });
});

describe("intended vs observed for the stored Halcyon Relay build", () => {
  const [observation, ...others] = observationsOf(candidate, [approval]);

  it("reports one influence, named from the approval", () => {
    expect(others).toEqual([]);
    expect(observation!.slot).toBe("discovery");
    expect(observation!.influenceName).toBe("Halcyon Relay");
  });

  it("keeps the intended effect and the interpretation exactly as compiled", () => {
    expect(observation!.intendedEffect).toBe(snapshot.intended_effect);
    expect(observation!.approvedText).toBe(snapshot.approved_text);
    expect(snapshot.approved_text.startsWith(observation!.approvedHead.head)).toBe(true);
  });

  it("observes exactly the stored diff's changed choices after the witness's prefix", () => {
    expect(observation!.prefixLabels).toEqual(witness.prefix.map(label));
    expect(observation!.rows.map((row) => row.id).sort()).toEqual(
      [...withoutInfluenceJson.revision_diff.replay.changed_action_ids].sort(),
    );
    expect(observation!.rows).toEqual([
      { id: "core.give", label: label("core.give"), reading: "locked" },
      { id: "discovery.action_1", label: label("discovery.action_1"), reading: "added" },
      { id: "discovery.action_2", label: label("discovery.action_2"), reading: "added" },
    ]);
  });

  it("quotes both stored requirements on the locked choice, verbatim", () => {
    expect(observation!.requirements).toEqual([
      { label: label("core.give"), texts: discovery.gates.map((gate) => gate.blocked_text) },
    ]);
  });

  it("puts the observation in player words, never the raw witness sentence", () => {
    const sentence = text(observation!.phrase);
    expect(sentence).toBe(
      `After the same two choices, ${label("core.give")} is locked with Halcyon Relay and open without it. ` +
        `With Halcyon Relay, two choices are added, and ${label("core.give")} needs both.`,
    );
    expect(sentence).not.toBe(witness.sentence);
    expect(sentence).not.toMatch(/core\.|discovery\.|approval\./);
  });

  it("states that all endings stay reachable only because the validator says so", () => {
    expect(allEndingsReachable(candidate)).toBe(true);
    const fewer = { ...candidate, validation: { ...candidate.validation, reachable_endings: ["end.give"] } };
    expect(allEndingsReachable(fewer)).toBe(false);
  });
});

describe("a build the approval list cannot name", () => {
  it("falls back to 'this influence' and still observes the change at its witness", () => {
    const scene = SECOND_COPY_DISCOVERY_V1;
    const verdict = verifyCandidate(scene, SECOND_COPY_BRIEF, ["approval_discovery_v1"]);
    if (!verdict.ok) throw new Error("the design fixture must verify");
    const fixture: PlayableView = {
      ...candidate,
      scene,
      validation: verdict.summary,
      scene_changed: sceneChangedFrom(scene, verdict.summary),
    };
    const [observation] = observationsOf(fixture, []);
    expect(observation!.influenceName).toBe("this influence");
    expect(observation!.rows.length).toBeGreaterThan(0);
    expect(observation!.phrase).not.toBeNull();
  });

  it("observes nothing for a foundation-only build", () => {
    expect(observationsOf({ ...candidate, scene: withoutScene, scene_changed: [] }, [approval])).toEqual([]);
  });
});
