import type { Page, Route } from "@playwright/test";

/**
 * A deterministic stand-in for this application's own phase 3 API, installed
 * with Playwright route interception.
 *
 * Why mock the application's own routes rather than the upstream services:
 * `playwright.config.ts` deliberately starts the app with invalid persistence
 * sentinels, so the browser gate needs no credential and reaches no external
 * service. These tests are therefore about the **studio UI** — the artist
 * confirmation step, the card layout, the decision controls, the provenance
 * drawer, and what survives a reload. The route handlers themselves, with
 * their real Zod contracts, ownership predicates, cache, and limiter, are
 * covered by the offline unit suite against the in-memory gateway.
 *
 * Every mocked route is same-origin by construction, which is exactly what the
 * "no direct upstream call from the browser" assertion needs: any request to a
 * Qloo, OpenAI, or Supabase host would be unmocked and would show up in the
 * foreign-request watcher.
 */

export const PROJECT_ID = "3f1c2d4e-5a6b-4c8d-9e0f-112233445566";

const LANTERNFOLD = "5A000000-0000-4000-8000-000000000001";

type Slot = "discovery" | "commitment";

type Evidence = { id: string; field_path: string; kind: string; text: string; hash: string; truncated: boolean };

type Candidate = {
  reference_id: string;
  entity_id: string;
  name: string;
  domain: "movie" | "videogame";
  original_rank: number;
  year: number | null;
  disambiguation: string | null;
  evidence: Evidence[];
  missing_fields: string[];
  usable: boolean;
  unusable_reason: string | null;
};

const HASH = "a".repeat(64);

function evidence(referenceId: string, index: number, path: string, kind: string, text: string): Evidence {
  return {
    id: `${referenceId}#ev${index}`,
    field_path: path,
    kind,
    text,
    hash: HASH,
    truncated: false,
  };
}

function movie(
  rank: number,
  name: string,
  year: number,
  entityId: string,
  plot: string,
  theme: string,
): Candidate {
  const referenceId = `ref.mv.${entityId.replace(/-/g, "").slice(-16).toLowerCase()}`;
  return {
    reference_id: referenceId,
    entity_id: entityId,
    name,
    domain: "movie",
    original_rank: rank,
    year,
    disambiguation: `${year}, director`,
    evidence: [
      evidence(referenceId, 1, "properties.plot_summary", "plot", plot),
      evidence(referenceId, 2, "properties.plot_themes_description", "theme", theme),
    ],
    missing_fields: [],
    usable: true,
    unusable_reason: null,
  };
}

function game(rank: number, name: string, year: number, entityId: string, description: string): Candidate {
  const referenceId = `ref.vg.${entityId.replace(/-/g, "").slice(-16).toLowerCase()}`;
  return {
    reference_id: referenceId,
    entity_id: entityId,
    name,
    domain: "videogame",
    original_rank: rank,
    year,
    disambiguation: `${year}, studio`,
    evidence: [
      evidence(referenceId, 1, "properties.description", "description", description),
      evidence(referenceId, 2, "properties.audience_tags", "tags", "moral choices, branching narrative"),
    ],
    missing_fields: [],
    usable: true,
    unusable_reason: null,
  };
}

export const MOVIES: Candidate[] = [
  movie(
    1,
    "Ashfall Covenant",
    2006,
    "5B000000-0000-4000-8000-000000000001",
    "A tired courier carries a sealed covenant across a region where volcanic ash has closed the roads.",
    "Asks who gets to cross a closing border, and what one messenger owes to the strangers travelling with her.",
  ),
  movie(
    2,
    "The Borrowed Window",
    1999,
    "5B000000-0000-4000-8000-000000000002",
    "A filing clerk discovers a narrow window that shows the world through the eyes of a stranger.",
    "Treats identity as something that can be rented, borrowed and resold.",
  ),
  movie(
    3,
    "Halcyon Relay",
    2009,
    "5B000000-0000-4000-8000-000000000003",
    "The lone technician on a remote relay station finds a duplicate of himself in a sealed maintenance bay.",
    "Asks what makes a person the same person by setting two copies of one man against the record of a single life.",
  ),
];

export const GAMES: Candidate[] = [
  game(
    1,
    "Starward Accord II",
    2010,
    "5C000000-0000-4000-8000-000000000001",
    "An invented commander gathers a reluctant crew for a mission whose survivors depend on every promise kept.",
  ),
  game(
    2,
    "Emberfall: Oaths",
    2009,
    "5C000000-0000-4000-8000-000000000002",
    "An invented dark-fantasy role-playing game in which alliances are won and lost by what you promise.",
  ),
];

const SKIPPED_MOVIES = [
  { original_rank: 4, name: "Second Draft Weather", reason: "beyond_display_limit" as const },
  { original_rank: 5, name: "Scale Model City", reason: "beyond_display_limit" as const },
];

export const ANCHOR = {
  entity_id: LANTERNFOLD,
  name: "Lanternfold",
  short_description:
    "Lanternfold is an invented art-rock band known for slow-building, experimental records; it exists only in FirstPlayable's synthetic fixtures.",
  disambiguation: "Lanternfold",
  identity_hints: ["lastfm", "musicbrainz", "spotify"],
  query: "Lanternfold",
  normalized_query: "lanternfold",
  search_capture_id: "11111111-1111-4111-8111-111111111111",
  original_rank: 1,
  confirmed_at: "2026-10-04T10:00:00.000Z",
};

const SEARCH_CANDIDATES = [
  {
    entity_id: LANTERNFOLD,
    name: "Lanternfold",
    short_description: ANCHOR.short_description,
    disambiguation: "Lanternfold",
    identity_hints: ["lastfm", "musicbrainz", "spotify"],
    original_rank: 1,
  },
  {
    entity_id: "5A000000-0000-4000-8000-000000000002",
    name: "Lanternfold Tribute",
    short_description: "An invented tribute act that performs the music of Lanternfold.",
    disambiguation: null,
    identity_hints: [],
    original_rank: 2,
  },
  {
    entity_id: "5A000000-0000-4000-8000-000000000005",
    name: "Ines Varga and Tobin Hale (Lanternfold)",
    short_description: null,
    disambiguation: null,
    identity_hints: [],
    original_rank: 3,
  },
];

const BRIEF = {
  title: "The Second Copy",
  premise:
    "The station is closing and one sealed letter is still behind the counter. The visitor who left it wants it back before the last train, and will not say who it is for.",
  player_role: "Station attendant",
  room: {
    id: "counter",
    name: "Lost-property counter",
    description: "The station is closing. You have one letter left to return.",
  },
  character: { id: "nia", name: "Nia", role: "Visitor asking for her letter" },
  object: {
    id: "letter",
    name: "Sealed letter",
    description: "One envelope, left behind earlier today.",
  },
  tone: "tense",
  cultural_anchor_query: null,
  forbidden_wording: [],
};

type Proposal = {
  proposal_id: string;
  reference_id: string;
  entity_id: string;
  reference_name: string;
  domain: "movie" | "videogame";
  capture_id: string;
  selected_evidence_ids: string[];
  slot: Slot;
  idea: string;
  intended_interaction: string;
  relevance: string;
};

function proposalFor(candidate: Candidate, slot: Slot, index: number): Proposal {
  return {
    proposal_id: `pr.${String(index).padStart(20, "0")}`,
    reference_id: candidate.reference_id,
    entity_id: candidate.entity_id,
    reference_name: candidate.name,
    domain: candidate.domain,
    capture_id:
      candidate.domain === "movie"
        ? "22222222-2222-4222-8222-222222222222"
        : "33333333-3333-4333-8333-333333333333",
    selected_evidence_ids: [candidate.evidence[0]!.id],
    slot,
    idea:
      candidate.name === "Halcyon Relay"
        ? "Borrow the idea of a contradictory identity, not the film's plot. Inspecting the letter reveals two names."
        : `An interpretation drawn from the retrieved context for ${candidate.name}.`,
    intended_interaction:
      candidate.name === "Halcyon Relay"
        ? "Before returning it, ask Nia about the second name."
        : `An interaction the player performs, drawn from ${candidate.name}.`,
    relevance: `This follows from the cited excerpt for ${candidate.name}.`,
  };
}

export type ApiOptions = {
  /** Start already past artist confirmation. */
  anchorConfirmed?: boolean;
  /** Start with both reference rows already retrieved. */
  referencesReady?: boolean;
  /** Start with the proposal draft already written. */
  proposalsReady?: boolean;
  /** Make one domain come back with nothing usable. */
  emptyDomain?: "movie" | "videogame";
  /** Make both domains come back with nothing usable. */
  bothUnusable?: boolean;
  /** Answer the project read as another browser would see it. */
  foreign?: boolean;
  /** Delay the references response, so the loading state is observable. */
  referencesDelayMs?: number;
};

export type ApiState = {
  /** Every path the browser asked this mock for, in order. */
  calls: string[];
};

/**
 * Installs the mock and returns the recorded call list.
 *
 * The state machine mirrors the real server's rules closely enough to be worth
 * testing against: the default approved count is zero, accepting into an
 * occupied slot is refused with a 422, a replacement records a predecessor,
 * and a dismissal never clears an approval.
 */
export async function installPhase3Api(page: Page, options: ApiOptions = {}): Promise<ApiState> {
  const calls: string[] = [];

  let revision = 1;
  let anchor: typeof ANCHOR | null = options.anchorConfirmed === true ? ANCHOR : null;
  let referencesRetrieved = options.referencesReady === true || options.proposalsReady === true;
  let proposals: Proposal[] = [];
  const approvals = new Map<Slot, { approval_id: string; proposal: Proposal; text: string; effect: string; edited: boolean; predecessor: string | null; at: string }>();
  let decisionCounter = 0;

  if (options.anchorConfirmed === true) revision = 2;
  if (options.proposalsReady === true) proposals = currentProposals();

  function usableMovies(): Candidate[] {
    if (options.bothUnusable === true || options.emptyDomain === "movie") return [];
    return MOVIES;
  }

  function usableGames(): Candidate[] {
    if (options.bothUnusable === true || options.emptyDomain === "videogame") return [];
    return GAMES;
  }

  function currentProposals(): Proposal[] {
    const list: Proposal[] = [];
    let index = 1;
    for (const candidate of usableMovies()) {
      list.push(proposalFor(candidate, "discovery", index));
      index += 1;
    }
    for (const candidate of usableGames()) {
      list.push(proposalFor(candidate, "commitment", index));
      index += 1;
    }
    return list;
  }

  function domainRow(domain: "movie" | "videogame") {
    const displayed = domain === "movie" ? usableMovies() : usableGames();
    const skipped = domain === "movie" && displayed.length > 0 ? SKIPPED_MOVIES : [];
    const unusable =
      displayed.length === 0
        ? [{ original_rank: 1, name: "Identity Only", reason: "no_usable_context" as const }]
        : [];
    return {
      domain,
      status: "ready" as const,
      cache: "live" as const,
      capture_id:
        domain === "movie"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      retrieved_at: "2026-10-04T10:00:00.000Z",
      displayed,
      skipped: [...skipped, ...unusable],
      returned_count: displayed.length + skipped.length + unusable.length,
      usable_count: displayed.length,
      stale_captured_at: null,
      failure_code: null,
    };
  }

  function referencesView() {
    if (!referencesRetrieved) return null;
    return {
      movie: domainRow("movie"),
      videogame: domainRow("videogame"),
      any_usable: usableMovies().length > 0 || usableGames().length > 0,
    };
  }

  function provenanceFor(slot: Slot) {
    const approval = approvals.get(slot);
    if (approval === undefined) return null;
    const candidate = [...MOVIES, ...GAMES].find(
      (entry) => entry.reference_id === approval.proposal.reference_id,
    )!;
    return {
      approval_id: approval.approval_id,
      slot,
      retrieved: {
        reference_name: candidate.name,
        domain: candidate.domain,
        year: candidate.year,
        entity_id: candidate.entity_id,
        original_rank: candidate.original_rank,
        captured_at: "2026-10-04T10:00:00.000Z",
        context: candidate.evidence[0]!.text,
        evidence: approval.proposal.selected_evidence_ids.map((id) => {
          const item = candidate.evidence.find((entry) => entry.id === id)!;
          return { id: item.id, field_path: item.field_path, text: item.text };
        }),
      },
      proposed: {
        idea: approval.proposal.idea,
        intended_interaction: approval.proposal.intended_interaction,
        relevance: approval.proposal.relevance,
        attribution: "FirstPlayable interpretation, not a Qloo assertion",
      },
      approved: {
        text: approval.text,
        intended_effect: approval.effect,
        edited_by_creator: approval.edited,
        approved_at: approval.at,
        slot,
        predecessor_id: approval.predecessor,
      },
    };
  }

  function projectView() {
    const slots: Slot[] = ["discovery", "commitment"];
    const present = slots.filter((slot) => approvals.has(slot));
    return {
      id: PROJECT_ID,
      title: "The Second Copy",
      brief: BRIEF,
      revision,
      workflow_state:
        proposals.length > 0
          ? "PROPOSALS_READY"
          : referencesRetrieved
            ? "REFERENCES_READY"
            : anchor !== null
              ? "ANCHOR_CONFIRMED"
              : "DRAFT",
      anchor_confirmed: anchor !== null,
      anchor,
      active_version_id: null,
      pending_version_id: null,
      approved_slots: present,
      approvals: present.map((slot) => {
        const approval = approvals.get(slot)!;
        return {
          approval_id: approval.approval_id,
          slot,
          reference_id: approval.proposal.reference_id,
          entity_id: approval.proposal.entity_id,
          reference_name: approval.proposal.reference_name,
          domain: approval.proposal.domain,
          capture_id: approval.proposal.capture_id,
          selected_evidence_ids: approval.proposal.selected_evidence_ids,
          approved_text: approval.text,
          intended_effect: approval.effect,
          proposed_idea: approval.proposal.idea,
          proposed_interaction: approval.proposal.intended_interaction,
          proposed_relevance: approval.proposal.relevance,
          edited_by_creator: approval.edited,
          source_kind: "qloo",
          project_revision: revision,
          predecessor_id: approval.predecessor,
          approved_at: approval.at,
        };
      }),
      provenance: present.map((slot) => provenanceFor(slot)).filter((chain) => chain !== null),
      proposals,
      reference_capture_ids: referencesRetrieved
        ? ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"]
        : [],
      created_at: "2026-10-04T09:00:00.000Z",
      updated_at: "2026-10-04T10:00:00.000Z",
    };
  }

  async function json(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "x-request-id": "11111111-2222-3333-4444-555555555555" },
      body: JSON.stringify(body),
    });
  }

  async function failure(route: Route, status: number, code: string, message: string): Promise<void> {
    await json(
      route,
      {
        code,
        message,
        retryable: status === 429,
        last_good_version_id: null,
        request_id: "11111111-2222-3333-4444-555555555555",
      },
      status,
    );
  }

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    calls.push(`${route.request().method()} ${path}`);

    if (path === "/api/session") {
      await json(route, { established: true, expires_at: "2026-12-03T10:00:00.000Z" });
      return;
    }

    if (options.foreign === true) {
      await failure(route, 404, "NOT_FOUND", "No project is available at this address.");
      return;
    }

    const body = (() => {
      try {
        return JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    })();

    if (path.endsWith("/artist-search")) {
      const query = String(body["query"] ?? "");
      await json(route, {
        search: {
          capture_id: ANCHOR.search_capture_id,
          query,
          normalized_query: query.trim().toLowerCase(),
          request_fingerprint: "search|qloo-norm-1|mocked",
          normalizer_version: "qloo-norm-1",
          retrieved_at: "2026-10-04T10:00:00.000Z",
          cache: "live",
          candidates: query.toLowerCase().includes("lantern") ? SEARCH_CANDIDATES : [],
        },
        project: projectView(),
      });
      return;
    }

    if (path.endsWith("/anchor")) {
      if (body["entity_id"] !== LANTERNFOLD) {
        // Only the chosen artist is installed; the mock mirrors the server in
        // refusing anything that was not in the named snapshot.
        await failure(route, 422, "VALIDATION_FAILED", "Some details in this request are not acceptable.");
        return;
      }
      anchor = ANCHOR;
      revision += 1;
      await json(route, { project: projectView(), invalidated: false, cleared_slots: [] });
      return;
    }

    if (path.endsWith("/references")) {
      if (options.referencesDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.referencesDelayMs));
      }
      referencesRetrieved = true;
      await json(route, { project: projectView(), references: referencesView(), upstream_calls: 2 });
      return;
    }

    if (path.endsWith("/proposals")) {
      proposals = currentProposals();
      await json(route, {
        project: projectView(),
        model_calls: 1,
        repaired: false,
        replayed: false,
      });
      return;
    }

    if (path.endsWith("/decisions")) {
      const kind = String(body["kind"] ?? "");
      if (Number(body["expected_revision"]) !== revision) {
        await failure(route, 429, "RATE_LIMITED", "Your choices changed while this request was in flight.");
        return;
      }

      if (kind === "remove") {
        const slot = String(body["slot"] ?? "") as Slot;
        approvals.delete(slot);
        revision += 1;
        await json(route, {
          project: projectView(),
          decision_id: nextDecisionId(),
          kind: "remove",
          replaced_approval_id: null,
        });
        return;
      }

      const proposal = proposals.find((entry) => entry.proposal_id === body["proposal_id"]);
      if (proposal === undefined) {
        await failure(route, 422, "VALIDATION_FAILED", "Some details in this request are not acceptable.");
        return;
      }

      if (kind === "reject") {
        revision += 1;
        await json(route, {
          project: projectView(),
          decision_id: nextDecisionId(),
          kind: "reject",
          replaced_approval_id: null,
        });
        return;
      }

      const slot = proposal.slot;
      const existing = approvals.get(slot);
      if (kind !== "replace" && existing !== undefined) {
        await failure(
          route,
          422,
          "VALIDATION_FAILED",
          "Some details in this request are not acceptable.",
        );
        return;
      }
      if (kind === "replace" && existing === undefined) {
        await failure(
          route,
          422,
          "VALIDATION_FAILED",
          "Some details in this request are not acceptable.",
        );
        return;
      }

      const text = typeof body["approved_text"] === "string" ? body["approved_text"] : proposal.idea;
      const effect =
        typeof body["intended_effect"] === "string"
          ? body["intended_effect"]
          : proposal.intended_interaction;
      const edited = text !== proposal.idea || effect !== proposal.intended_interaction;
      const decisionId = nextDecisionId();

      approvals.set(slot, {
        approval_id: decisionId,
        proposal,
        text,
        effect,
        edited,
        predecessor: existing?.approval_id ?? null,
        at: "2026-10-04T10:05:00.000Z",
      });
      revision += 1;
      await json(route, {
        project: projectView(),
        decision_id: decisionId,
        kind: kind === "replace" ? "replace" : edited ? "edit" : "accept",
        replaced_approval_id: kind === "replace" ? (existing?.approval_id ?? null) : null,
      });
      return;
    }

    if (path.startsWith("/api/projects/")) {
      // Phase 4 adds `playable` and `versions`; this phase 3 mock compiles
      // nothing, so both stay empty.
      await json(route, {
        project: projectView(),
        references: referencesView(),
        playable: null,
        versions: [],
      });
      return;
    }

    await failure(route, 404, "NOT_FOUND", "No project is available at this address.");
  });

  function nextDecisionId(): string {
    decisionCounter += 1;
    return `44444444-4444-4444-8444-${String(decisionCounter).padStart(12, "0")}`;
  }

  return { calls };
}
