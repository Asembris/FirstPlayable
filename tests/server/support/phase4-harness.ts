/**
 * The Phase 4 harness: a real project with real frozen approvals, driven
 * entirely offline.
 *
 * It walks the actual Phase 3 route handlers — artist search, anchor
 * confirmation, both first hops, the proposal stage, and explicit decisions —
 * over the pinned redacted Qloo captures and a scripted provider, and then
 * hands the Phase 4 routes the state those handlers produced. Nothing here
 * constructs an approval by hand, so what Phase 4 compiles is an approval the
 * Phase 3 code path actually created.
 *
 * The compiler is a deterministic {@link FakeCompiler}. Everything else is
 * production code: the real controller, the real payload builders, the real
 * Phase 1 validator, the real operation primitives, and the in-memory gateway
 * that re-implements the committed SQL.
 */

import { expect } from "vitest";
import { RADIOHEAD_ENTITY_ID } from "../../../fixtures/qloo";
import type { ProjectView, ProposalsResponse, ReferencesResponse } from "../../../src/domain/project";
import type { PlayableView, SceneVersionSummary } from "../../../src/domain/compile";
import type { Phase4Deps } from "../../../src/server/api/deps";
import { handleDecisions } from "../../../src/server/api/decisions";
import { handleProposals } from "../../../src/server/api/proposals";
import { handleReadProject } from "../../../src/server/api/projects";
import {
  handleArtistSearch,
  handleConfirmAnchor,
  handleReferences,
} from "../../../src/server/api/qloo";
import type { SceneCompiler } from "../../../src/server/compile/compiler";
import {
  body,
  harness,
  type Harness,
  type ModelScript,
  mutation,
  owner,
  project,
  readRequest,
} from "./phase3-harness";

export type Slot = "discovery" | "commitment";

/** One proposal per slot, citing real evidence out of the real captures. */
function proposalAnswer(references: ReferencesResponse["references"]): unknown {
  const movie = references.movie.displayed[2] ?? references.movie.displayed[0]!;
  const game = references.videogame.displayed[0]!;
  return {
    proposals: [
      {
        reference_id: movie.reference_id,
        selected_evidence_ids: [movie.evidence[0]!.id],
        slot: "discovery",
        idea: "Borrow the idea of a contradictory identity, not the film's plot.",
        intended_interaction: "Inspecting the letter reveals two names; ask about the second.",
        relevance: "The cited excerpt turns on an identity that does not match itself.",
      },
      {
        reference_id: game.reference_id,
        selected_evidence_ids: [game.evidence[0]!.id],
        slot: "commitment",
        idea: "Borrow the idea that a promise narrows what can happen next.",
        intended_interaction: "Naming the cost is required before the promise can be made.",
        relevance: "The cited description centres on choices that foreclose other choices.",
      },
    ],
  };
}

export type ApprovedProject = {
  readonly h: Harness;
  readonly cookie: string;
  readonly projectId: string;
  readonly revision: number;
  readonly approvedSlots: readonly Slot[];
  /** Phase 4 deps over the same gateway, with the deterministic compiler. */
  readonly deps: Phase4Deps;
};

/**
 * Walks the Phase 3 flow and approves one proposal per requested slot.
 *
 * Two harnesses are created because the proposal script has to cite reference
 * ids that only exist once the real captures have been normalized: the first
 * run discovers them, the second replays the whole flow with a script that
 * uses them. Both runs are offline.
 */
export async function approvedProject(
  slots: readonly Slot[],
  compiler: SceneCompiler,
): Promise<ApprovedProject> {
  const probe = harness();
  const discovered = await walkToReferences(probe);
  const script: readonly ModelScript[] = [{ parsed: proposalAnswer(discovered.references) }];

  const h = harness({ model: script });
  const state = await walkToReferences(h);

  const proposed = await handleProposals(
    mutation(`/api/projects/${state.projectId}/proposals`, {
      cookie: state.cookie,
      body: JSON.stringify({ expected_revision: state.revision }),
    }),
    h.deps,
    state.projectId,
  );
  expect(proposed.status).toBe(200);
  const draft = await body<ProposalsResponse>(proposed);

  let revision = draft.project.revision;
  for (const slot of slots) {
    const proposal = draft.project.proposals.find((candidate) => candidate.slot === slot);
    expect(proposal, `no proposal was returned for ${slot}`).toBeDefined();
    const decided = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: revision,
          kind: "accept",
          proposal_id: proposal?.proposal_id,
        }),
      }),
      h.deps,
      state.projectId,
    );
    expect(decided.status).toBe(200);
    revision = (await body<{ project: ProjectView }>(decided)).project.revision;
  }

  return {
    h,
    cookie: state.cookie,
    projectId: state.projectId,
    revision,
    approvedSlots: slots,
    deps: { gateway: h.deps.gateway, budget: h.deps.budget, now: h.now, compiler },
  };
}

async function walkToReferences(h: Harness): Promise<{
  cookie: string;
  projectId: string;
  revision: number;
  references: ReferencesResponse["references"];
}> {
  const cookie = await owner(h);
  const projectId = await project(h, cookie);

  const search = await handleArtistSearch(
    mutation(`/api/projects/${projectId}/artist-search`, {
      cookie,
      body: JSON.stringify({ query: "Radiohead" }),
    }),
    h.deps,
    projectId,
  );
  const searched = await body<{
    search: { capture_id: string };
    project: ProjectView;
  }>(search);

  const anchor = await handleConfirmAnchor(
    mutation(`/api/projects/${projectId}/anchor`, {
      method: "PUT",
      cookie,
      body: JSON.stringify({
        expected_revision: searched.project.revision,
        search_capture_id: searched.search.capture_id,
        entity_id: RADIOHEAD_ENTITY_ID,
      }),
    }),
    h.deps,
    projectId,
  );
  const confirmed = await body<{ project: ProjectView }>(anchor);

  const retrieved = await handleReferences(
    mutation(`/api/projects/${projectId}/references`, {
      cookie,
      body: JSON.stringify({ expected_revision: confirmed.project.revision }),
    }),
    h.deps,
    projectId,
  );
  const result = await body<ReferencesResponse>(retrieved);
  return {
    cookie,
    projectId,
    revision: result.project.revision,
    references: result.references,
  };
}

/* ------------------------------------------------------------ project read */

export type ProjectState = {
  project: ProjectView;
  playable: PlayableView | null;
  versions: SceneVersionSummary[];
};

export async function readProject(state: ApprovedProject): Promise<ProjectState> {
  const response = await handleReadProject(
    readRequest(`/api/projects/${state.projectId}`, state.cookie),
    state.deps,
    state.projectId,
  );
  expect(response.status).toBe(200);
  return body<ProjectState>(response);
}
