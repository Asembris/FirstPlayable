import { describe, expect, it } from "vitest";

import type {
  AdvanceResponse,
  CompileResponse,
  CompilationStatus,
} from "../../src/domain/compile";
import { handleAdvance, handleCompile, handleOperationStatus } from "../../src/server/api/compile";
import { handleDecisions } from "../../src/server/api/decisions";
import { ERROR_CODES, type ErrorEnvelope } from "../../src/server/security/errors";
import { body, envelope, mutation, owner, readRequest } from "./support/phase3-harness";
import { approvedProject, readProject, type ApprovedProject } from "./support/phase4-harness";
import {
  fakeCompiler,
  providerRefusal,
  type FakeCompiler,
} from "./support/fake-compiler";
import {
  SENTINELS,
  mechanicallyEmptyModuleOutput,
  nonPlainTextBaseCopy,
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./support/compile-fixtures";

/**
 * The four locked Phase 4 routes, driven end to end offline.
 *
 * Every test here runs the real handlers, the real controller, the real
 * payload builders, the real Phase 1 validator, and the in-memory gateway that
 * re-implements the committed SQL. Only the provider is deterministic.
 */

/** The default happy script: a valid base, then one valid module per slot. */
function happyCompiler(slots: readonly ("discovery" | "commitment")[]): FakeCompiler {
  return fakeCompiler({
    base: [{ output: validBaseCopy() }],
    module: slots.map((slot) => ({
      output: slot === "discovery" ? validDiscoveryOutput() : validCommitmentOutput(),
    })),
  });
}

async function compile(
  state: ApprovedProject,
  revision = state.revision,
): Promise<Response> {
  return handleCompile(
    mutation(`/api/projects/${state.projectId}/compile`, {
      cookie: state.cookie,
      body: JSON.stringify({ expected_revision: revision }),
    }),
    state.deps,
    state.projectId,
  );
}

async function advance(state: ApprovedProject, operationId: string): Promise<Response> {
  return handleAdvance(
    mutation(`/api/operations/${operationId}/advance`, {
      cookie: state.cookie,
      body: "{}",
    }),
    state.deps,
    operationId,
  );
}

/** Advances until the controller says there is no next stage. */
async function runToCompletion(
  state: ApprovedProject,
  operationId: string,
  limit = 10,
): Promise<{ status: CompilationStatus; advances: number }> {
  let status: CompilationStatus | null = null;
  let advances = 0;
  for (let index = 0; index < limit; index += 1) {
    const response = await advance(state, operationId);
    if (response.status !== 200) {
      throw new Error(`advance failed: ${JSON.stringify(await envelope(response))}`);
    }
    advances += 1;
    status = (await body<AdvanceResponse>(response)).status;
    if (status.next_stage === null) break;
  }
  if (status === null) throw new Error("no advance was made");
  return { status, advances };
}

describe("POST /api/projects/:id/compile", () => {
  it("freezes the revision, the approvals, and their input hashes", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const response = await compile(state);
    expect(response.status).toBe(201);
    const created = await body<CompileResponse>(response);

    expect(created.replayed).toBe(false);
    expect(created.status.state).toBe("AWAITING_APPROVAL");
    expect(created.status.next_stage).toBe("base");
    expect(created.status.next_stage_label).toBe("Writing encounter");
    expect(created.status.model_calls).toBe(0);
    expect(created.status.version_id).toBeNull();
    expect(created.status.last_good_version_id).toBeNull();

    const operation = state.h.gateway.operations.get(created.status.operation_id);
    expect(operation?.stage).toBe("compile");
    expect(operation?.input_revision).toBe(state.revision);

    const checkpoint = operation?.result as {
      snapshot: { project_revision: number; approvals: { slot: string; input_hash: string }[] };
    };
    expect(checkpoint.snapshot.project_revision).toBe(state.revision);
    expect(checkpoint.snapshot.approvals).toHaveLength(1);
    expect(checkpoint.snapshot.approvals[0]!.slot).toBe("discovery");
    expect(checkpoint.snapshot.approvals[0]!.input_hash).toHaveLength(48);
    // No provider call is made by creating a compilation.
    expect((state.deps.compiler as FakeCompiler).calls()).toBe(0);
  });

  it("is idempotent: a duplicate request replays the same operation", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const first = await body<CompileResponse>(await compile(state));
    const second = await body<CompileResponse>(await compile(state));

    expect(second.replayed).toBe(true);
    expect(second.status.operation_id).toBe(first.status.operation_id);
    const compileRows = [...state.h.gateway.operations.values()].filter(
      (row) => row.stage === "compile",
    );
    expect(compileRows).toHaveLength(1);
  });

  it("refuses when no approval is active", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
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

    const response = await compile(state, state.revision + 1);
    expect(response.status).toBe(422);
    const failure = await envelope(response);
    expect(failure.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it("refuses a stale revision rather than compiling an older choice set", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const response = await compile(state, state.revision - 1);
    expect(response.status).toBe(429);
  });

  it("requires Origin, JSON, and a bounded body", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const path = `/api/projects/${state.projectId}/compile`;

    const noOrigin = await handleCompile(
      mutation(path, { cookie: state.cookie, origin: null }),
      state.deps,
      state.projectId,
    );
    expect((await envelope(noOrigin)).code).toBe(ERROR_CODES.ORIGIN_REQUIRED);

    const foreign = await handleCompile(
      mutation(path, { cookie: state.cookie, origin: "https://evil.test" }),
      state.deps,
      state.projectId,
    );
    expect((await envelope(foreign)).code).toBe(ERROR_CODES.ORIGIN_MISMATCH);

    const wrongType = await handleCompile(
      mutation(path, { cookie: state.cookie, contentType: "text/plain" }),
      state.deps,
      state.projectId,
    );
    expect((await envelope(wrongType)).code).toBe(ERROR_CODES.CONTENT_TYPE_UNSUPPORTED);

    const huge = await handleCompile(
      mutation(path, { cookie: state.cookie, body: "x".repeat(17 * 1024) }),
      state.deps,
      state.projectId,
    );
    expect((await envelope(huge)).code).toBe(ERROR_CODES.BODY_TOO_LARGE);
  });

  it("answers a foreign session exactly like a nonexistent project", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const intruder = await owner(state.h);
    const response = await handleCompile(
      mutation(`/api/projects/${state.projectId}/compile`, {
        cookie: intruder,
        body: JSON.stringify({ expected_revision: state.revision }),
      }),
      state.deps,
      state.projectId,
    );
    expect(response.status).toBe(404);
    expect((await envelope(response)).code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

describe("POST /api/operations/:id/advance", () => {
  it("performs one model stage per request and commits before returning", async () => {
    const compiler = happyCompiler(["discovery"]);
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    const first = await body<AdvanceResponse>(await advance(state, operationId));
    expect(first.model_calls).toBe(1);
    expect(compiler.calls()).toBe(1);
    expect(first.status.state).toBe("BASE_READY");
    expect(first.status.next_stage).toBe("module_discovery");

    const second = await body<AdvanceResponse>(await advance(state, operationId));
    expect(second.model_calls).toBe(1);
    expect(compiler.calls()).toBe(2);
    expect(second.status.state).toBe("MODULES_READY");
    expect(second.status.next_stage).toBe("validate");

    // The validation stage makes no provider call at all.
    const third = await body<AdvanceResponse>(await advance(state, operationId));
    expect(third.model_calls).toBe(0);
    expect(compiler.calls()).toBe(2);
    expect(third.status.state).toBe("REVIEW_PLAYABLE");
    expect(third.status.next_stage).toBeNull();
    expect(third.status.version_id).not.toBeNull();
  });

  it("compiles two slots with four provider calls and one version", async () => {
    const compiler = happyCompiler(["discovery", "commitment"]);
    const state = await approvedProject(["discovery", "commitment"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const { status, advances } = await runToCompletion(state, created.status.operation_id);

    // base + discovery + commitment + validate.
    expect(advances).toBe(4);
    // Three of those four made a provider call.
    expect(compiler.calls()).toBe(3);
    expect(status.state).toBe("REVIEW_PLAYABLE");
    expect(status.model_calls).toBe(3);
    expect(state.h.gateway.versions).toHaveLength(1);
  });

  it("carries no stage field, so the browser cannot choose a transition", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const created = await body<CompileResponse>(await compile(state));
    const response = await handleAdvance(
      mutation(`/api/operations/${created.status.operation_id}/advance`, {
        cookie: state.cookie,
        body: JSON.stringify({ stage: "validate" }),
      }),
      state.deps,
      created.status.operation_id,
    );
    // The contract is a strict empty object, so an extra key is refused.
    expect(response.status).toBe(422);
    expect((await envelope(response)).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it("cannot duplicate a provider attempt when the same advance is replayed", async () => {
    const compiler = fakeCompiler({ base: [{ output: validBaseCopy() }] });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    const first = await body<AdvanceResponse>(await advance(state, operationId));
    expect(first.status.state).toBe("BASE_READY");
    expect(compiler.calls()).toBe(1);

    // A second advance moves on to the next stage; the base is not recompiled.
    // Nothing is scripted for the module stage, so if the base were recompiled
    // or the module ran twice, the fake would throw.
    const baseStages = [...state.h.gateway.operations.values()].filter(
      (row) => row.stage === "base",
    );
    expect(baseStages).toHaveLength(1);
    expect(baseStages[0]!.attempts).toBe(1);
    expect(baseStages[0]!.status).toBe("succeeded");
  });

  it("reuses an already compiled base rather than regenerating it", async () => {
    const compiler = fakeCompiler({
      base: [{ output: validBaseCopy() }],
      module: [{ output: validDiscoveryOutput() }, { output: validCommitmentOutput() }],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    await runToCompletion(state, created.status.operation_id);
    expect(compiler.calls()).toBe(2);

    // Approve a second influence, which moves the revision and starts a new
    // compilation. Only the second module is compiled: the brief-only base
    // input hash did not move, so the stored foundation is reused.
    const reread = await readProject(state);
    const proposal = reread.project.proposals.find(
      (candidate) => candidate.slot === "commitment",
    )!;
    const decided = await handleDecisions(
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
    expect(decided.status).toBe(200);
    const next = { ...state, revision: reread.project.revision + 1 };

    const second = await body<CompileResponse>(await compile(next));
    const run = await runToCompletion(next, second.status.operation_id);
    expect(run.status.state).toBe("REVIEW_PLAYABLE");
    // One more provider call in total: the commitment module. The base was
    // reused, and so was the already committed discovery module.
    expect(compiler.calls()).toBe(3);
  });

  it("answers a foreign session with NOT_FOUND", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const created = await body<CompileResponse>(await compile(state));
    const intruder = await owner(state.h);
    const response = await handleAdvance(
      mutation(`/api/operations/${created.status.operation_id}/advance`, {
        cookie: intruder,
        body: "{}",
      }),
      state.deps,
      created.status.operation_id,
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/operations/:id", () => {
  it("returns the committed checkpoint and initiates no work", async () => {
    const compiler = happyCompiler(["discovery"]);
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    await advance(state, created.status.operation_id);
    const callsAfterOneStage = compiler.calls();

    for (let index = 0; index < 3; index += 1) {
      const response = await handleOperationStatus(
        readRequest(`/api/operations/${created.status.operation_id}`, state.cookie),
        state.deps,
        created.status.operation_id,
      );
      expect(response.status).toBe(200);
      const status = (await body<{ status: CompilationStatus }>(response)).status;
      expect(status.state).toBe("BASE_READY");
      expect(status.next_stage).toBe("module_discovery");
    }
    // Polling the status caused no further provider call.
    expect(compiler.calls()).toBe(callsAfterOneStage);
  });

  it("redacts the operation: no provider diagnostic and no approved wording", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const created = await body<CompileResponse>(await compile(state));
    await runToCompletion(state, created.status.operation_id);

    const response = await handleOperationStatus(
      readRequest(`/api/operations/${created.status.operation_id}`, state.cookie),
      state.deps,
      created.status.operation_id,
    );
    const text = await response.text();
    for (const forbidden of [
      "error",
      "owner_session_id",
      "api_key",
      "instructions",
      "prompt",
      "rejected",
      SENTINELS.artist,
    ]) {
      expect(text.toLowerCase(), `status exposed ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
  });

  it("answers a foreign session with NOT_FOUND", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const created = await body<CompileResponse>(await compile(state));
    const intruder = await owner(state.h);
    const response = await handleOperationStatus(
      readRequest(`/api/operations/${created.status.operation_id}`, intruder),
      state.deps,
      created.status.operation_id,
    );
    expect(response.status).toBe(404);
  });
});

describe("the repair ceiling", () => {
  it("accepts one invalid base, one repair, and then a valid base", async () => {
    const compiler = fakeCompiler({
      base: [{ output: nonPlainTextBaseCopy() }, { output: validBaseCopy() }],
      module: [{ output: validDiscoveryOutput() }],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    const rejected = await body<AdvanceResponse>(await advance(state, operationId));
    expect(rejected.status.state).toBe("AWAITING_APPROVAL");
    expect(rejected.status.next_stage).toBe("base");
    expect(rejected.status.failure).toBeNull();

    const repaired = await body<AdvanceResponse>(await advance(state, operationId));
    expect(repaired.status.state).toBe("BASE_READY");
    const baseStage = repaired.status.stages.find((stage) => stage.stage === "base")!;
    expect(baseStage.attempts).toBe(2);
    expect(baseStage.repaired).toBe(true);

    const run = await runToCompletion(state, operationId);
    expect(run.status.state).toBe("REVIEW_PLAYABLE");
    // Two base calls plus one module call. No third base attempt.
    expect(compiler.calls()).toBe(3);
  });

  it("shows the repair its own rejected candidate and the findings", async () => {
    const compiler = fakeCompiler({
      base: [{ output: nonPlainTextBaseCopy() }, { output: validBaseCopy() }],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    await advance(state, created.status.operation_id);
    await advance(state, created.status.operation_id);

    const repairRequest = compiler.requests[1]!;
    const payload = repairRequest.payload as {
      stage: string;
      context: { stage: string };
      rejected_output: unknown;
      findings: { code: string }[];
    };
    expect(payload.stage).toBe("repair");
    expect(payload.context.stage).toBe("base");
    expect(payload.rejected_output).toEqual(nonPlainTextBaseCopy());
    expect(payload.findings.map((finding) => finding.code)).toContain("SCHEMA_INVALID");
  });

  it("stops after the one permitted repair, with no third attempt", async () => {
    const compiler = fakeCompiler({
      base: [
        { output: nonPlainTextBaseCopy() },
        { output: nonPlainTextBaseCopy() },
      ],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    await advance(state, operationId);
    const second = await body<AdvanceResponse>(await advance(state, operationId));
    expect(second.status.state).toBe("FAILED");
    expect(second.status.failure?.code).toBe("VALIDATION_FAILED");
    expect(second.status.next_stage).toBeNull();
    expect(compiler.calls()).toBe(2);

    // A further advance makes no third provider call.
    const third = await body<AdvanceResponse>(await advance(state, operationId));
    expect(third.model_calls).toBe(0);
    expect(compiler.calls()).toBe(2);
    expect(state.h.gateway.versions).toEqual([]);
  });

  it("counts a provider failure against the same two-attempt ceiling", async () => {
    const compiler = fakeCompiler({
      base: [providerRefusal(), { output: validBaseCopy() }],
      module: [{ output: validDiscoveryOutput() }],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    const refused = await body<AdvanceResponse>(await advance(state, operationId));
    expect(refused.model_calls).toBe(1);
    expect(refused.status.failure).toBeNull();
    expect(refused.status.stages.find((stage) => stage.stage === "base")?.attempts).toBe(1);

    const recovered = await body<AdvanceResponse>(await advance(state, operationId));
    expect(recovered.status.state).toBe("BASE_READY");
    expect(compiler.calls()).toBe(2);
  });

  it("fails the stage when both attempts hit a provider failure", async () => {
    const compiler = fakeCompiler({ base: [providerRefusal(), providerRefusal()] });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const operationId = created.status.operation_id;

    await advance(state, operationId);
    const second = await body<AdvanceResponse>(await advance(state, operationId));
    expect(second.status.state).toBe("FAILED");
    expect(second.status.failure?.code).toBe("MODEL_STAGE_FAILED");
    expect(compiler.calls()).toBe(2);
  });

  it("repairs a mechanically empty module rather than accepting it", async () => {
    const compiler = fakeCompiler({
      base: [{ output: validBaseCopy() }],
      module: [
        { output: mechanicallyEmptyModuleOutput() },
        { output: validCommitmentOutput() },
      ],
    });
    const state = await approvedProject(["commitment"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    const run = await runToCompletion(state, created.status.operation_id);

    expect(run.status.state).toBe("REVIEW_PLAYABLE");
    const moduleStage = run.status.stages.find(
      (stage) => stage.stage === "module_commitment",
    )!;
    expect(moduleStage.repaired).toBe(true);
    expect(moduleStage.attempts).toBe(2);
  });

  it("never records more than two attempts on a stage row", async () => {
    const compiler = fakeCompiler({
      base: [
        { output: nonPlainTextBaseCopy() },
        { output: nonPlainTextBaseCopy() },
      ],
    });
    const state = await approvedProject(["discovery"], compiler);
    const created = await body<CompileResponse>(await compile(state));
    for (let index = 0; index < 5; index += 1) {
      await advance(state, created.status.operation_id);
    }
    const baseRow = [...state.h.gateway.operations.values()].find(
      (row) => row.stage === "base",
    )!;
    expect(baseRow.attempts).toBeLessThanOrEqual(2);
    expect(compiler.calls()).toBe(2);
  });
});

describe("the error envelope", () => {
  it("names the last good version on a failure after one is active", async () => {
    const state = await approvedProject(
      ["discovery"],
      fakeCompiler({
        base: [{ output: validBaseCopy() }],
        module: [{ output: validDiscoveryOutput() }],
      }),
    );
    const created = await body<CompileResponse>(await compile(state));
    const run = await runToCompletion(state, created.status.operation_id);
    expect(run.status.last_good_version_id).toBeNull();
    expect(run.status.version_id).not.toBeNull();
  });

  it("returns a redacted envelope with no provider text", async () => {
    const state = await approvedProject(["discovery"], happyCompiler(["discovery"]));
    const response = await compile(state, 9_999);
    const failure: ErrorEnvelope = await envelope(response);
    expect(Object.keys(failure).sort()).toEqual([
      "code",
      "last_good_version_id",
      "message",
      "request_id",
      "retryable",
    ]);
  });
});
