/**
 * The Phase 5 harness: a project with a real, confirmed, active version.
 *
 * It builds on the Phase 4 harness — which walks the real Phase 3 route
 * handlers over the pinned redacted Qloo captures — then compiles through the
 * real controller and real validator over a deterministic compiler, and
 * confirms the result through the real activation route.
 *
 * What a Phase 5 test therefore starts from is not a hand-built row: it is a
 * project whose active version was produced by the production code path and
 * accepted by the unchanged Phase 1 engine. Only the provider is scripted.
 */

import { expect } from "vitest";
import type {
  AdvanceResponse,
  CompilationStatus,
  CompileResponse,
  PlayableView,
  SceneVersionSummary,
} from "../../../src/domain/compile";
import type { ProjectView } from "../../../src/domain/project";
import type { PublicationSummary } from "../../../src/domain/publish";
import type { RevisionDiffView } from "../../../src/domain/revision";
import { handleActivate, handleAdvance, handleCompile } from "../../../src/server/api/compile";
import { handleReadProject } from "../../../src/server/api/projects";
import { body, envelope, mutation, readRequest } from "./phase3-harness";
import { approvedProject, type ApprovedProject, type Slot } from "./phase4-harness";
import { fakeCompiler, type FakeCompiler } from "./fake-compiler";
import {
  validBaseCopy,
  validCommitmentOutput,
  validDiscoveryOutput,
} from "./compile-fixtures";

export type { Slot };

/** The default happy script: a valid base, then one valid module per slot. */
export function happyCompiler(
  slots: readonly Slot[],
  extra: { readonly endingCopy?: readonly { readonly output: unknown }[] } = {},
): FakeCompiler {
  return fakeCompiler({
    base: [{ output: validBaseCopy() }],
    module: slots.map((slot) => ({
      output: slot === "discovery" ? validDiscoveryOutput() : validCommitmentOutput(),
    })),
    ...(extra.endingCopy === undefined ? {} : { endingCopy: extra.endingCopy }),
  });
}

/** A second script for the slot a revision recompiles. */
export function recompileCompiler(slot: Slot): FakeCompiler {
  return fakeCompiler({
    module: [{ output: slot === "discovery" ? validDiscoveryOutput() : validCommitmentOutput() }],
  });
}

export type ActiveProject = ApprovedProject & {
  /** The version the creator confirmed. */
  readonly versionId: string;
  /** The revision after activation. */
  readonly activeRevision: number;
};

export async function compileAndActivate(
  state: ApprovedProject,
  revision = state.revision,
): Promise<{ versionId: string; revision: number }> {
  const created = await handleCompile(
    mutation(`/api/projects/${state.projectId}/compile`, {
      cookie: state.cookie,
      body: JSON.stringify({ expected_revision: revision }),
    }),
    state.deps,
    state.projectId,
  );
  if (created.status !== 201) {
    throw new Error(`compile failed: ${JSON.stringify(await envelope(created))}`);
  }
  let status: CompilationStatus = (await body<CompileResponse>(created)).status;

  for (let index = 0; index < 10 && status.next_stage !== null; index += 1) {
    const advanced = await handleAdvance(
      mutation(`/api/operations/${status.operation_id}/advance`, {
        cookie: state.cookie,
        body: "{}",
      }),
      state.deps,
      status.operation_id,
    );
    if (advanced.status !== 200) {
      throw new Error(`advance failed: ${JSON.stringify(await envelope(advanced))}`);
    }
    status = (await body<AdvanceResponse>(advanced)).status;
    if (status.failure !== null) {
      throw new Error(`compilation failed: ${status.failure.code} at ${status.failure.stage}`);
    }
  }

  const versionId = status.version_id;
  expect(versionId, "the compilation produced no version").not.toBeNull();

  const activated = await handleActivate(
    mutation(`/api/projects/${state.projectId}/activate`, {
      cookie: state.cookie,
      body: JSON.stringify({ expected_revision: revision, version_id: versionId }),
    }),
    state.deps,
    state.projectId,
  );
  if (activated.status !== 200) {
    throw new Error(`activate failed: ${JSON.stringify(await envelope(activated))}`);
  }

  const read = await readState({ ...state, revision });
  return { versionId: versionId as string, revision: read.project.revision };
}

/** A project whose active version was built and confirmed by the real path. */
export async function activeProject(
  slots: readonly Slot[],
  compiler: FakeCompiler = happyCompiler(slots),
): Promise<ActiveProject> {
  const approved = await approvedProject(slots, compiler);
  const { versionId, revision } = await compileAndActivate(approved);
  return { ...approved, versionId, activeRevision: revision };
}

export type ProjectState = {
  project: ProjectView;
  playable: PlayableView | null;
  previous_playable: PlayableView | null;
  versions: SceneVersionSummary[];
  publications: PublicationSummary[];
};

export async function readState(state: ApprovedProject): Promise<ProjectState> {
  const response = await handleReadProject(
    readRequest(`/api/projects/${state.projectId}`, state.cookie),
    state.deps,
    state.projectId,
  );
  expect(response.status).toBe(200);
  return body<ProjectState>(response);
}

/** The diff the project read reports for the version currently on offer. */
export function diffOf(read: ProjectState): RevisionDiffView | null {
  return read.playable?.diff ?? null;
}
