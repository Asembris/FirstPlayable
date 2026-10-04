import { describe, expect, it } from "vitest";

import { SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import type {
  ActivateResponse,
  AdvanceResponse,
  CompilationStatus,
  CompileResponse,
} from "../../src/domain/compile";
import { parseScene } from "../../src/domain/scene";
import { handleActivate, handleAdvance, handleCompile } from "../../src/server/api/compile";
import { handleDecisions } from "../../src/server/api/decisions";
import {
  availableActions,
  initialState,
  replay,
  step,
} from "../../src/engine/interpreter";
import { moduleSubsets, sceneWithModuleSubset } from "../../src/engine/compose";
import { validateScene, validateSceneSubsets } from "../../src/engine/validate";
import { sceneApprovalAllowlist } from "../../src/server/compile/assemble";
import { AppError, ERROR_CODES } from "../../src/server/security/errors";
import { body, envelope, mutation, owner } from "./support/phase3-harness";
import { approvedProject, readProject, type ApprovedProject } from "./support/phase4-harness";
import { fakeCompiler, type FakeCompiler } from "./support/fake-compiler";
import {
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
  nonPlainTextBaseCopy,
} from "./support/compile-fixtures";

/**
 * Immutable versions, the stale-result compare-and-swap, explicit activation,
 * the preserved last good version, and local playback.
 */

function happyCompiler(slots: readonly ("discovery" | "commitment")[]): FakeCompiler {
  return fakeCompiler({
    base: [{ output: validBaseCopy() }],
    module: slots.map((slot) => ({
      output: slot === "discovery" ? validDiscoveryOutput() : validCommitmentOutput(),
    })),
  });
}

async function compile(state: ApprovedProject, revision = state.revision): Promise<Response> {
  return handleCompile(
    mutation(`/api/projects/${state.projectId}/compile`, {
      cookie: state.cookie,
      body: JSON.stringify({ expected_revision: revision }),
    }),
    state.deps,
    state.projectId,
  );
}

async function advance(state: ApprovedProject, operationId: string): Promise<AdvanceResponse> {
  const response = await handleAdvance(
    mutation(`/api/operations/${operationId}/advance`, {
      cookie: state.cookie,
      body: "{}",
    }),
    state.deps,
    operationId,
  );
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return body<AdvanceResponse>(response);
}

async function buildOne(
  slots: readonly ("discovery" | "commitment")[] = ["discovery"],
): Promise<{ state: ApprovedProject; status: CompilationStatus }> {
  const state = await approvedProject(slots, happyCompiler(slots));
  const created = await body<CompileResponse>(await compile(state));
  let status = created.status;
  for (let index = 0; index < 8 && status.next_stage !== null; index += 1) {
    status = (await advance(state, created.status.operation_id)).status;
  }
  expect(status.state).toBe("REVIEW_PLAYABLE");
  return { state, status };
}

async function activate(
  state: ApprovedProject,
  versionId: string,
  options: { revision?: number; decline?: boolean } = {},
): Promise<Response> {
  return handleActivate(
    mutation(`/api/projects/${state.projectId}/activate`, {
      cookie: state.cookie,
      body: JSON.stringify({
        expected_revision: options.revision ?? state.revision,
        version_id: versionId,
        ...(options.decline === true ? { decline: true } : {}),
      }),
    }),
    state.deps,
    state.projectId,
  );
}

describe("the immutable scene version", () => {
  it("persists only a validated version, with every frozen hash and witness", async () => {
    const { state, status } = await buildOne(["discovery"]);
    expect(state.h.gateway.versions).toHaveLength(1);
    const row = state.h.gateway.versions[0]!;

    expect(row.id).toBe(status.version_id);
    expect(row.project_id).toBe(state.projectId);
    expect(row.base_hash).toHaveLength(64);
    expect(row.module_hashes).toHaveProperty("discovery");
    expect(row.model_identifier).toBe("gpt-4o-mini-2024-07-18");
    expect(row.compiler_identifier).toBe("fp-compiler-4.2");
    expect(row.prompt_identifier).toBe("fp-prompts-4.2");
    expect(row.schema_identifier).toBe("fp-model-schema-4.2");
    expect(row.validator_identifier).toBe("fp-engine-validator-1.0");
    expect(row.operation_id).toBe(status.operation_id);

    const summary = row.validation_summary as {
      ok: boolean;
      subsets: { slots: string[]; ok: boolean }[];
      witnesses: { slot: string; mechanical: boolean; sentence: string }[];
    };
    expect(summary.ok).toBe(true);
    // Every supported removal subset is recorded, base first.
    expect(summary.subsets.map((subset) => subset.slots)).toEqual([[], ["discovery"]]);
    for (const subset of summary.subsets) expect(subset.ok).toBe(true);
    expect(summary.witnesses).toHaveLength(1);
    expect(summary.witnesses[0]!.mechanical).toBe(true);
    expect(summary.witnesses[0]!.sentence.length).toBeGreaterThan(10);

    const snapshot = row.input_snapshot as { project_revision: number; brief_hash: string };
    expect(snapshot.project_revision).toBe(state.revision);
    expect(snapshot.brief_hash).toHaveLength(48);

    // The approval snapshot is frozen per version, so a historical view does
    // not silently change with today's approvals.
    const approvals = row.approval_snapshot as { slot: string; approved_text: string }[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.slot).toBe("discovery");
    expect(approvals[0]!.approved_text.length).toBeGreaterThan(10);
  });

  it("refuses to store an unvalidated candidate, at the database level", async () => {
    const { state } = await buildOne(["discovery"]);
    const project = [...state.h.gateway.projects.values()][0]!;
    await expect(
      state.h.gateway.commitSceneVersion({
        projectId: project.id,
        ownerSessionId: project.owner_session_id,
        expectedRevision: project.revision,
        expectedBaseHash: project.base_hash,
        expectedApprovals: project.active_approvals as Record<string, unknown>,
        operationId: "11111111-1111-4111-8111-111111111111",
        parentVersionId: null,
        inputHash: "a".repeat(48),
        baseHash: "b".repeat(64),
        moduleHashes: {},
        scene: { not: "a scene" },
        // The constraint is on the summary: no `ok`, no subsets, no witnesses.
        validationSummary: { ok: false },
        inputSnapshot: {},
        approvalSnapshot: [],
        modelIdentifier: "gpt-4o-mini-2024-07-18",
        promptIdentifier: "fp-prompts-4.2",
        schemaIdentifier: "fp-model-schema-4.2",
        compilerIdentifier: "fp-compiler-4.2",
        validatorIdentifier: "fp-engine-validator-1.0",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AppError && error.code === ERROR_CODES.PERSISTENCE_UNAVAILABLE,
    );
  });

  /**
   * The validated-version guard, one shape at a time.
   *
   * The live `scene_versions_validation_passed` constraint was written
   * `(validation_summary ->> 'ok')::boolean is true`, and `->>` projects to
   * text, so `text::boolean` accepted the JSON *string* `"true"` and every
   * other spelling PostgreSQL's boolean parser takes. A live probe found it
   * (`docs/PHASE4_EVIDENCE.md` §12.9) and `20261004173000` replaced it with a
   * jsonb value comparison.
   *
   * The offline suite never caught it because this in-memory gateway — the
   * stand-in for the committed SQL — used `summary.ok !== true`, a strict
   * identity check, and was therefore *stricter* than the database it
   * re-implements. The divergence, not the strictness, was the problem. These
   * cases pin both sides to the same matrix so they cannot drift apart again,
   * and `migrations.test.ts` pins the SQL text that the live database now has.
   */
  describe("the validated-version guard admits only the JSON boolean true", () => {
    async function commit(
      summary: unknown,
      inputHash = "a".repeat(48),
    ): Promise<"accepted" | "refused"> {
      const { state } = await buildOne(["discovery"]);
      const project = [...state.h.gateway.projects.values()][0]!;
      try {
        await state.h.gateway.commitSceneVersion({
          projectId: project.id,
          ownerSessionId: project.owner_session_id,
          expectedRevision: project.revision,
          expectedBaseHash: project.base_hash,
          expectedApprovals: project.active_approvals as Record<string, unknown>,
          operationId: "11111111-1111-4111-8111-111111111111",
          parentVersionId: null,
          inputHash,
          baseHash: "b".repeat(64),
          moduleHashes: {},
          scene: { not: "a scene" },
          validationSummary: summary,
          inputSnapshot: {},
          approvalSnapshot: [],
          modelIdentifier: "gpt-4o-mini-2024-07-18",
          promptIdentifier: "fp-prompts-4.2",
          schemaIdentifier: "fp-model-schema-4.2",
          compilerIdentifier: "fp-compiler-4.2",
          validatorIdentifier: "fp-engine-validator-1.0",
        });
        return "accepted";
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.PERSISTENCE_UNAVAILABLE);
        return "refused";
      }
    }

    const withReports = (ok: unknown) => ({ ok, subsets: [], witnesses: [] });

    it("accepts a real boolean true carrying both reports", async () => {
      expect(await commit(withReports(true))).toBe("accepted");
    });

    /**
     * The exact value the live database accepted before `20261004173000`.
     *
     * `'"true"'::jsonb` is a JSON string, not a JSON boolean, so the hardened
     * constraint's `(validation_summary -> 'ok') = 'true'::jsonb` is false for
     * it and `jsonb_typeof(...)` reports `string`.
     */
    it("refuses the JSON string \"true\", which text coercion used to admit", async () => {
      expect(await commit(withReports("true"))).toBe("refused");
    });

    it("refuses every other spelling a boolean parser would have taken", async () => {
      for (const truthy of ["t", "T", "yes", "y", "on", "1", "TRUE", "True"]) {
        expect(await commit(withReports(truthy)), truthy).toBe("refused");
      }
      // And the numeric forms, which are not booleans either.
      for (const numeric of [1, 1.0]) {
        expect(await commit(withReports(numeric)), String(numeric)).toBe("refused");
      }
    });

    it("refuses boolean false, and every other falsy spelling", async () => {
      expect(await commit(withReports(false))).toBe("refused");
      for (const falsy of ["false", "f", "no", "off", "0", 0, null]) {
        expect(await commit(withReports(falsy)), JSON.stringify(falsy)).toBe("refused");
      }
    });

    it("refuses a summary with no ok key at all", async () => {
      expect(await commit({ subsets: [], witnesses: [] })).toBe("refused");
      // A check constraint accepts a NULL expression, so the hardened SQL
      // asserts the key's presence before its type. This is that case.
      expect(await commit({ ok: undefined, subsets: [], witnesses: [] })).toBe("refused");
    });

    it("still refuses a validated summary that drops either report", async () => {
      expect(await commit({ ok: true, witnesses: [] })).toBe("refused");
      expect(await commit({ ok: true, subsets: [] })).toBe("refused");
      expect(await commit({ ok: true })).toBe("refused");
    });

    it("refuses a non-object summary", async () => {
      for (const summary of [null, "ok", true, 1, []]) {
        expect(await commit(summary), JSON.stringify(summary)).toBe("refused");
      }
    });

    /**
     * The hardening must not reject anything this application really produces.
     *
     * This takes the summary off a version a real compilation committed — the
     * genuine `ValidationSummaryView`, with its subset reports and its
     * mechanical witness — and commits it again under a different input hash.
     */
    it("keeps accepting a validation summary a real compilation produced", async () => {
      const { state } = await buildOne(["discovery", "commitment"]);
      const existing = state.h.gateway.versions[0]!.validation_summary as {
        ok: unknown;
        subsets: unknown;
        witnesses: unknown;
      };
      expect(existing.ok).toBe(true);
      expect(typeof existing.ok).toBe("boolean");
      expect(Array.isArray(existing.subsets)).toBe(true);
      expect(Array.isArray(existing.witnesses)).toBe(true);
      expect(await commit(existing, "c".repeat(48))).toBe("accepted");
    });
  });

  it("reads back a scene the real engine still validates", async () => {
    const { state } = await buildOne(["discovery", "commitment"]);
    const row = state.h.gateway.versions[0]!;
    const scene = parseScene(row.scene);

    const report = validateScene(scene, SECOND_COPY_BRIEF, {
      approvedApprovalIds: scene.modules.map((module) => module.approval_id),
    });
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
    expect(report.graph?.reachable_endings).toEqual(["end.give", "end.keep", "end.leave"]);

    // Every supported subset is still valid on read-back.
    const subsets = validateSceneSubsets(scene, SECOND_COPY_BRIEF, {
      approvedApprovalIds: scene.modules.map((module) => module.approval_id),
    });
    expect(subsets.ok).toBe(true);
    expect(moduleSubsets(scene)).toHaveLength(4);
  });

  it("is never mutated: a new build inserts a second row", async () => {
    const { state } = await buildOne(["discovery"]);
    const before = JSON.stringify(state.h.gateway.versions[0]);

    const reread = await readProject(state);
    const proposal = reread.project.proposals.find(
      (candidate) => candidate.slot === "commitment",
    )!;
    await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: reread.project.revision,
          kind: "accept",
          proposal_id: proposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );

    // Only the commitment slot is new, so only that module is compiled: the
    // brief-only base and the already committed discovery module are reused.
    const next: ApprovedProject = {
      ...state,
      revision: reread.project.revision + 1,
      deps: {
        ...state.deps,
        compiler: fakeCompiler({ module: [{ output: validCommitmentOutput() }] }),
      },
    };
    const created = await body<CompileResponse>(await compile(next));
    let status = created.status;
    for (let index = 0; index < 8 && status.next_stage !== null; index += 1) {
      status = (await advance(next, created.status.operation_id)).status;
    }
    expect(status.state).toBe("REVIEW_PLAYABLE");
    expect(state.h.gateway.versions).toHaveLength(2);
    expect(JSON.stringify(state.h.gateway.versions[0])).toBe(before);
  });

  it("names the previous active version as the new version's parent", async () => {
    const { state, status } = await buildOne(["discovery"]);
    await activate(state, status.version_id as string);
    const firstId = status.version_id as string;

    const reread = await readProject(state);
    expect(reread.project.active_version_id).toBe(firstId);

    const second = await body<CompileResponse>(
      await compile({ ...state, revision: reread.project.revision }, reread.project.revision),
    );
    // A new compilation of the same frozen inputs replays rather than
    // regenerating, so a fresh version needs a genuine input change.
    expect(second.replayed).toBe(true);
  });
});

describe("the stale-result compare-and-swap", () => {
  it("refuses to commit a result whose approvals moved while it was pending", async () => {
    const compiler = happyCompiler(["discovery"]);
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    // Compile the base and the module, so the only stage left is validation.
    expect((await advance(state, operationId)).status.state).toBe("BASE_READY");
    expect((await advance(state, operationId)).status.state).toBe("MODULES_READY");

    // The creator changes an approval while the result is pending.
    const removed = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: state.revision,
          kind: "remove",
          slot: "discovery",
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    expect(removed.status).toBe(200);

    const stale = await advance(state, operationId);
    expect(stale.status.state).toBe("FAILED");
    expect(stale.status.failure?.code).toBe("STALE_INPUT");
    // The result stays an operation artifact and never becomes a version.
    expect(state.h.gateway.versions).toEqual([]);
    const project = [...state.h.gateway.projects.values()][0]!;
    expect(project.pending_version_id).toBeNull();
    expect(project.active_version_id).toBeNull();
  });

  it("refuses a stale result even when the change lands mid-stage", async () => {
    // The approval is changed while the provider "call" is in flight: the
    // compiler mutates the project before returning its candidate.
    const state = await approvedProject(["discovery"], fakeCompiler({}));
    let changed = false;
    const racing: FakeCompiler = {
      requests: [],
      calls: () => 1,
      generate: async (request: { schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        if (!changed) {
          changed = true;
          await handleDecisions(
            mutation(`/api/projects/${state.projectId}/decisions`, {
              cookie: state.cookie,
              body: JSON.stringify({
                expected_revision: state.revision,
                kind: "remove",
                slot: "discovery",
              }),
            }),
            state.h.deps,
            state.projectId,
          );
        }
        const parsed = request.schema.safeParse(validBaseCopy());
        if (!parsed.success) throw new Error("fixture rejected by the contract");
        return { data: parsed.data, model: "gpt-4o-mini-2024-07-18", usage: null };
      },
    } as unknown as FakeCompiler;

    const racingState: ApprovedProject = {
      ...state,
      deps: { ...state.deps, compiler: racing },
    };
    const created = await body<CompileResponse>(await compile(racingState));
    const after = await advance(racingState, created.status.operation_id);

    // The base write is guarded by the same revision compare-and-swap, so the
    // candidate produced against the old approvals cannot land.
    expect(after.status.state).toBe("FAILED");
    expect(after.status.failure?.code).toBe("STALE_INPUT");
    expect(state.h.gateway.versions).toEqual([]);
  });

  it("rejects activating a version whose approvals have since moved", async () => {
    const { state, status } = await buildOne(["discovery"]);
    const versionId = status.version_id as string;

    const removed = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: state.revision,
          kind: "remove",
          slot: "discovery",
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    expect(removed.status).toBe(200);

    const response = await activate(state, versionId, { revision: state.revision + 1 });
    expect(response.status).toBe(429);
    const project = [...state.h.gateway.projects.values()][0]!;
    expect(project.active_version_id).toBeNull();
  });
});

describe("review before activation", () => {
  it("leaves a successful build pending, not active", async () => {
    const { state, status } = await buildOne(["discovery"]);
    const project = [...state.h.gateway.projects.values()][0]!;
    expect(project.pending_version_id).toBe(status.version_id);
    expect(project.active_version_id).toBeNull();
    expect(project.workflow_state).toBe("REVIEW_PLAYABLE");

    const read = await readProject(state);
    expect(read.project.pending_version_id).toBe(status.version_id);
    expect(read.project.active_version_id).toBeNull();
    expect(read.playable?.state).toBe("pending");
  });

  it("activates on an explicit confirmation", async () => {
    const { state, status } = await buildOne(["discovery"]);
    const response = await activate(state, status.version_id as string);
    expect(response.status).toBe(200);
    const result = await body<ActivateResponse>(response);

    expect(result.outcome).toBe("activated");
    expect(result.active_version_id).toBe(status.version_id);
    expect(result.pending_version_id).toBeNull();
    expect(result.workflow_state).toBe("READY");

    const read = await readProject(state);
    expect(read.playable?.state).toBe("active");
    expect(read.versions[0]?.state).toBe("active");
  });

  it("is idempotent when the same version is confirmed twice", async () => {
    const { state, status } = await buildOne(["discovery"]);
    await activate(state, status.version_id as string);
    const again = await activate(state, status.version_id as string);
    expect(again.status).toBe(200);
    expect((await body<ActivateResponse>(again)).outcome).toBe("already_active");
  });

  it("refuses to activate a version that is not the one awaiting review", async () => {
    const { state, status } = await buildOne(["discovery"]);
    await activate(state, status.version_id as string);
    // Now nothing is pending, so re-activating is refused rather than silent.
    const other = await activate(state, "11111111-1111-4111-8111-111111111111");
    expect(other.status).toBe(404);
  });

  it("preserves the previous version when a review is declined", async () => {
    const { state, status } = await buildOne(["discovery"]);
    const response = await activate(state, status.version_id as string, { decline: true });
    expect(response.status).toBe(200);
    const result = await body<ActivateResponse>(response);

    expect(result.outcome).toBe("declined");
    expect(result.pending_version_id).toBeNull();
    expect(result.active_version_id).toBeNull();
    // The declined version row is untouched and stays readable history.
    expect(state.h.gateway.versions).toHaveLength(1);
  });

  it("refuses a foreign owner", async () => {
    const { state, status } = await buildOne(["discovery"]);
    const intruder = await owner(state.h);
    const response = await handleActivate(
      mutation(`/api/projects/${state.projectId}/activate`, {
        cookie: intruder,
        body: JSON.stringify({
          expected_revision: state.revision,
          version_id: status.version_id,
        }),
      }),
      state.deps,
      state.projectId,
    );
    expect(response.status).toBe(404);
    expect((await envelope(response)).code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("cannot activate anything after a failed compilation", async () => {
    const compiler = fakeCompiler({
      base: [
        { output: nonPlainTextBaseCopy() },
        { output: nonPlainTextBaseCopy() },
      ],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    await advance(state, created.status.operation_id);
    const failedStatus = (await advance(state, created.status.operation_id)).status;
    expect(failedStatus.state).toBe("FAILED");

    const response = await activate(state, "11111111-1111-4111-8111-111111111111");
    expect(response.status).toBe(404);
    expect(state.h.gateway.versions).toEqual([]);
  });
});

describe("the last good version", () => {
  it("stays active and playable when a later build fails", async () => {
    const compiler = fakeCompiler({
      base: [{ output: validBaseCopy() }],
      module: [
        { output: validDiscoveryOutput() },
        // The commitment module fails twice in the second compilation.
        { output: validCommitmentOutput() },
      ],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    let status = created.status;
    for (let index = 0; index < 6 && status.next_stage !== null; index += 1) {
      status = (await advance(state, created.status.operation_id)).status;
    }
    const goodVersion = status.version_id as string;
    await activate(state, goodVersion);

    // A second compilation that cannot produce a module.
    const reread = await readProject(state);
    const proposal = reread.project.proposals.find(
      (candidate) => candidate.slot === "commitment",
    )!;
    await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: reread.project.revision,
          kind: "accept",
          proposal_id: proposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );

    const failing = fakeCompiler({
      module: [
        { output: { variables: [], actions: [], dialogue: [], gates: [], on_actions: [] } },
        { output: { variables: [], actions: [], dialogue: [], gates: [], on_actions: [] } },
      ],
    });
    const next: ApprovedProject = {
      ...state,
      revision: reread.project.revision + 1,
      deps: { ...state.deps, compiler: failing },
    };
    const secondCompile = await body<CompileResponse>(await compile(next));
    let secondStatus = secondCompile.status;
    for (let index = 0; index < 6 && secondStatus.next_stage !== null; index += 1) {
      secondStatus = (await advance(next, secondCompile.status.operation_id)).status;
    }
    expect(secondStatus.state).toBe("FAILED");
    expect(secondStatus.last_good_version_id).toBe(goodVersion);

    // The active version is untouched and still plays.
    const after = await readProject(next);
    expect(after.project.active_version_id).toBe(goodVersion);
    expect(after.playable?.version_id).toBe(goodVersion);
    const scene = parseScene(after.playable?.scene);
    expect(availableActions(scene, initialState(scene)).length).toBeGreaterThan(0);
  });

  it("never clears the active version at the start of a compilation", async () => {
    const { state, status } = await buildOne(["discovery"]);
    await activate(state, status.version_id as string);
    const project = [...state.h.gateway.projects.values()][0]!;
    const activeBefore = project.active_version_id;

    const reread = await readProject(state);
    await compile({ ...state, revision: reread.project.revision }, reread.project.revision);
    expect(project.active_version_id).toBe(activeBefore);
  });
});

describe("local playback after generation", () => {
  it("plays through the real engine with no further request of any kind", async () => {
    const { state, status } = await buildOne(["discovery"]);
    await activate(state, status.version_id as string);
    const read = await readProject(state);
    const scene = parseScene(read.playable?.scene);

    // The whole scene arrived in one read. Count every subsequent gateway call.
    const calls: string[] = [];
    const watched = new Proxy(state.h.gateway, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value === "function") {
          calls.push(String(property));
          return value;
        }
        return value;
      },
    });
    void watched;

    let playState = initialState(scene);
    let ending: string | null = null;
    const taken: string[] = [];
    for (let guard = 0; guard < 14 && ending === null; guard += 1) {
      const choices = availableActions(scene, playState).filter((choice) => choice.enabled);
      const choice = choices[choices.length - 1];
      if (choice === undefined) break;
      const result = step(scene, playState, choice.action_id);
      expect(result.ok).toBe(true);
      if (!result.ok) break;
      taken.push(choice.action_id);
      playState = result.state;
      ending = result.ending === null ? null : result.ending.id;
    }
    expect(ending).not.toBeNull();
    // Stepping the scene touched no gateway method and made no fetch: the
    // engine is a pure function over the scene and the state.
    expect(calls).toEqual([]);

    // A reset is a new run from the initial state, equally local.
    const rerun = replay(scene, taken);
    expect(rerun.ending?.id).toBe(ending);
  });

  it("reaches all three endings in the accepted version", async () => {
    const { state } = await buildOne(["discovery", "commitment"]);
    const row = state.h.gateway.versions[0]!;
    const summary = row.validation_summary as { reachable_endings: string[] };
    expect([...summary.reachable_endings].sort()).toEqual([
      "end.give",
      "end.keep",
      "end.leave",
    ]);

    const scene = parseScene(row.scene);
    for (const slots of moduleSubsets(scene)) {
      const subset = sceneWithModuleSubset(scene, slots);
      const report = validateScene(subset, SECOND_COPY_BRIEF, {
        approvedApprovalIds: sceneApprovalAllowlist(
          scene.modules.map((module) => ({ approval_id: module.approval_id })),
        ).concat(scene.modules.map((module) => module.approval_id)),
      });
      expect(report.ok, `${slots.join("+") || "base"}: ${JSON.stringify(report.findings)}`).toBe(
        true,
      );
    }
  });

  it("exposes the deterministic Scene changed line for each active module", async () => {
    const { state } = await buildOne(["discovery", "commitment"]);
    const read = await readProject(state);
    const playable = read.playable;
    expect(playable).not.toBeNull();
    expect(playable?.scene_changed).toHaveLength(2);

    for (const change of playable?.scene_changed ?? []) {
      expect(change.witness.mechanical).toBe(true);
      expect(change.mechanic_ids.length).toBeGreaterThan(0);
      // The sentence is engine output. It never claims a source produced the
      // mechanic, proved anything, or could not have been matched otherwise.
      const sentence = change.witness.sentence.toLowerCase();
      for (const overclaim of ["qloo", "prove", "unique", "better", "only"]) {
        expect(sentence, `witness sentence claims ${overclaim}`).not.toContain(overclaim);
      }
    }
  });
});
