import { describe, expect, it } from "vitest";

import { SECOND_COPY_BASE, SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import type { Brief } from "../../src/domain/brief";
import {
  buildBaseCompilationPayload,
  buildModuleCompilationPayload,
  buildRepairPayload,
  MAX_REPAIR_FINDINGS,
  payloadHash,
  serializeCompilerPayload,
  toBaseForModule,
} from "../../src/server/compile/payloads";
import {
  BASE_INSTRUCTIONS,
  moduleInstructions,
  REPAIR_NOTE_HEADING,
} from "../../src/server/compile/instructions";
import {
  ALL_SENTINELS,
  COMMITMENT_APPROVAL_PAYLOAD,
  DISCOVERY_APPROVAL_PAYLOAD,
  SENTINELS,
  SENTINELS_FORBIDDEN_IN_COMMITMENT,
  SENTINELS_FORBIDDEN_IN_DISCOVERY,
} from "./support/compile-fixtures";

/**
 * The Phase 4 half of the context firewall (specification section 7).
 *
 * These tests inspect the bytes that would actually leave this application:
 * `serializeCompilerPayload` produces the model input, so a sentinel absent
 * from that string is absent from the request. They are deliberately about
 * **dataflow**, not semantics: none of them claims a model could not
 * independently invent a similar idea from the brief alone.
 */

/** A brief carrying the artist query, so the base payload has a real chance to leak it. */
const CONTAMINATED_BRIEF: Brief = {
  ...SECOND_COPY_BRIEF,
  cultural_anchor_query: SENTINELS.artist,
};

function bytesOf(payload: unknown): string {
  return serializeCompilerPayload(payload);
}

describe("the base compilation payload", () => {
  it("takes the brief and nothing else", () => {
    // One parameter is the mechanism. The arity is the assertion.
    expect(buildBaseCompilationPayload.length).toBe(1);
  });

  it("carries exactly the frozen brief fields the foundation needs", () => {
    const payload = buildBaseCompilationPayload(SECOND_COPY_BRIEF);
    expect(payload.stage).toBe("base");
    expect(Object.keys(payload).sort()).toEqual(["brief", "stage"]);
    expect(payload.brief.premise).toBe(SECOND_COPY_BRIEF.premise);
    expect(payload.brief.room.id).toBe(SECOND_COPY_BRIEF.room.id);
    expect(payload.brief.character.name).toBe(SECOND_COPY_BRIEF.character.name);
    expect(payload.brief.object.name).toBe(SECOND_COPY_BRIEF.object.name);
    expect(payload.brief.tone).toBe(SECOND_COPY_BRIEF.tone);
  });

  it("drops the artist query even when the brief holds one", () => {
    const bytes = bytesOf(buildBaseCompilationPayload(CONTAMINATED_BRIEF));
    expect(bytes).not.toContain(SENTINELS.artist);
    expect(bytes).not.toContain("cultural_anchor_query");
  });

  it("excludes every cultural sentinel", () => {
    const bytes = bytesOf(buildBaseCompilationPayload(CONTAMINATED_BRIEF));
    for (const sentinel of ALL_SENTINELS) {
      expect(bytes, `base payload leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("names no reference, proposal, approval, evidence, or slot anywhere", () => {
    const bytes = bytesOf(buildBaseCompilationPayload(CONTAMINATED_BRIEF)).toLowerCase();
    for (const word of [
      "qloo",
      "artist",
      "reference",
      "proposal",
      "approval",
      "approved",
      "evidence",
      "discovery",
      "commitment",
      "influence",
      "capture",
      "affinity",
    ]) {
      expect(bytes, `base payload mentions ${word}`).not.toContain(word);
    }
  });

  it("is stable, so the same brief reuses the same frozen base input", () => {
    const first = payloadHash(buildBaseCompilationPayload(SECOND_COPY_BRIEF));
    const second = payloadHash(buildBaseCompilationPayload(SECOND_COPY_BRIEF));
    expect(first).toBe(second);
    // A different brief is a different foundation.
    expect(
      payloadHash(
        buildBaseCompilationPayload({ ...SECOND_COPY_BRIEF, tone: "wry" }),
      ),
    ).not.toBe(first);
    // Changing only the artist query cannot change the base input, because the
    // base never saw it. That is why a new approval does not regenerate a base.
    expect(payloadHash(buildBaseCompilationPayload(CONTAMINATED_BRIEF))).toBe(first);
  });

  it("has fixed instructions that mention no cultural material", () => {
    const lowered = BASE_INSTRUCTIONS.toLowerCase();
    for (const word of ["qloo", "artist", "reference", "approval", "evidence", "influence"]) {
      expect(lowered, `base instructions mention ${word}`).not.toContain(word);
    }
    for (const sentinel of ALL_SENTINELS) {
      expect(BASE_INSTRUCTIONS).not.toContain(sentinel);
    }
  });
});

describe("the module compilation payload", () => {
  const base = {
    title: SECOND_COPY_BASE.title,
    world: SECOND_COPY_BASE.world,
    core: SECOND_COPY_BASE.core,
  };

  it("takes the clean base and one approval", () => {
    const payload = buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD);
    expect(Object.keys(payload).sort()).toEqual([
      "approved_interaction",
      "base",
      "forbidden_wording",
      "slot",
      "stage",
    ]);
    expect(payload.slot).toBe("discovery");
  });

  it("takes its slot from the approval, so a caller cannot mismatch them", () => {
    expect(buildModuleCompilationPayload(base, COMMITMENT_APPROVAL_PAYLOAD).slot).toBe(
      "commitment",
    );
    expect(
      buildModuleCompilationPayload(base, COMMITMENT_APPROVAL_PAYLOAD).base.ports,
    ).toEqual({
      gate_action_ids: ["core.ask_terms", "core.withhold"],
      effect_action_ids: ["core.ask_context"],
    });
  });

  it("shows one slot only its own two attachment points", () => {
    const discovery = buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD);
    expect(discovery.base.ports).toEqual({
      gate_action_ids: ["core.give"],
      effect_action_ids: ["core.inspect"],
    });
    const bytes = bytesOf(discovery);
    expect(bytes).not.toContain("commitment");
  });

  it("excludes every sentinel the Discovery stage must not see", () => {
    const bytes = bytesOf(buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD));
    for (const sentinel of SENTINELS_FORBIDDEN_IN_DISCOVERY) {
      expect(bytes, `discovery payload leaked ${sentinel}`).not.toContain(sentinel);
    }
    // Its own approval is exactly what it is supposed to receive.
    expect(bytes).toContain(SENTINELS.discoveryApproval);
  });

  it("excludes every sentinel the Commitment stage must not see", () => {
    const bytes = bytesOf(buildModuleCompilationPayload(base, COMMITMENT_APPROVAL_PAYLOAD));
    for (const sentinel of SENTINELS_FORBIDDEN_IN_COMMITMENT) {
      expect(bytes, `commitment payload leaked ${sentinel}`).not.toContain(sentinel);
    }
    expect(bytes).toContain(SENTINELS.commitmentApproval);
  });

  it("carries no approval id, capture id, entity UUID, rank, or affinity", () => {
    const bytes = bytesOf(buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD));
    expect(bytes).not.toContain(DISCOVERY_APPROVAL_PAYLOAD.approval_id);
    // The cited evidence ids are present, because the approval cited them and
    // the module must be able to say which excerpt it drew from. Everything
    // the server owns is not.
    for (const key of [
      "approval_id",
      "capture_id",
      "entity_id",
      "original_rank",
      "affinity",
      "request_fingerprint",
      "source_kind",
      "proposal_id",
    ]) {
      expect(bytes, `module payload exposes ${key}`).not.toContain(key);
    }
  });

  it("carries only the evidence the approval cited", () => {
    const payload = buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD);
    expect(payload.approved_interaction.evidence.map((item) => item.id)).toEqual(
      DISCOVERY_APPROVAL_PAYLOAD.evidence.map((item) => item.id),
    );
  });

  it("shows the base structurally, with no composed module or provenance", () => {
    const view = toBaseForModule(
      SECOND_COPY_BASE.title,
      SECOND_COPY_BASE.world,
      SECOND_COPY_BASE.core,
      "discovery",
    );
    const bytes = bytesOf(view);
    for (const key of [
      "modules",
      "influences",
      "provenance",
      "scene_id",
      "schema_version",
      "approval",
      "ending_copy_overrides",
    ]) {
      expect(bytes, `base view exposes ${key}`).not.toContain(key);
    }
    // Ending wording is withheld: a module may not rewrite an ending.
    expect(view.endings.map((ending) => ending.id).sort()).toEqual([
      "end.give",
      "end.keep",
      "end.leave",
    ]);
    expect(bytes).not.toContain(SECOND_COPY_BASE.core.endings[0]!.text);
  });

  it("has per-slot instructions that never name the other slot", () => {
    expect(moduleInstructions("discovery")).not.toContain("commitment");
    expect(moduleInstructions("commitment")).not.toContain("discovery");
    for (const slot of ["discovery", "commitment"] as const) {
      for (const sentinel of ALL_SENTINELS) {
        expect(moduleInstructions(slot)).not.toContain(sentinel);
      }
    }
  });

  it("gives the two slots different frozen inputs", () => {
    expect(
      payloadHash(buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD)),
    ).not.toBe(payloadHash(buildModuleCompilationPayload(base, COMMITMENT_APPROVAL_PAYLOAD)));
  });

  it("is independent of the other slot's approval", () => {
    // Nothing about the other approval is a parameter, so there is no call
    // through which it could change this slot's frozen input.
    const before = payloadHash(buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD));
    buildModuleCompilationPayload(base, COMMITMENT_APPROVAL_PAYLOAD);
    const after = payloadHash(buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD));
    expect(after).toBe(before);
  });
});

describe("the repair payload", () => {
  const base = {
    title: SECOND_COPY_BASE.title,
    world: SECOND_COPY_BASE.world,
    core: SECOND_COPY_BASE.core,
  };

  it("passes the original context through unchanged", () => {
    const original = buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD);
    const repair = buildRepairPayload(original, { variables: [] }, [
      { code: "MODULE_WITNESS_MISSING", detail: "no observable difference" },
    ]);
    // Identity, not a rebuilt copy: there is no path by which a field could
    // have been added on the way in.
    expect(repair.context).toBe(original);
    expect(payloadHash(repair.context)).toBe(payloadHash(original));
  });

  it("does not widen the information boundary", () => {
    const original = buildModuleCompilationPayload(base, DISCOVERY_APPROVAL_PAYLOAD);
    const repair = buildRepairPayload(original, { gates: [] }, [
      { code: "GATE_PORT_INVALID", detail: "discovery may not gate core.ask_terms" },
    ]);
    const bytes = bytesOf(repair);
    for (const sentinel of SENTINELS_FORBIDDEN_IN_DISCOVERY) {
      expect(bytes, `repair payload leaked ${sentinel}`).not.toContain(sentinel);
    }
    expect(Object.keys(repair).sort()).toEqual([
      "context",
      "findings",
      "rejected_output",
      "stage",
    ]);
  });

  it("keeps the base repair brief-only", () => {
    const original = buildBaseCompilationPayload(CONTAMINATED_BRIEF);
    const bytes = bytesOf(
      buildRepairPayload(original, { title: "x" }, [
        { code: "CORE_ACTION_MISSING", detail: 'the base must declare "core.ask_terms"' },
      ]),
    );
    for (const sentinel of ALL_SENTINELS) {
      expect(bytes, `base repair leaked ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("carries the failed candidate and bounded findings", () => {
    const repair = buildRepairPayload(
      buildBaseCompilationPayload(SECOND_COPY_BRIEF),
      { title: "a candidate" },
      Array.from({ length: 30 }, (_value, index) => ({
        code: `CODE_${index}`,
        detail: `detail ${index}`,
      })),
    );
    expect(repair.rejected_output).toEqual({ title: "a candidate" });
    expect(repair.findings).toHaveLength(MAX_REPAIR_FINDINGS);
  });

  it("drops an oversized candidate rather than truncating it", () => {
    const huge = { blob: "x".repeat(20 * 1024) };
    const repair = buildRepairPayload(
      buildBaseCompilationPayload(SECOND_COPY_BRIEF),
      huge,
      [{ code: "SCHEMA_INVALID", detail: "too large" }],
    );
    expect(repair.rejected_output).toBeNull();
  });

  it("has a repair heading that grants no new capability", () => {
    const lowered = REPAIR_NOTE_HEADING.toLowerCase();
    for (const word of ["retrieve", "fetch", "search", "approval", "brief", "qloo"]) {
      expect(lowered, `repair heading mentions ${word}`).not.toContain(word);
    }
  });
});
