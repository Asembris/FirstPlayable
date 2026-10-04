import { describe, expect, it } from "vitest";

import type { ProjectStateResponse } from "../../src/domain/compile";
import type { RevisionResponse } from "../../src/domain/revision";
import { handleAdvance, handleActivate, handleCompile } from "../../src/server/api/compile";
import { handleRevision } from "../../src/server/api/revisions";
import { ERROR_CODES } from "../../src/server/security/errors";
import { sceneHashes } from "../../src/engine/diff";
import { availableActions, initialState, step } from "../../src/engine/interpreter";
import { body, envelope, mutation, owner, readRequest } from "./support/phase3-harness";
import {
  activeProject,
  type ActiveProject,
  happyCompiler,
  readState,
} from "./support/phase5-harness";
import { fakeCompiler, type FakeCompiler } from "./support/fake-compiler";
import {
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./support/compile-fixtures";

/**
 * `POST /api/projects/:id/revisions`, driven end to end offline.
 *
 * Every test runs the real handler, the real decision primitive, the real
 * composer, the real Phase 1 validator, the real diff engine, and the in-memory
 * gateway that re-implements the committed SQL. Only the provider is scripted,
 * and most of these tests assert that it was never reached at all.
 */

async function revise(
  state: ActiveProject,
  command: Record<string, unknown>,
  revision?: number,
): Promise<Response> {
  const read = revision === undefined ? await readState(state) : null;
  return handleRevision(
    mutation(`/api/projects/${state.projectId}/revisions`, {
      cookie: state.cookie,
      body: JSON.stringify({
        expected_revision: revision ?? read!.project.revision,
        ...command,
      }),
    }),
    state.deps,
    state.projectId,
  );
}

/** An ending-copy script that returns a kinder version of the fixture's close. */
function copyCompiler(text: string): FakeCompiler {
  return fakeCompiler({ endingCopy: [{ output: { text } }] });
}

const KINDER =
  "She takes the letter back and holds it for a moment. Whatever it cost her to ask, she does not make you carry it.";

describe("remove: the revision that costs nothing", () => {
  it("drops one module, recomposes, and makes zero provider calls", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const compiler = state.deps.compiler as FakeCompiler;
    const callsBefore = compiler.calls();

    const response = await revise(state, { kind: "remove", slot: "commitment" });
    expect(response.status).toBe(200);
    const revised = await body<RevisionResponse>(response);

    expect(revised.outcome).toBe("version_pending");
    expect(revised.model_calls).toBe(0);
    expect(compiler.calls()).toBe(callsBefore);
    expect(revised.pending_version_id).not.toBeNull();
    expect(revised.project.approved_slots).toEqual(["discovery"]);
    // The previous version is untouched and is still the active one.
    expect(revised.last_good_version_id).toBe(state.versionId);
  });

  it("preserves the world, the core, the ports, and the surviving module", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const before = await readState(state);
    const beforeHashes = sceneHashes(before.playable!.scene);

    const revised = await body<RevisionResponse>(
      await revise(state, { kind: "remove", slot: "commitment" }),
    );
    const diff = revised.diff!;

    expect(diff.changed_by).toBe("remove");
    expect(diff.unchanged.world).toBe(true);
    expect(diff.unchanged.core).toBe(true);
    expect(diff.unchanged.ports).toBe(true);
    expect(diff.unchanged.modules.discovery).toBe(true);
    expect(diff.unchanged.modules.commitment).toBe(false);
    expect(diff.removed_action_ids.length).toBeGreaterThan(0);
    expect(diff.added_action_ids).toEqual([]);

    // And the hashes it reports are the engine's own, over the real scenes.
    const after = await readState(state);
    const afterHashes = sceneHashes(after.playable!.scene);
    expect(diff.hashes.before_scene).toBe(beforeHashes.scene);
    expect(diff.hashes.after_scene).toBe(afterHashes.scene);
    expect(afterHashes.world).toBe(beforeHashes.world);
    expect(afterHashes.core).toBe(beforeHashes.core);
    expect(afterHashes.modules.discovery).toBe(beforeHashes.modules.discovery);
    expect(afterHashes.modules.commitment).toBeUndefined();
  });

  it("keeps the previous version playable while the revision awaits review", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    await revise(state, { kind: "remove", slot: "commitment" });
    const read = await readState(state);

    // The pending revision is what is offered, and the version it revised is
    // sent beside it, so the comparison runs locally.
    expect(read.playable?.state).toBe("pending");
    expect(read.previous_playable?.version_id).toBe(state.versionId);
    expect(read.project.active_version_id).toBe(state.versionId);

    // Both sides are playable through the engine with no further request.
    for (const side of [read.playable!.scene, read.previous_playable!.scene]) {
      let bits = initialState(side);
      const first = availableActions(side, bits).find((action) => action.enabled);
      const result = step(side, bits, first!.action_id);
      expect(result.ok).toBe(true);
      if (result.ok) bits = result.state;
      expect(bits.bits).not.toBe(0);
    }
  });

  it("leaves the base playable and exportable when the last influence goes", async () => {
    const state = await activeProject(["discovery"]);
    const response = await revise(state, { kind: "remove", slot: "discovery" });
    expect(response.status).toBe(200);
    const revised = await body<RevisionResponse>(response);

    expect(revised.outcome).toBe("version_pending");
    expect(revised.project.approved_slots).toEqual([]);
    const read = await readState(state);
    expect(read.playable?.scene.modules).toEqual([]);
    expect(read.playable?.scene.influences).toEqual([]);
    expect(read.playable?.scene.provenance).toEqual([]);
    expect(read.playable?.validation.ok).toBe(true);
    // No active grounding badge, and the historical version keeps its own.
    expect(read.previous_playable?.scene.influences).toHaveLength(1);
  });

  it("refuses an empty slot without touching anything", async () => {
    const state = await activeProject(["discovery"]);
    const response = await revise(state, { kind: "remove", slot: "commitment" });
    expect(response.status).toBe(422);
    const failure = await envelope(response);
    expect(failure.code).toBe(ERROR_CODES.REQUEST_REFUSED);
    expect(failure.message).toContain("SLOT_EMPTY");
    expect(failure.last_good_version_id).toBe(state.versionId);
    const read = await readState(state);
    expect(read.project.approved_slots).toEqual(["discovery"]);
    expect(read.playable?.state).toBe("active");
  });

  it("cannot compose two versions from a double-clicked command", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const read = await readState(state);
    const [first, second] = await Promise.all([
      revise(state, { kind: "remove", slot: "commitment" }, read.project.revision),
      revise(state, { kind: "remove", slot: "commitment" }, read.project.revision),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 429]);
    // One new version, not two.
    expect(state.h.gateway.versions).toHaveLength(2);
  });
});

describe("edit and replace: one immutable approval, one slot recompiled", () => {
  it("appends a replacement approval and asks for a compilation", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const compiler = state.deps.compiler as FakeCompiler;
    const callsBefore = compiler.calls();

    const response = await revise(state, {
      kind: "edit",
      slot: "discovery",
      approved_text:
        "Inspecting the letter shows a second name, and the keeper will not take it back until that name is spoken aloud.",
      intended_effect: "Inspection unlocks a question; that question unlocks the return.",
    });
    expect(response.status).toBe(200);
    const revised = await body<RevisionResponse>(response);

    expect(revised.outcome).toBe("requires_compilation");
    expect(revised.model_calls).toBe(0);
    expect(compiler.calls()).toBe(callsBefore);
    expect(revised.decision_id).not.toBeNull();
    expect(revised.pending_version_id).toBeNull();

    // History is append-only: the displaced approval is the predecessor.
    const decisions = state.h.gateway.decisions;
    const latest = decisions[decisions.length - 1]!;
    expect(latest.decision_kind).toBe("replace");
    expect(latest.slot).toBe("discovery");
    expect(latest.predecessor_id).not.toBeNull();
    // And the active version is still the one the creator confirmed.
    expect(revised.last_good_version_id).toBe(state.versionId);
  });

  it("recompiles only the slot that moved, and reuses the rest", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const before = await readState(state);
    const beforeHashes = sceneHashes(before.playable!.scene);

    await revise(state, {
      kind: "edit",
      slot: "discovery",
      approved_text:
        "Inspecting the letter shows a second name, and the keeper will not take it back until that name is spoken aloud.",
      intended_effect: "Inspection unlocks a question; that question unlocks the return.",
    });

    // One scripted module answer, and one only: a second would throw.
    const recompiler = fakeCompiler({ module: [{ output: validDiscoveryOutput() }] });
    const recompiled: ActiveProject = {
      ...state,
      deps: { ...state.deps, compiler: recompiler },
    };
    const read = await readState(recompiled);
    const created = await handleCompile(
      mutation(`/api/projects/${state.projectId}/compile`, {
        cookie: state.cookie,
        body: JSON.stringify({ expected_revision: read.project.revision }),
      }),
      recompiled.deps,
      state.projectId,
    );
    expect(created.status).toBe(201);
    const operationId = (await body<{ status: { operation_id: string } }>(created)).status
      .operation_id;
    for (let index = 0; index < 8; index += 1) {
      const advanced = await handleAdvance(
        mutation(`/api/operations/${operationId}/advance`, {
          cookie: state.cookie,
          body: "{}",
        }),
        recompiled.deps,
        operationId,
      );
      const status = (await body<{ status: { next_stage: string | null; failure: unknown } }>(
        advanced,
      )).status;
      expect(status.failure).toBeNull();
      if (status.next_stage === null) break;
    }

    // Exactly one provider call: the base was reused and so was commitment.
    expect(recompiler.calls()).toBe(1);
    expect(recompiler.requests[0]?.schemaName).toBe("firstplayable_scene_module");

    const after = await readState(recompiled);
    const afterHashes = sceneHashes(after.playable!.scene);
    expect(afterHashes.core).toBe(beforeHashes.core);
    expect(afterHashes.world).toBe(beforeHashes.world);
    expect(afterHashes.modules.commitment).toBe(beforeHashes.modules.commitment);
    // The revised slot's module is bound to the new approval, so it moved.
    expect(afterHashes.modules.discovery).not.toBe(beforeHashes.modules.discovery);
    expect(after.playable?.diff?.changed_slots).toEqual(["discovery"]);
  });

  it("refuses an edit of a slot that holds no approval", async () => {
    const state = await activeProject(["discovery"]);
    const response = await revise(state, {
      kind: "edit",
      slot: "commitment",
      approved_text: "Something new entirely.",
      intended_effect: "It should change the commitment.",
    });
    expect(response.status).toBe(422);
  });

  it("refuses creator wording the brief forbids", async () => {
    const state = await activeProject(["discovery"]);
    const read = await readState(state);
    const forbidden = read.project.brief.forbidden_wording[0];
    if (forbidden === undefined) return;
    const response = await revise(state, {
      kind: "edit",
      slot: "discovery",
      approved_text: `This uses ${forbidden} deliberately.`,
      intended_effect: "It should be refused.",
    });
    expect(response.status).toBe(422);
  });

  it("refuses evidence the frozen proposal did not cite", async () => {
    const state = await activeProject(["discovery"]);
    const response = await revise(state, {
      kind: "edit",
      slot: "discovery",
      approved_text: "A different reading of the same cited excerpt.",
      intended_effect: "Inspection unlocks a question.",
      selected_evidence_ids: ["ref.mv.somebody-else#ev9"],
    });
    expect(response.status).toBe(422);
  });
});

describe("ending copy: a wording change, labelled as one", () => {
  it("previews one ending with exactly one provider call, and applies nothing", async () => {
    const state = await activeProject(["discovery"]);
    const compiler = copyCompiler(KINDER);
    const previewing: ActiveProject = { ...state, deps: { ...state.deps, compiler } };
    const read = await readState(state);
    const endingId = read.playable!.scene.core.endings[0]!.id;

    const response = await revise(previewing, {
      kind: "ending_copy_preview",
      ending_id: endingId,
      request: "Make this ending kinder to her.",
    });
    expect(response.status).toBe(200);
    const previewed = await body<RevisionResponse>(response);

    expect(previewed.outcome).toBe("preview");
    expect(previewed.model_calls).toBe(1);
    expect(compiler.calls()).toBe(1);
    expect(previewed.preview?.proposed_text).toBe(KINDER);
    expect(previewed.preview?.wording_only).toBe(true);
    expect(previewed.pending_version_id).toBeNull();
    // A preview applies nothing: the active version is untouched.
    const after = await readState(state);
    expect(after.playable?.version_id).toBe(state.versionId);
    expect(after.playable?.scene.ending_copy_overrides).toEqual([]);
  });

  /**
   * The payload isolation of section 9, asserted on what would actually have
   * been sent: the frozen brief, that ending's wording, and the request. No
   * module, no evidence, no approval, no other ending.
   */
  it("sends the ending's own wording and nothing cultural", async () => {
    const state = await activeProject(["discovery"]);
    const compiler = copyCompiler(KINDER);
    const previewing: ActiveProject = { ...state, deps: { ...state.deps, compiler } };
    const read = await readState(state);
    const scene = read.playable!.scene;
    const endingId = scene.core.endings[0]!.id;

    await revise(previewing, {
      kind: "ending_copy_preview",
      ending_id: endingId,
      request: "Make this ending kinder to her.",
    });

    const sent = compiler.requests[0]!;
    expect(sent.schemaName).toBe("firstplayable_ending_copy");
    const payload = sent.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["brief", "ending", "request", "stage"]);
    const serialized = JSON.stringify(payload);

    // Nothing cultural, and nothing from another slot or another ending.
    const approval = read.project.approvals[0]!;
    for (const forbidden of [
      approval.reference_name,
      approval.approved_text,
      approval.entity_id,
      approval.proposed_idea,
      scene.core.endings[1]!.text,
      scene.core.endings[2]!.text,
      scene.modules[0]!.actions[0]!.label,
    ]) {
      expect(serialized.includes(forbidden), `the payload carried ${forbidden}`).toBe(false);
    }
    // The artist query is not in the brief a compiler sees, and never was.
    expect(serialized.includes("cultural_anchor_query")).toBe(false);
    // What it does carry: this ending's base and current wording.
    const ending = payload["ending"] as Record<string, string>;
    expect(ending["base_text"]).toBe(scene.core.endings[0]!.text);
    expect(ending["current_text"]).toBe(scene.core.endings[0]!.text);
  });

  it("applies the previewed wording with no provider call, as a wording change", async () => {
    const state = await activeProject(["discovery"]);
    const compiler = copyCompiler(KINDER);
    const working: ActiveProject = { ...state, deps: { ...state.deps, compiler } };
    const read = await readState(state);
    const beforeHashes = sceneHashes(read.playable!.scene);
    const endingId = read.playable!.scene.core.endings[0]!.id;

    const previewed = await body<RevisionResponse>(
      await revise(working, {
        kind: "ending_copy_preview",
        ending_id: endingId,
        request: "Make this ending kinder to her.",
      }),
    );
    const callsAfterPreview = compiler.calls();

    const response = await revise(working, {
      kind: "ending_copy_apply",
      ending_id: endingId,
      text: previewed.preview!.proposed_text,
      preview_hash: previewed.preview!.preview_hash,
    });
    expect(response.status).toBe(200);
    const applied = await body<RevisionResponse>(response);

    expect(applied.outcome).toBe("version_pending");
    expect(applied.model_calls).toBe(0);
    expect(compiler.calls()).toBe(callsAfterPreview);

    const diff = applied.diff!;
    expect(diff.label).toBe("wording");
    expect(diff.mechanical_change).toBe(false);
    expect(diff.wording_change_only).toBe(true);
    expect(diff.structure_identical).toBe(true);
    expect(diff.summary[0]).toBe("Wording changed; interaction unchanged.");
    expect(diff.copy_only_changes.map((change) => change.ending_id)).toEqual([endingId]);

    // Every mechanical object came through byte-identical.
    const after = await readState(working);
    const afterHashes = sceneHashes(after.playable!.scene);
    expect(afterHashes.core).toBe(beforeHashes.core);
    expect(afterHashes.world).toBe(beforeHashes.world);
    expect(afterHashes.ports).toBe(beforeHashes.ports);
    expect(afterHashes.modules.discovery).toBe(beforeHashes.modules.discovery);
    // And exactly one ending's text changed, in the composed view.
    expect(after.playable?.scene.ending_copy_overrides).toHaveLength(1);
    expect(after.playable?.scene.ending_copy_overrides[0]?.ending_id).toBe(endingId);
    expect(after.playable?.scene.core.endings[0]?.text).toBe(
      read.playable?.scene.core.endings[0]?.text,
    );
  });

  it("refuses wording that was never previewed", async () => {
    const state = await activeProject(["discovery"]);
    const read = await readState(state);
    const endingId = read.playable!.scene.core.endings[0]!.id;
    const response = await revise(state, {
      kind: "ending_copy_apply",
      ending_id: endingId,
      text: "Wording the creator typed, which no preview produced.",
      // A correctly computed hash is still not a preview.
      preview_hash: "0".repeat(48),
    });
    expect(response.status).toBe(422);
    const after = await readState(state);
    expect(after.playable?.scene.ending_copy_overrides).toEqual([]);
  });

  it("refuses an ending the scene does not declare", async () => {
    const state = await activeProject(["discovery"]);
    const compiler = copyCompiler(KINDER);
    const working: ActiveProject = { ...state, deps: { ...state.deps, compiler } };
    const response = await revise(working, {
      kind: "ending_copy_preview",
      ending_id: "end.not-a-real-ending",
      request: "Make this ending kinder.",
    });
    expect(response.status).toBe(422);
    expect(compiler.calls()).toBe(0);
  });

  it("replays a repeated preview instead of calling the provider twice", async () => {
    const state = await activeProject(["discovery"]);
    const compiler = copyCompiler(KINDER);
    const working: ActiveProject = { ...state, deps: { ...state.deps, compiler } };
    const read = await readState(state);
    const endingId = read.playable!.scene.core.endings[0]!.id;
    const command = {
      kind: "ending_copy_preview",
      ending_id: endingId,
      request: "Make this ending kinder to her.",
    };

    const first = await body<RevisionResponse>(await revise(working, command));
    const second = await body<RevisionResponse>(await revise(working, command));
    expect(first.preview?.proposed_text).toBe(second.preview?.proposed_text);
    expect(second.model_calls).toBe(0);
    expect(compiler.calls()).toBe(1);
  });

  it("refuses a rewrite that uses wording the brief forbids, and repairs once", async () => {
    const state = await activeProject(["discovery"]);
    const read = await readState(state);
    const forbidden = read.project.brief.forbidden_wording[0];
    const endingId = read.playable!.scene.core.endings[0]!.id;
    if (forbidden === undefined) return;

    const compiler = fakeCompiler({
      endingCopy: [{ output: { text: `She forgives you. ${forbidden} settles over the room.` } }],
    });
    const working: ActiveProject = { ...state, deps: { ...state.deps, compiler } };
    const response = await revise(working, {
      kind: "ending_copy_preview",
      ending_id: endingId,
      request: "Make this ending kinder.",
    });
    // Rejected by the unchanged validator, with the one repair still available.
    expect(response.status).toBe(422);
    expect(compiler.calls()).toBe(1);
    const after = await readState(state);
    expect(after.playable?.scene.ending_copy_overrides).toEqual([]);
  });
});

describe("a revision refuses rather than half-applying", () => {
  it("refuses every command on a project with no confirmed version", async () => {
    const { approvedProject } = await import("./support/phase4-harness");
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const response = await handleRevision(
      mutation(`/api/projects/${state.projectId}/revisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: state.revision,
          kind: "remove",
          slot: "discovery",
        }),
      }),
      state.deps,
      state.projectId,
    );
    expect(response.status).toBe(422);
    const failure = await envelope(response);
    expect(failure.message).toContain("NO_ACTIVE_VERSION");
  });

  it("refuses a stale revision counter", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const response = await revise(state, { kind: "remove", slot: "commitment" }, 1);
    expect(response.status).toBe(429);
  });

  it("answers a foreign session exactly as a nonexistent project", async () => {
    const state = await activeProject(["discovery"]);
    const intruder = await owner(state.h);
    const response = await handleRevision(
      mutation(`/api/projects/${state.projectId}/revisions`, {
        cookie: intruder,
        body: JSON.stringify({
          expected_revision: state.activeRevision,
          kind: "remove",
          slot: "discovery",
        }),
      }),
      state.deps,
      state.projectId,
    );
    expect(response.status).toBe(404);
    expect((await envelope(response)).code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("refuses a cross-site request and an unsupported content type", async () => {
    const state = await activeProject(["discovery"]);
    const crossSite = await handleRevision(
      mutation(`/api/projects/${state.projectId}/revisions`, {
        cookie: state.cookie,
        origin: "https://attacker.example",
        body: JSON.stringify({
          expected_revision: state.activeRevision,
          kind: "remove",
          slot: "discovery",
        }),
      }),
      state.deps,
      state.projectId,
    );
    expect(crossSite.status).toBe(403);

    const wrongType = await handleRevision(
      mutation(`/api/projects/${state.projectId}/revisions`, {
        cookie: state.cookie,
        contentType: "text/plain",
        body: "{}",
      }),
      state.deps,
      state.projectId,
    );
    expect(wrongType.status).toBe(415);
  });

  it("offers no field for a scene, a core action, or a version to overwrite", async () => {
    const state = await activeProject(["discovery"]);
    for (const rejected of [
      { kind: "remove", slot: "discovery", scene: { title: "mine" } },
      { kind: "remove", slot: "discovery", version_id: state.versionId },
      { kind: "patch", path: "/core/actions/0", value: 1 },
      { kind: "remove" },
      { kind: "remove", slot: "third_slot" },
    ]) {
      const response = await revise(state, rejected, state.activeRevision);
      expect(response.status, JSON.stringify(rejected)).toBe(422);
    }
  });

  it("stops at the daily revision allowance with the scene unchanged", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const capped: ActiveProject = {
      ...state,
      deps: {
        ...state.deps,
        budget: () => ({ ...state.deps.budget(), revisionsPerSessionPerDay: 1 }),
      },
    };
    const first = await revise(capped, { kind: "remove", slot: "commitment" });
    expect(first.status).toBe(200);
    const second = await revise(capped, { kind: "remove", slot: "discovery" });
    expect(second.status).toBe(429);
    expect((await envelope(second)).message).toContain("revisions for today");
  });
});

describe("the project read carries both sides of the comparison", () => {
  it("labels each version and sends the parent of the one on offer", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    await revise(state, { kind: "remove", slot: "commitment" });

    const response = await handleReadProjectState(state);
    expect(response.versions.length).toBeGreaterThanOrEqual(2);
    const pending = response.versions.find((version) => version.state === "pending");
    expect(pending?.revision_label).toBe("mechanical");
    const active = response.versions.find((version) => version.state === "active");
    // The first version had no parent, so it carries no comparison.
    expect(active?.revision_label).toBeNull();
    expect(response.previous_playable?.version_id).toBe(state.versionId);
    expect(response.publications).toEqual([]);
  });
});

async function handleReadProjectState(state: ActiveProject): Promise<ProjectStateResponse & {
  previous_playable: ProjectStateResponse["playable"];
}> {
  const { handleReadProject } = await import("../../src/server/api/projects");
  const response = await handleReadProject(
    readRequest(`/api/projects/${state.projectId}`, state.cookie),
    state.deps,
    state.projectId,
  );
  expect(response.status).toBe(200);
  return body(response);
}

/** Keeps the unused import honest: the fixtures are the compiler's own script. */
void [validBaseCopy, validCommitmentOutput, handleActivate];
