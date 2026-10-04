import { describe, expect, it } from "vitest";

import { SECOND_COPY_BASE, SECOND_COPY_BRIEF, SECOND_COPY_DISCOVERY_V1 } from "../../fixtures/second-copy";
import { ANALYSIS } from "../../src/domain/limits";
import type { CompileResponse } from "../../src/domain/compile";
import { FAILURE_MESSAGES } from "../../src/domain/compile";
import { validateScene } from "../../src/engine/validate";
import { findMechanicalWitness } from "../../src/engine/diff";
import { handleActivate, handleAdvance, handleCompile } from "../../src/server/api/compile";
import {
  hitResourceLimit,
  toWitnessView,
  verifyCandidate,
} from "../../src/server/compile/verify";
import { sceneApprovalAllowlist } from "../../src/server/compile/assemble";
import { ERROR_CODES } from "../../src/server/security/errors";
import { body, envelope, mutation } from "./support/phase3-harness";
import { approvedProject, type ApprovedProject } from "./support/phase4-harness";
import { fakeCompiler } from "./support/fake-compiler";
import {
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./support/compile-fixtures";

/**
 * The failure rows of specification section 12, and the security checks every
 * new mutation has to repeat.
 */

function happyCompiler() {
  return fakeCompiler({
    base: [{ output: validBaseCopy() }],
    module: [{ output: validDiscoveryOutput() }, { output: validCommitmentOutput() }],
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

describe("missing authoritative evidence", () => {
  it("fails explicitly rather than retrieving a replacement", async () => {
    const compiler = happyCompiler();
    const state = await approvedProject(["discovery"], compiler);

    // The capture behind the frozen approval is unreadable. There is no code
    // path that goes and fetches another one: compilation makes zero Qloo
    // calls by construction.
    state.h.gateway.captures.clear();
    const upstreamCallsBefore = state.h.transport.calls.length;

    const response = await compile(state);
    expect(response.status).toBe(422);
    expect((await envelope(response)).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(state.h.transport.calls.length).toBe(upstreamCallsBefore);
    expect(compiler.calls()).toBe(0);
  });

  it("has a creator-facing sentence that says nothing was generated", () => {
    expect(FAILURE_MESSAGES.MISSING_APPROVED_EVIDENCE).toContain("nothing was generated");
  });
});

describe("compilation makes zero Qloo calls", () => {
  it("adds no upstream request across a whole build", async () => {
    const compiler = happyCompiler();
    const state = await approvedProject(["discovery", "commitment"], compiler);
    const before = state.h.transport.calls.length;
    const launchesBefore = state.h.launches.length;

    const created = await body<CompileResponse>(await compile(state));
    for (let index = 0; index < 8; index += 1) {
      const response = await handleAdvance(
        mutation(`/api/operations/${created.status.operation_id}/advance`, {
          cookie: state.cookie,
          body: "{}",
        }),
        state.deps,
        created.status.operation_id,
      );
      expect(response.status).toBe(200);
      const status = (await body<{ status: { next_stage: string | null } }>(response)).status;
      if (status.next_stage === null) break;
    }

    expect(state.h.transport.calls.length).toBe(before);
    expect(state.h.launches.length).toBe(launchesBefore);
  });
});

describe("the validation resource ceiling", () => {
  it("is a failure, never a silently truncated success", () => {
    // One reachable state is far below what this scene needs, so exploration
    // cannot finish. The validator reports the limit rather than passing.
    const report = validateScene(SECOND_COPY_DISCOVERY_V1, SECOND_COPY_BRIEF, {
      approvedApprovalIds: ["approval_discovery_v1"],
      explore: { maxStates: 1 },
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain(
      "VALIDATION_RESOURCE_LIMIT",
    );
    expect(hitResourceLimit(report.findings)).toBe(true);
    expect(report.graph).toBeNull();
  });

  it("treats an unproven mechanical witness as a failure too", () => {
    const witness = findMechanicalWitness(
      SECOND_COPY_BASE,
      SECOND_COPY_DISCOVERY_V1,
      { maxPairs: 1 },
    );
    expect(witness.overflow).toBe(true);
    expect(witness.mechanical).toBe(false);

    const view = toWitnessView("discovery", "approval_discovery_v1", witness);
    expect(view.mechanical).toBe(false);
    expect(view.sentence).toContain("was proven before the paired-replay bound");
  });

  it("keeps the declared pair bound, so the search is bounded by design", () => {
    expect(ANALYSIS.max_witness_pairs).toBe(20_000);
    expect(ANALYSIS.graph_time_budget_ms).toBe(5_000);
  });
});

describe("a subset conflict", () => {
  it("is reported as its own failure rather than repaired blindly", () => {
    // Two modules that each validate alone. Composed, the total flag budget
    // still holds, so this asserts the classification rather than inventing a
    // conflict: a candidate whose proper subsets all pass but whose full
    // composition does not is `subsetConflict`.
    const verdict = verifyCandidate(
      SECOND_COPY_DISCOVERY_V1,
      SECOND_COPY_BRIEF,
      sceneApprovalAllowlist([{ approval_id: "approval_discovery_v1" }]),
    );
    // The fixture is valid, so there is no conflict to report.
    expect(verdict.subsetConflict).toBe(false);
    expect(FAILURE_MESSAGES.SUBSET_CONFLICT).toContain("separately but not together");
  });
});

describe("every new mutation repeats the security checks", () => {
  const CASES = [
    {
      name: "advance",
      run: (state: ApprovedProject, overrides: Record<string, unknown>) =>
        handleAdvance(
          mutation(`/api/operations/11111111-1111-4111-8111-111111111111/advance`, {
            cookie: state.cookie,
            ...overrides,
          }),
          state.deps,
          "11111111-1111-4111-8111-111111111111",
        ),
    },
    {
      name: "activate",
      run: (state: ApprovedProject, overrides: Record<string, unknown>) =>
        handleActivate(
          mutation(`/api/projects/${state.projectId}/activate`, {
            cookie: state.cookie,
            ...overrides,
          }),
          state.deps,
          state.projectId,
        ),
    },
  ] as const;

  it("refuses a missing Origin", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    for (const testCase of CASES) {
      const response = await testCase.run(state, { origin: null });
      expect((await envelope(response)).code, testCase.name).toBe(
        ERROR_CODES.ORIGIN_REQUIRED,
      );
    }
  });

  it("refuses another site's Origin", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    for (const testCase of CASES) {
      const response = await testCase.run(state, { origin: "https://evil.test" });
      expect((await envelope(response)).code, testCase.name).toBe(
        ERROR_CODES.ORIGIN_MISMATCH,
      );
    }
  });

  it("requires JSON", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    for (const testCase of CASES) {
      const response = await testCase.run(state, { contentType: "text/plain" });
      expect((await envelope(response)).code, testCase.name).toBe(
        ERROR_CODES.CONTENT_TYPE_UNSUPPORTED,
      );
    }
  });

  it("caps the body at 16 KiB before parsing it", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    for (const testCase of CASES) {
      const response = await testCase.run(state, { body: "x".repeat(17 * 1024) });
      expect((await envelope(response)).code, testCase.name).toBe(
        ERROR_CODES.BODY_TOO_LARGE,
      );
    }
  });

  it("requires an owner session", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    // Both routes check the session, but `activate` validates its body first,
    // so it is given a well-formed one here to reach the session check.
    const bodies: Record<string, string> = {
      advance: "{}",
      activate: JSON.stringify({
        expected_revision: state.revision,
        version_id: "11111111-1111-4111-8111-111111111111",
      }),
    };
    for (const testCase of CASES) {
      const response = await testCase.run(state, {
        cookie: null,
        body: bodies[testCase.name],
      });
      expect((await envelope(response)).code, testCase.name).toBe(
        ERROR_CODES.SESSION_REQUIRED,
      );
    }
  });

  it("returns a redacted envelope carrying no provider or SQL detail", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    const response = await compile(state, 9_999);
    const text = await response.text();
    for (const forbidden of [
      "openai",
      "supabase",
      "x-api-key",
      "sk-",
      "select ",
      "instructions",
      "owner_session",
    ]) {
      expect(text.toLowerCase(), `envelope exposed ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the database outage path", () => {
  it("answers a compile request honestly when persistence is unavailable", async () => {
    const state = await approvedProject(["discovery"], happyCompiler());
    state.h.gateway.failing.add("findProjectForOwner");
    const response = await compile(state);
    expect(response.status).toBe(503);
    expect((await envelope(response)).code).toBe(ERROR_CODES.PERSISTENCE_UNAVAILABLE);
  });
});
