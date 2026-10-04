import { describe, expect, it } from "vitest";
import { RADIOHEAD_ENTITY_ID } from "../../fixtures/qloo";
import { SECOND_COPY_BRIEF } from "../../fixtures/second-copy";
import type { ApprovedInfluence } from "../../src/domain/influence";
import type { ReferenceCapture } from "../../src/domain/qloo";
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
import { resolveApprovals } from "../../src/server/influence/approvals";
import {
  buildApprovedInfluencePayload,
  buildApprovedInfluencePayloads,
  buildProposalPayload,
  selectEligibleReferences,
} from "../../src/server/influence/payload";
import { captureIdsForApprovals } from "../../src/server/influence/provenance";
import { readCapturesByIds } from "../../src/server/qloo/cache";
import {
  normalizeReferences,
  referenceFingerprint,
} from "../../src/server/qloo/normalize";
import {
  body,
  harness,
  type Harness,
  jsonResponse,
  mutation,
  owner,
  project,
  routedTransport,
} from "./support/phase3-harness";
import { requireOwnerSession } from "../../src/server/db/sessions";
import { readProjectForOwner } from "../../src/server/db/projects";

/**
 * Distinct sentinel strings, planted in the cultural material that must never
 * reach a compiler-facing payload.
 *
 * Each one is unique and unmistakable, so an assertion that a payload does not
 * contain it is a real dataflow statement rather than a coincidence of
 * wording.
 */
const SENTINEL = {
  rejected: "SENTINEL_REJECTED_7f3a",
  unselected: "SENTINEL_UNSELECTED_91bc",
  otherSlot: "SENTINEL_OTHER_SLOT_c44d",
  artist: "SENTINEL_ARTIST_QUERY_2e8f",
  unusable: "SENTINEL_UNUSABLE_a001",
} as const;

const T0 = new Date("2026-10-04T10:00:00.000Z");

/** A synthetic insights payload whose rows carry the sentinels. */
function sentinelMovies(): unknown {
  return {
    success: true,
    results: {
      entities: [
        {
          name: "Approved Reference",
          entity_id: "aaaaaaaa-1111-4111-8111-111111111111",
          subtype: "urn:entity:movie",
          properties: {
            plot_summary: "A letter arrives bearing two different names.",
            plot_themes_description: "Identity that does not match itself.",
          },
        },
        {
          name: `Rejected Reference ${SENTINEL.rejected}`,
          entity_id: "bbbbbbbb-2222-4222-8222-222222222222",
          subtype: "urn:entity:movie",
          properties: {
            plot_summary: `A story that was dismissed. ${SENTINEL.rejected}`,
            plot_themes_description: `Dismissed theme. ${SENTINEL.rejected}`,
          },
        },
        {
          name: `Unselected Reference ${SENTINEL.unselected}`,
          entity_id: "cccccccc-3333-4333-8333-333333333333",
          subtype: "urn:entity:movie",
          properties: {
            plot_summary: `A story nobody chose. ${SENTINEL.unselected}`,
            plot_themes_description: `Unchosen theme. ${SENTINEL.unselected}`,
          },
        },
        {
          name: `Unusable Reference ${SENTINEL.unusable}`,
          entity_id: "dddddddd-4444-4444-8444-444444444444",
          subtype: "urn:entity:movie",
          properties: {},
        },
      ],
    },
  };
}

function sentinelGames(): unknown {
  return {
    success: true,
    results: {
      entities: [
        {
          name: `Other Slot Reference ${SENTINEL.otherSlot}`,
          entity_id: "eeeeeeee-5555-4555-8555-555555555555",
          subtype: "urn:entity:videogame",
          properties: {
            description: `A game about promises that foreclose choices. ${SENTINEL.otherSlot}`,
            audience_tags: [`moral choices ${SENTINEL.otherSlot}`],
          },
        },
      ],
    },
  };
}

function sentinelTransport() {
  return routedTransport({
    search: () =>
      jsonResponse({
        results: [
          {
            name: "Sentinel Artist",
            entity_id: RADIOHEAD_ENTITY_ID,
            types: ["urn:entity:artist"],
            disambiguation: SENTINEL.artist,
            properties: { short_description: SENTINEL.artist, external: {} },
          },
        ],
      }),
    movie: () => jsonResponse(sentinelMovies()),
    videogame: () => jsonResponse(sentinelGames()),
  });
}

/** Normalizes the sentinel payloads directly, for the pure builder tests. */
function sentinelCaptures(): ReferenceCapture[] {
  return (
    [
      ["movie", sentinelMovies(), "11111111-1111-4111-8111-111111111111"],
      ["videogame", sentinelGames(), "22222222-2222-4222-8222-222222222222"],
    ] as const
  ).map(([domain, raw, captureId]) => {
    const normalized = normalizeReferences(raw, {
      domain,
      artistEntityId: RADIOHEAD_ENTITY_ID,
      requestFingerprint: referenceFingerprint({
        host: "qloo.invalid",
        artistEntityId: RADIOHEAD_ENTITY_ID,
        domain,
      }),
      retrievedAt: T0.toISOString(),
    });
    return { ...normalized, capture_id: captureId, cache: "live" as const };
  });
}

describe("the proposal payload", () => {
  const captures = sentinelCaptures();

  it("carries no artist query, name, or description", () => {
    const payload = buildProposalPayload(
      SECOND_COPY_BRIEF,
      selectEligibleReferences(captures),
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(SENTINEL.artist);
    expect(serialized).not.toContain(RADIOHEAD_ENTITY_ID);
  });

  it("carries no identity-only reference", () => {
    const payload = buildProposalPayload(
      SECOND_COPY_BRIEF,
      selectEligibleReferences(captures),
    );
    expect(JSON.stringify(payload)).not.toContain(SENTINEL.unusable);
  });

  it("does carry the eligible references, so the test above means something", () => {
    // A negative assertion is only evidence if the positive one holds too.
    const payload = buildProposalPayload(
      SECOND_COPY_BRIEF,
      selectEligibleReferences(captures),
    );
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain(SENTINEL.rejected);
    expect(serialized).toContain(SENTINEL.unselected);
    expect(serialized).toContain(SENTINEL.otherSlot);
  });
});

describe("the approved-influence payload", () => {
  const captures = sentinelCaptures();
  const movies = captures[0]!;
  const games = captures[1]!;
  const approvedCandidate = movies.candidates[0]!;

  function approval(overrides: Partial<ApprovedInfluence> = {}): ApprovedInfluence {
    return {
      approval_id: "99999999-9999-4999-8999-999999999999",
      slot: "discovery",
      reference_id: approvedCandidate.reference_id,
      entity_id: approvedCandidate.entity_id,
      reference_name: approvedCandidate.name,
      domain: "movie",
      capture_id: movies.capture_id,
      selected_evidence_ids: [approvedCandidate.evidence[0]!.id],
      approved_text: "Inspecting the letter reveals two names.",
      intended_effect: "Asking about the second name opens returning it.",
      proposed_idea: "Borrow the idea of a contradictory identity.",
      proposed_interaction: "Inspecting reveals two names.",
      proposed_relevance: "The cited summary turns on a mismatched identity.",
      edited_by_creator: false,
      source_kind: "qloo",
      project_revision: 4,
      predecessor_id: null,
      approved_at: T0.toISOString(),
      ...overrides,
    };
  }

  it("contains only this approval, this reference, and this evidence", () => {
    const payload = buildApprovedInfluencePayload(approval(), movies);
    expect(payload).not.toBeNull();
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(SENTINEL.rejected);
    expect(serialized).not.toContain(SENTINEL.unselected);
    expect(serialized).not.toContain(SENTINEL.otherSlot);
    expect(serialized).not.toContain(SENTINEL.unusable);
    expect(serialized).not.toContain(SENTINEL.artist);
    expect(serialized).not.toContain(RADIOHEAD_ENTITY_ID);
    expect(serialized).not.toContain("affinity");
    expect(serialized).not.toContain("capture_id");
    expect(serialized).not.toContain("request_fingerprint");
    expect(serialized).not.toContain("original_rank");

    expect(payload?.slot).toBe("discovery");
    expect(payload?.evidence).toHaveLength(1);
    expect(payload?.evidence[0]?.id).toBe(approvedCandidate.evidence[0]!.id);
    expect(payload?.reference.name).toBe("Approved Reference");
  });

  it("carries only the cited evidence, not every item the reference has", () => {
    expect(approvedCandidate.evidence.length).toBeGreaterThan(1);
    const payload = buildApprovedInfluencePayload(approval(), movies);
    expect(payload?.evidence).toHaveLength(1);
    const uncited = approvedCandidate.evidence[1]!;
    expect(JSON.stringify(payload)).not.toContain(uncited.text);
  });

  it("refuses to build when a cited evidence id is missing from the capture", () => {
    expect(
      buildApprovedInfluencePayload(
        approval({ selected_evidence_ids: [`${approvedCandidate.reference_id}#ev99`] }),
        movies,
      ),
    ).toBeNull();
  });

  it("refuses to build against a capture from the other domain", () => {
    expect(buildApprovedInfluencePayload(approval(), games)).toBeNull();
  });

  it("refuses to build when the reference is not in the capture", () => {
    expect(
      buildApprovedInfluencePayload(approval({ reference_id: "ref.mv.0000000000000000" }), movies),
    ).toBeNull();
  });

  it("builds one payload per slot, and neither can observe the other", () => {
    const otherCandidate = games.candidates[0]!;
    const commitment = approval({
      approval_id: "88888888-8888-4888-8888-888888888888",
      slot: "commitment",
      reference_id: otherCandidate.reference_id,
      entity_id: otherCandidate.entity_id,
      reference_name: otherCandidate.name,
      domain: "videogame",
      capture_id: games.capture_id,
      selected_evidence_ids: [otherCandidate.evidence[0]!.id],
      approved_text: "A promise closes the option of keeping it.",
      intended_effect: "Promising forecloses withholding.",
    });

    const payloads = buildApprovedInfluencePayloads([approval(), commitment], captures);
    expect(payloads).toHaveLength(2);

    const discoveryPayload = payloads.find((payload) => payload.slot === "discovery")!;
    const commitmentPayload = payloads.find((payload) => payload.slot === "commitment")!;

    // The Discovery payload cannot see the Commitment sentinel.
    expect(JSON.stringify(discoveryPayload)).not.toContain(SENTINEL.otherSlot);
    // And the Commitment payload cannot see the Discovery reference at all.
    expect(JSON.stringify(commitmentPayload)).not.toContain("Approved Reference");
    expect(JSON.stringify(commitmentPayload)).not.toContain(SENTINEL.rejected);
    expect(JSON.stringify(commitmentPayload)).not.toContain(SENTINEL.unselected);
    // Each payload names only its own approval id.
    expect(discoveryPayload.approval_id).not.toBe(commitmentPayload.approval_id);
  });

  it("has no field a compiler could read as a scene change or a Qloo claim", () => {
    const payload = buildApprovedInfluencePayload(approval(), movies)!;
    expect(Object.keys(payload).sort()).toEqual([
      "approval_id",
      "approved_text",
      "evidence",
      "intended_effect",
      "reference",
      "slot",
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("qloo");
    expect(serialized).not.toContain("scene");
    expect(serialized).not.toContain("mechanic");
    expect(serialized).not.toContain("confidence");
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real routes
// ---------------------------------------------------------------------------

type Established = {
  h: Harness;
  cookie: string;
  projectId: string;
  revision: number;
  references: ReferencesResponse["references"];
  proposals: ProjectView["proposals"];
};

async function establish(script?: (refs: ReferencesResponse["references"]) => unknown): Promise<Established> {
  const probe = harness({ transport: sentinelTransport() });
  const probeState = await retrieve(probe);

  const answer = script ?? defaultAnswer;
  const h = harness({
    transport: sentinelTransport(),
    model: [{ parsed: answer(probeState.references) }],
  });
  const state = await retrieve(h);

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
    references: state.references,
    proposals: result.project.proposals,
  };
}

/** One proposal per displayed reference, so every sentinel is in the draft. */
function defaultAnswer(references: ReferencesResponse["references"]): unknown {
  const all = [...references.movie.displayed, ...references.videogame.displayed];
  return {
    proposals: all.map((candidate, index) => ({
      reference_id: candidate.reference_id,
      selected_evidence_ids: [candidate.evidence[0]!.id],
      slot: candidate.domain === "movie" ? "discovery" : "commitment",
      idea: `Interpretation ${index} drawn from the cited excerpt.`,
      intended_interaction: `Interaction ${index} the player performs.`,
      relevance: `Relevance ${index}, from the cited excerpt.`,
    })),
  };
}

async function retrieve(h: Harness): Promise<{
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
      body: JSON.stringify({ query: "Sentinel Artist" }),
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
  return { cookie, projectId, revision: result.project.revision, references: result.references };
}

describe("isolation through the real decision flow", () => {
  it("excludes every rejected, unselected, and other-slot sentinel from the approved payload", async () => {
    const state = await establish();

    const approvedProposal = state.proposals.find((proposal) =>
      proposal.reference_name.startsWith("Approved Reference"),
    )!;
    const rejectedProposal = state.proposals.find((proposal) =>
      proposal.reference_name.includes(SENTINEL.rejected),
    )!;
    const otherSlotProposal = state.proposals.find((proposal) =>
      proposal.reference_name.includes(SENTINEL.otherSlot),
    )!;
    // The unselected reference has a proposal but will never be decided on.
    expect(
      state.proposals.some((proposal) => proposal.reference_name.includes(SENTINEL.unselected)),
    ).toBe(true);

    let revision = state.revision;

    // Explicitly dismiss one.
    const dismissed = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: revision,
          kind: "reject",
          proposal_id: rejectedProposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    revision = (await body<DecisionsResponse>(dismissed)).project.revision;

    // Approve one into Discovery.
    const approved = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: revision,
          kind: "accept",
          proposal_id: approvedProposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    revision = (await body<DecisionsResponse>(approved)).project.revision;

    // Approve the other reference into Commitment, so a second slot exists.
    const committed = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: revision,
          kind: "accept",
          proposal_id: otherSlotProposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    expect(committed.status).toBe(200);

    // Now build the compiler-facing payloads from the committed state alone.
    const gateway = state.h.deps.gateway();
    const session = await requireOwnerSession(
      gateway,
      state.cookie.split("=")[1] ?? null,
      state.h.now(),
    );
    const row = (await readProjectForOwner(gateway, session, state.projectId))!;
    const approvals = await resolveApprovals(gateway, session, row);
    expect(approvals).toHaveLength(2);

    const captures = await readCapturesByIds(gateway, captureIdsForApprovals(approvals));
    const payloads = buildApprovedInfluencePayloads(approvals, captures);
    expect(payloads).toHaveLength(2);

    const discovery = payloads.find((payload) => payload.slot === "discovery")!;
    const commitment = payloads.find((payload) => payload.slot === "commitment")!;

    // The three sentinel exclusions the specification names.
    expect(JSON.stringify(discovery)).not.toContain(SENTINEL.rejected);
    expect(JSON.stringify(discovery)).not.toContain(SENTINEL.unselected);
    expect(JSON.stringify(discovery)).not.toContain(SENTINEL.otherSlot);
    expect(JSON.stringify(commitment)).not.toContain(SENTINEL.rejected);
    expect(JSON.stringify(commitment)).not.toContain(SENTINEL.unselected);
    expect(JSON.stringify(commitment)).not.toContain("Approved Reference");

    // And the artist that produced all of it is absent from both.
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toContain(SENTINEL.artist);
      expect(JSON.stringify(payload)).not.toContain(RADIOHEAD_ENTITY_ID);
    }

    // The positive half: each payload holds its own approval's own evidence.
    expect(discovery.evidence).toHaveLength(1);
    expect(commitment.evidence).toHaveLength(1);
    expect(discovery.evidence[0]?.id.startsWith(discovery.reference.reference_id)).toBe(true);
    expect(commitment.evidence[0]?.id.startsWith(commitment.reference.reference_id)).toBe(true);
  });

  it("drops a withdrawn approval from the compiler-facing payload entirely", async () => {
    const state = await establish();
    const approvedProposal = state.proposals.find((proposal) =>
      proposal.reference_name.startsWith("Approved Reference"),
    )!;

    const approved = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: state.revision,
          kind: "accept",
          proposal_id: approvedProposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    const afterApproval = await body<DecisionsResponse>(approved);

    const removed = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: afterApproval.project.revision,
          kind: "remove",
          slot: "discovery",
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    expect(removed.status).toBe(200);

    const gateway = state.h.deps.gateway();
    const session = await requireOwnerSession(
      gateway,
      state.cookie.split("=")[1] ?? null,
      state.h.now(),
    );
    const row = (await readProjectForOwner(gateway, session, state.projectId))!;
    const approvals = await resolveApprovals(gateway, session, row);
    expect(approvals).toEqual([]);
    expect(buildApprovedInfluencePayloads(approvals, [])).toEqual([]);

    // Recomposition starts from nothing, not from a scene that has to forget.
    const withdrawn = await body<DecisionsResponse>(removed);
    expect(withdrawn.project.approvals).toEqual([]);
    expect(withdrawn.project.provenance).toEqual([]);
    // The historical record of the approval is still there.
    expect(state.h.gateway.decisions.some((decision) => decision.decision_kind === "accept")).toBe(
      true,
    );
  });

  it("keeps the dismissed proposal out of the provenance the browser receives", async () => {
    const state = await establish();
    const rejectedProposal = state.proposals.find((proposal) =>
      proposal.reference_name.includes(SENTINEL.rejected),
    )!;
    const approvedProposal = state.proposals.find((proposal) =>
      proposal.reference_name.startsWith("Approved Reference"),
    )!;

    let revision = state.revision;
    const dismissed = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: revision,
          kind: "reject",
          proposal_id: rejectedProposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    revision = (await body<DecisionsResponse>(dismissed)).project.revision;

    const approved = await handleDecisions(
      mutation(`/api/projects/${state.projectId}/decisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: revision,
          kind: "accept",
          proposal_id: approvedProposal.proposal_id,
        }),
      }),
      state.h.deps,
      state.projectId,
    );
    const result = await body<DecisionsResponse>(approved);

    expect(JSON.stringify(result.project.provenance)).not.toContain(SENTINEL.rejected);
    expect(JSON.stringify(result.project.provenance)).not.toContain(SENTINEL.otherSlot);
    expect(result.project.provenance).toHaveLength(1);
  });
});

/**
 * The guarantee this file establishes is **dataflow and ownership isolation**:
 * the value a compiler would receive is built from one approval and its own
 * cited evidence, and the rejected, unselected, and other-slot material is not
 * reachable from it.
 *
 * It is deliberately not a claim that a language model could never
 * independently invent a semantically similar idea from the brief or from its
 * training. No test in this repository asserts that, because no test could.
 */
describe("what the isolation claim does and does not cover", () => {
  it("is a statement about reachability, not about semantics", () => {
    const captures = sentinelCaptures();
    const payload = buildProposalPayload(SECOND_COPY_BRIEF, selectEligibleReferences(captures));
    // The brief is present, so a model can still reach any idea the brief
    // itself supports. That is expected and is not a leak.
    expect(JSON.stringify(payload)).toContain(SECOND_COPY_BRIEF.premise);
  });
});
