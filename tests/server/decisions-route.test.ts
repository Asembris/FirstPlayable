import { describe, expect, it } from "vitest";
import { LANTERNFOLD_ENTITY_ID } from "../../fixtures/qloo";
import type {
  DecisionsResponse,
  ProjectView,
  ProposalsResponse,
  ReferencesResponse,
} from "../../src/domain/project";
import { handleDecisions } from "../../src/server/api/decisions";
import { handleProposals } from "../../src/server/api/proposals";
import {
  handleArtistSearch,
  handleConfirmAnchor,
  handleReferences,
} from "../../src/server/api/qloo";
import { handleReadProject } from "../../src/server/api/projects";
import {
  body,
  envelope,
  harness,
  type Harness,
  type ModelScript,
  mutation,
  owner,
  project,
  readRequest,
} from "./support/phase3-harness";

/** Two proposals, one per slot, citing evidence from the synthetic captures. */
function modelAnswer(references: ReferencesResponse["references"]): unknown {
  const movie = references.movie.displayed[2] ?? references.movie.displayed[0]!;
  const game = references.videogame.displayed[0]!;
  const alternative = references.movie.displayed[0]!;
  return {
    proposals: [
      {
        reference_id: movie.reference_id,
        selected_evidence_ids: [movie.evidence[0]!.id, movie.evidence[1]!.id],
        slot: "discovery",
        idea: "Borrow the idea of a contradictory identity, not the film's plot.",
        intended_interaction: "Inspecting the letter reveals two names; ask about the second.",
        relevance: "The cited plot excerpt turns on an identity that does not match itself.",
      },
      {
        reference_id: game.reference_id,
        selected_evidence_ids: [game.evidence[0]!.id],
        slot: "commitment",
        idea: "Borrow the idea that a promise narrows what can happen next.",
        intended_interaction: "Promising to return it closes the option of keeping it.",
        relevance: "The cited description centres on choices that foreclose other choices.",
      },
      {
        reference_id: alternative.reference_id,
        selected_evidence_ids: [alternative.evidence[0]!.id],
        slot: "discovery",
        idea: "Borrow the idea of a document that outlives the people in it.",
        intended_interaction: "The letter names someone who will never collect it.",
        relevance: "The cited summary dwells on what survives the people involved.",
      },
    ],
  };
}

type Flow = {
  h: Harness;
  cookie: string;
  projectId: string;
  revision: number;
  proposals: ProjectView["proposals"];
};

/** Search, confirm, retrieve, propose. The state a decision acts on. */
async function toProposals(
  scriptFor: (references: ReferencesResponse["references"]) => readonly ModelScript[] = (
    references,
  ) => [{ parsed: modelAnswer(references) }],
): Promise<Flow> {
  const probe = harness();
  const probeReferences = await run(probe);
  const h = harness({ model: scriptFor(probeReferences.references) });
  const state = await run(h);

  const proposed = await handleProposals(
    mutation(`/api/projects/${state.projectId}/proposals`, {
      cookie: state.cookie,
      body: JSON.stringify({ expected_revision: state.revision }),
    }),
    h.deps,
    state.projectId,
  );
  expect(proposed.status).toBe(200);
  const result = await body<ProposalsResponse>(proposed);
  return {
    h,
    cookie: state.cookie,
    projectId: state.projectId,
    revision: result.project.revision,
    proposals: result.project.proposals,
  };
}

async function run(h: Harness): Promise<{
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
      body: JSON.stringify({ query: "Lanternfold" }),
    }),
    h.deps,
    projectId,
  );
  const searched = await body<{ search: { capture_id: string }; project: ProjectView }>(search);

  const anchor = await handleConfirmAnchor(
    mutation(`/api/projects/${projectId}/anchor`, {
      method: "PUT",
      cookie,
      body: JSON.stringify({
        expected_revision: searched.project.revision,
        search_capture_id: searched.search.capture_id,
        entity_id: LANTERNFOLD_ENTITY_ID,
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
  return { cookie, projectId, revision: result.project.revision, references: result.references };
}

async function decide(flow: Flow, payload: unknown): Promise<Response> {
  return handleDecisions(
    mutation(`/api/projects/${flow.projectId}/decisions`, {
      cookie: flow.cookie,
      body: JSON.stringify(payload),
    }),
    flow.h.deps,
    flow.projectId,
  );
}

describe("the default approved count", () => {
  it("is zero after retrieval and after proposals, and stays zero until asked", async () => {
    const flow = await toProposals();
    expect(flow.proposals).toHaveLength(3);

    const reload = await handleReadProject(
      readRequest(`/api/projects/${flow.projectId}`, flow.cookie),
      flow.h.deps,
      flow.projectId,
    );
    const view = await body<{ project: ProjectView }>(reload);
    expect(view.project.approved_slots).toEqual([]);
    expect(view.project.approvals).toEqual([]);
    expect(view.project.provenance).toEqual([]);
    expect(flow.h.gateway.decisions).toEqual([]);
  });
});

describe("POST /api/projects/:id/decisions — accept", () => {
  it("approves one proposal into its slot and freezes its wording", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;

    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: proposal.proposal_id,
    });
    expect(response.status).toBe(200);
    const result = await body<DecisionsResponse>(response);

    expect(result.kind).toBe("accept");
    expect(result.replaced_approval_id).toBeNull();
    expect(result.project.approved_slots).toEqual(["discovery"]);
    expect(result.project.approvals).toHaveLength(1);

    const approval = result.project.approvals[0]!;
    expect(approval.approval_id).toBe(result.decision_id);
    expect(approval.slot).toBe("discovery");
    expect(approval.approved_text).toBe(proposal.idea);
    expect(approval.intended_effect).toBe(proposal.intended_interaction);
    expect(approval.edited_by_creator).toBe(false);
    expect(approval.source_kind).toBe("qloo");
    expect(approval.selected_evidence_ids).toEqual(proposal.selected_evidence_ids);
    expect(approval.predecessor_id).toBeNull();
    // A decision is a consequential creator edit, so the revision moved.
    expect(result.project.revision).toBe(flow.revision + 1);
  });

  it("exposes the three provenance layers, and no fourth one", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: proposal.proposal_id,
    });
    const result = await body<DecisionsResponse>(response);
    const chain = result.project.provenance[0]!;

    expect(Object.keys(chain).sort()).toEqual([
      "approval_id",
      "approved",
      "proposed",
      "retrieved",
      "slot",
    ]);
    // Phase 4's "Scene changed" layer has no field to live in.
    expect(JSON.stringify(chain)).not.toContain("scene_changed");
    expect(JSON.stringify(chain)).not.toContain("mechanic");

    expect(chain.retrieved?.reference_name).toBe(proposal.reference_name);
    expect(chain.retrieved?.entity_id).toBe(proposal.entity_id);
    expect(chain.retrieved?.captured_at).toMatch(/^2026-10-04T/);
    expect(chain.retrieved?.original_rank).toBeGreaterThan(0);
    // Only the evidence this approval cites.
    expect(chain.retrieved?.evidence.map((item) => item.id)).toEqual(
      proposal.selected_evidence_ids,
    );
    expect(chain.proposed.attribution).toContain("not a Qloo assertion");
    expect(chain.approved.edited_by_creator).toBe(false);
    // No affinity anywhere in the chain.
    expect(JSON.stringify(chain)).not.toContain("affinity");
  });

  it("refuses to accept into a slot that already holds an approval", async () => {
    const flow = await toProposals();
    const first = flow.proposals[0]!;
    const alternative = flow.proposals[2]!;
    expect(alternative.slot).toBe("discovery");

    const accepted = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: first.proposal_id,
    });
    const after = await body<DecisionsResponse>(accepted);

    const second = await decide(flow, {
      expected_revision: after.project.revision,
      kind: "accept",
      proposal_id: alternative.proposal_id,
    });
    expect(second.status).toBe(422);
    expect((await envelope(second)).message).toContain("not acceptable");

    // Still exactly one Discovery approval, still the first one.
    const reload = await handleReadProject(
      readRequest(`/api/projects/${flow.projectId}`, flow.cookie),
      flow.h.deps,
      flow.projectId,
    );
    const view = await body<{ project: ProjectView }>(reload);
    expect(view.project.approvals).toHaveLength(1);
    expect(view.project.approvals[0]?.approved_text).toBe(first.idea);
  });

  it("holds at most one approval per slot across both slots", async () => {
    const flow = await toProposals();
    let revision = flow.revision;
    for (const proposal of [flow.proposals[0]!, flow.proposals[1]!]) {
      const response = await decide(flow, {
        expected_revision: revision,
        kind: "accept",
        proposal_id: proposal.proposal_id,
      });
      expect(response.status).toBe(200);
      revision = (await body<DecisionsResponse>(response)).project.revision;
    }
    const reload = await handleReadProject(
      readRequest(`/api/projects/${flow.projectId}`, flow.cookie),
      flow.h.deps,
      flow.projectId,
    );
    const view = await body<{ project: ProjectView }>(reload);
    expect(view.project.approved_slots.sort()).toEqual(["commitment", "discovery"]);
    expect(view.project.approvals).toHaveLength(2);
    expect(view.project.provenance).toHaveLength(2);
  });

  it("lets the creator narrow the cited evidence, but never widen it", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    expect(proposal.selected_evidence_ids).toHaveLength(2);

    const narrowed = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: proposal.proposal_id,
      selected_evidence_ids: [proposal.selected_evidence_ids[0]!],
    });
    expect(narrowed.status).toBe(200);
    const result = await body<DecisionsResponse>(narrowed);
    expect(result.project.approvals[0]?.selected_evidence_ids).toEqual([
      proposal.selected_evidence_ids[0],
    ]);

    // Another reference's evidence is refused outright.
    const other = flow.proposals[1]!;
    const widened = await decide(flow, {
      expected_revision: result.project.revision,
      kind: "accept",
      proposal_id: other.proposal_id,
      selected_evidence_ids: [proposal.selected_evidence_ids[0]!],
    });
    expect(widened.status).toBe(422);
  });

  it("refuses a proposal that is not in the current set", async () => {
    const flow = await toProposals();
    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: "pr.deadbeefdeadbeefdead",
    });
    expect(response.status).toBe(422);
  });
});

describe("POST /api/projects/:id/decisions — edit", () => {
  it("approves the creator's wording and marks it edited", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    const text = "Inspecting the letter shows two names. Ask Nia which one is hers.";
    const effect = "Asking about the second name is what opens returning it.";

    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "edit",
      proposal_id: proposal.proposal_id,
      approved_text: text,
      intended_effect: effect,
    });
    expect(response.status).toBe(200);
    const result = await body<DecisionsResponse>(response);

    expect(result.kind).toBe("edit");
    const approval = result.project.approvals[0]!;
    expect(approval.approved_text).toBe(text);
    expect(approval.intended_effect).toBe(effect);
    expect(approval.edited_by_creator).toBe(true);

    // The proposal's own wording survives untouched beside the edit, so the
    // two provenance layers stay distinguishable.
    expect(approval.proposed_idea).toBe(proposal.idea);
    expect(approval.proposed_interaction).toBe(proposal.intended_interaction);

    const chain = result.project.provenance[0]!;
    expect(chain.proposed.idea).toBe(proposal.idea);
    expect(chain.approved.text).toBe(text);
    expect(chain.approved.edited_by_creator).toBe(true);
  });

  it("never rewrites the stored Qloo evidence", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    const before = JSON.stringify([...flow.h.gateway.captures.values()]);

    await decide(flow, {
      expected_revision: flow.revision,
      kind: "edit",
      proposal_id: proposal.proposal_id,
      approved_text: "Something entirely of my own.",
      intended_effect: "My own effect.",
    });

    expect(JSON.stringify([...flow.h.gateway.captures.values()])).toBe(before);
  });

  it("refuses wording the brief itself forbids", async () => {
    const probe = harness();
    const probeState = await run(probe);
    const h = harness({ model: [{ parsed: modelAnswer(probeState.references) }] });

    const cookie = await owner(h);
    const projectId = await project(h, cookie, {
      ...(await (async () => {
        const { SECOND_COPY_BRIEF } = await import("../../fixtures/second-copy");
        return SECOND_COPY_BRIEF;
      })()),
      forbidden_wording: ["clone"],
    });

    const search = await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, {
        cookie,
        body: JSON.stringify({ query: "Lanternfold" }),
      }),
      h.deps,
      projectId,
    );
    const searched = await body<{ search: { capture_id: string }; project: ProjectView }>(search);
    const anchor = await handleConfirmAnchor(
      mutation(`/api/projects/${projectId}/anchor`, {
        method: "PUT",
        cookie,
        body: JSON.stringify({
          expected_revision: searched.project.revision,
          search_capture_id: searched.search.capture_id,
          entity_id: LANTERNFOLD_ENTITY_ID,
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
    const references = await body<ReferencesResponse>(retrieved);
    const proposed = await handleProposals(
      mutation(`/api/projects/${projectId}/proposals`, {
        cookie,
        body: JSON.stringify({ expected_revision: references.project.revision }),
      }),
      h.deps,
      projectId,
    );
    const draft = await body<ProposalsResponse>(proposed);

    const response = await handleDecisions(
      mutation(`/api/projects/${projectId}/decisions`, {
        cookie,
        body: JSON.stringify({
          expected_revision: draft.project.revision,
          kind: "edit",
          proposal_id: draft.project.proposals[0]!.proposal_id,
          approved_text: "A clone of the sender is waiting.",
          intended_effect: "Inspecting reveals the second name.",
        }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(422);
  });

  it("refuses empty and oversize wording", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    for (const payload of [
      { approved_text: "   ", intended_effect: "ok" },
      { approved_text: "x".repeat(701), intended_effect: "ok" },
      { approved_text: "ok", intended_effect: "x".repeat(301) },
    ]) {
      const response = await decide(flow, {
        expected_revision: flow.revision,
        kind: "edit",
        proposal_id: proposal.proposal_id,
        ...payload,
      });
      expect(response.status).toBe(422);
    }
  });
});

describe("POST /api/projects/:id/decisions — reject", () => {
  it("dismisses a proposal without approving or clearing anything", async () => {
    const flow = await toProposals();
    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "reject",
      proposal_id: flow.proposals[0]!.proposal_id,
    });
    expect(response.status).toBe(200);
    const result = await body<DecisionsResponse>(response);
    expect(result.kind).toBe("reject");
    expect(result.project.approved_slots).toEqual([]);
    expect(result.project.approvals).toEqual([]);
    // Still recorded, append-only.
    expect(flow.h.gateway.decisions).toHaveLength(1);
    expect(flow.h.gateway.decisions[0]?.decision_kind).toBe("reject");
    expect(flow.h.gateway.decisions[0]?.slot).toBeNull();
  });

  it("does not withdraw an approval the creator already made for that slot", async () => {
    const flow = await toProposals();
    const approved = flow.proposals[0]!;
    const alternative = flow.proposals[2]!;

    const accepted = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: approved.proposal_id,
    });
    const after = await body<DecisionsResponse>(accepted);

    const dismissed = await decide(flow, {
      expected_revision: after.project.revision,
      kind: "reject",
      proposal_id: alternative.proposal_id,
    });
    const result = await body<DecisionsResponse>(dismissed);

    // The decisive assertion: dismissing a card for an occupied slot is not a
    // withdrawal of what that slot holds.
    expect(result.project.approved_slots).toEqual(["discovery"]);
    expect(result.project.approvals[0]?.approval_id).toBe(after.decision_id);
  });
});

describe("POST /api/projects/:id/decisions — replace and remove", () => {
  it("replaces an occupied slot explicitly, recording the predecessor", async () => {
    const flow = await toProposals();
    const first = flow.proposals[0]!;
    const second = flow.proposals[2]!;

    const accepted = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: first.proposal_id,
    });
    const after = await body<DecisionsResponse>(accepted);

    const replaced = await decide(flow, {
      expected_revision: after.project.revision,
      kind: "replace",
      proposal_id: second.proposal_id,
    });
    expect(replaced.status).toBe(200);
    const result = await body<DecisionsResponse>(replaced);

    expect(result.kind).toBe("replace");
    expect(result.replaced_approval_id).toBe(after.decision_id);
    expect(result.project.approved_slots).toEqual(["discovery"]);
    expect(result.project.approvals).toHaveLength(1);
    const approval = result.project.approvals[0]!;
    expect(approval.approval_id).toBe(result.decision_id);
    expect(approval.predecessor_id).toBe(after.decision_id);
    expect(approval.approved_text).toBe(second.idea);

    // Both decisions survive. The old approved text was not rewritten.
    expect(flow.h.gateway.decisions).toHaveLength(2);
    const historical = flow.h.gateway.decisions[0]!;
    expect(historical.id).toBe(after.decision_id);
    expect(historical.creator_text).toBe(first.idea);
  });

  it("refuses a replacement when the slot is empty", async () => {
    const flow = await toProposals();
    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "replace",
      proposal_id: flow.proposals[0]!.proposal_id,
    });
    expect(response.status).toBe(422);
  });

  it("removes an approval, keeping its immutable record", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    const accepted = await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: proposal.proposal_id,
    });
    const after = await body<DecisionsResponse>(accepted);

    const removed = await decide(flow, {
      expected_revision: after.project.revision,
      kind: "remove",
      slot: "discovery",
    });
    expect(removed.status).toBe(200);
    const result = await body<DecisionsResponse>(removed);
    expect(result.project.approved_slots).toEqual([]);
    expect(result.project.approvals).toEqual([]);
    expect(result.project.provenance).toEqual([]);

    // The approval that was withdrawn is still on record, with its text.
    expect(flow.h.gateway.decisions).toHaveLength(2);
    expect(flow.h.gateway.decisions[0]?.creator_text).toBe(proposal.idea);
    expect(flow.h.gateway.decisions[1]?.decision_kind).toBe("remove");
    expect(flow.h.gateway.decisions[1]?.predecessor_id).toBe(after.decision_id);
  });

  it("refuses to remove from an empty slot", async () => {
    const flow = await toProposals();
    const response = await decide(flow, {
      expected_revision: flow.revision,
      kind: "remove",
      slot: "commitment",
    });
    expect(response.status).toBe(422);
  });
});

describe("decision safety", () => {
  it("survives a reload", async () => {
    const flow = await toProposals();
    const proposal = flow.proposals[0]!;
    await decide(flow, {
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: proposal.proposal_id,
    });

    // A second read, as a new serverless instance would perform it.
    const reload = await handleReadProject(
      readRequest(`/api/projects/${flow.projectId}`, flow.cookie),
      flow.h.deps,
      flow.projectId,
    );
    const view = await body<{ project: ProjectView }>(reload);
    expect(view.project.approvals).toHaveLength(1);
    expect(view.project.approvals[0]?.approved_text).toBe(proposal.idea);
    expect(view.project.provenance[0]?.retrieved?.reference_name).toBe(
      proposal.reference_name,
    );
  });

  it("rejects a decision taken against a stale revision", async () => {
    const flow = await toProposals();
    const response = await decide(flow, {
      expected_revision: 1,
      kind: "accept",
      proposal_id: flow.proposals[0]!.proposal_id,
    });
    expect(response.status).toBe(429);
    expect(flow.h.gateway.decisions).toEqual([]);
  });

  it("rejects a second decision replayed at the same revision", async () => {
    const flow = await toProposals();
    const payload = {
      expected_revision: flow.revision,
      kind: "accept" as const,
      proposal_id: flow.proposals[0]!.proposal_id,
    };
    const first = await decide(flow, payload);
    expect(first.status).toBe(200);
    // The compare-and-swap rejects the replay: the project has moved on.
    const second = await decide(flow, payload);
    expect(second.status).toBe(429);
    expect(flow.h.gateway.decisions).toHaveLength(1);
  });

  it("enforces origin, content type, body size, and ownership first", async () => {
    const flow = await toProposals();
    const path = `/api/projects/${flow.projectId}/decisions`;
    const good = JSON.stringify({
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: flow.proposals[0]!.proposal_id,
    });

    const cases: { request: Request; status: number; code: string }[] = [
      { request: mutation(path, { cookie: flow.cookie, body: good, origin: null }), status: 403, code: "ORIGIN_REQUIRED" },
      {
        request: mutation(path, { cookie: flow.cookie, body: good, origin: "https://evil.example" }),
        status: 403,
        code: "ORIGIN_MISMATCH",
      },
      {
        request: mutation(path, { cookie: flow.cookie, body: good, contentType: "text/plain" }),
        status: 415,
        code: "CONTENT_TYPE_UNSUPPORTED",
      },
      {
        request: mutation(path, {
          cookie: flow.cookie,
          body: JSON.stringify({
            expected_revision: flow.revision,
            kind: "edit",
            proposal_id: flow.proposals[0]!.proposal_id,
            approved_text: "x".repeat(20_000),
            intended_effect: "ok",
          }),
        }),
        status: 413,
        code: "BODY_TOO_LARGE",
      },
      { request: mutation(path, { cookie: null, body: good }), status: 401, code: "SESSION_REQUIRED" },
    ];

    for (const testCase of cases) {
      const response = await handleDecisions(testCase.request, flow.h.deps, flow.projectId);
      expect(response.status, testCase.code).toBe(testCase.status);
      expect((await envelope(response)).code).toBe(testCase.code);
    }
    expect(flow.h.gateway.decisions).toEqual([]);
  });

  it("answers a second owner exactly like a nonexistent project", async () => {
    const flow = await toProposals();
    const bob = await owner(flow.h);
    const good = JSON.stringify({
      expected_revision: flow.revision,
      kind: "accept",
      proposal_id: flow.proposals[0]!.proposal_id,
    });

    const foreign = await handleDecisions(
      mutation(`/api/projects/${flow.projectId}/decisions`, { cookie: bob, body: good }),
      flow.h.deps,
      flow.projectId,
    );
    const nonexistent = await handleDecisions(
      mutation("/api/projects/x/decisions", { cookie: bob, body: good }),
      flow.h.deps,
      "00000000-0000-4000-8000-000000000000",
    );
    for (const response of [foreign, nonexistent]) {
      expect(response.status).toBe(404);
      expect((await envelope(response)).code).toBe("NOT_FOUND");
    }
    expect(flow.h.gateway.decisions).toEqual([]);
  });

  it("accepts no approved flag, source kind, or approval id from the body", async () => {
    const flow = await toProposals();
    for (const hostile of [
      { kind: "accept", proposal_id: flow.proposals[0]!.proposal_id, approved: true },
      { kind: "accept", proposal_id: flow.proposals[0]!.proposal_id, source_kind: "qloo" },
      { kind: "accept", proposal_id: flow.proposals[0]!.proposal_id, approval_id: "x" },
      { kind: "accept", proposal_id: flow.proposals[0]!.proposal_id, entity_id: LANTERNFOLD_ENTITY_ID },
      { kind: "approve", proposal_id: flow.proposals[0]!.proposal_id },
    ]) {
      const response = await decide(flow, { expected_revision: flow.revision, ...hostile });
      expect(response.status, JSON.stringify(hostile).slice(0, 48)).toBe(422);
    }
    expect(flow.h.gateway.decisions).toEqual([]);
  });
});
