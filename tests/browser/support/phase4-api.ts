import type { Page, Route } from "@playwright/test";

import {
  SECOND_COPY_BASE,
  SECOND_COPY_BRIEF,
  SECOND_COPY_DISCOVERY_V1,
} from "../../../fixtures/second-copy";
import { validateScene } from "../../../src/engine/validate";
import { verifyCandidate } from "../../../src/server/compile/verify";
import { sceneChangedFrom } from "../../../src/server/db/versions";

/**
 * A deterministic stand-in for this application's own Phase 4 API, installed
 * with Playwright route interception.
 *
 * Why mock the application's own routes rather than the upstream services:
 * `playwright.config.ts` starts the app with invalid persistence sentinels, so
 * the browser gate needs no credential and reaches no external service. These
 * tests are therefore about the **studio UI** — can a build be started, does
 * the stage list tell the truth, does a reload resume, does the pending scene
 * play locally, is activation explicit. The controller, the attempt ceiling,
 * the compare-and-swap, and the validator are covered by the offline unit
 * suite against the in-memory gateway and the real handlers.
 *
 * What is *not* mocked is the scene or its validation. The playable this mock
 * serves is the hand-authored Phase 1 fixture, and its validation summary and
 * its "Scene changed" witness are computed here by the **real** engine, so the
 * sentences the browser renders are the same deterministic sentences the
 * server would produce.
 */

export const PROJECT_ID = "7c1c2d4e-5a6b-4c8d-9e0f-112233445566";
export const OPERATION_ID = "8d2d3e5f-6b7c-4d9e-8f01-223344556677";
export const VERSION_ID = "9e3e4f60-7c8d-4ea0-9012-334455667788";

const APPROVAL_ID = "approval_discovery_v1";

/** Computed once, by the real validator and the real witness search. */
function playableFor(state: "pending" | "active") {
  const scene = SECOND_COPY_DISCOVERY_V1;
  const verdict = verifyCandidate(scene, SECOND_COPY_BRIEF, [APPROVAL_ID]);
  if (!verdict.ok) {
    throw new Error(
      `the phase 4 browser fixture must be valid: ${JSON.stringify(verdict.summary.finding_codes)}`,
    );
  }
  return {
    version_id: VERSION_ID,
    state,
    created_at: "2026-10-04T11:00:00.000Z",
    scene,
    validation: verdict.summary,
    scene_changed: sceneChangedFrom(scene, verdict.summary),
  };
}

/** The base-only control, used to prove the panel labels an unmodulated version. */
export function baseIsValid(): boolean {
  return validateScene(SECOND_COPY_BASE, SECOND_COPY_BRIEF, { approvedApprovalIds: [] }).ok;
}

type Stage = "base" | "module_discovery" | "validate";

const STAGE_LABELS: Record<Stage, string> = {
  base: "Writing encounter",
  module_discovery: "Building Discovery",
  validate: "Checking choices",
};

const ORDER: Stage[] = ["base", "module_discovery", "validate"];

export type Phase4Options = {
  /** Fail the build at this stage, after its one repair. */
  failAt?: Stage;
  /** Start with a version already activated. */
  activated?: boolean;
  /** Start as if a previous build was interrupted after the base committed. */
  interruptedAfter?: Stage;
  /** Answer every project read as another browser would see it. */
  foreign?: boolean;
};

export type Phase4State = { calls: string[] };

const BRIEF = SECOND_COPY_BRIEF;

export async function installPhase4Api(
  page: Page,
  options: Phase4Options = {},
): Promise<Phase4State> {
  const calls: string[] = [];

  let revision = 5;
  let committed: Stage[] =
    options.interruptedAfter === undefined
      ? []
      : ORDER.slice(0, ORDER.indexOf(options.interruptedAfter) + 1);
  let failure: { code: string; stage: Stage; message: string } | null = null;
  /** Attempts per stage, so the panel's "repaired once" line can be exercised. */
  const attempts = new Map<Stage, number>();
  let pendingVersion: string | null = null;
  let activeVersion: string | null = options.activated === true ? VERSION_ID : null;
  let compileRequests = 0;

  function workflowState(): string {
    if (failure !== null) return "FAILED";
    if (pendingVersion !== null) return "REVIEW_PLAYABLE";
    if (activeVersion !== null) return "READY";
    if (committed.includes("module_discovery")) return "MODULES_READY";
    if (committed.includes("base")) return "BASE_READY";
    if (compileRequests > 0 || options.interruptedAfter !== undefined) {
      return "AWAITING_APPROVAL";
    }
    return "PROPOSALS_READY";
  }

  function nextStage(): Stage | null {
    if (failure !== null) return null;
    return ORDER.find((stage) => !committed.includes(stage)) ?? null;
  }

  function status() {
    const stage = nextStage();
    return {
      operation_id: OPERATION_ID,
      state:
        failure !== null
          ? "FAILED"
          : committed.includes("validate")
            ? "REVIEW_PLAYABLE"
            : committed.includes("module_discovery")
              ? "MODULES_READY"
              : committed.includes("base")
                ? "BASE_READY"
                : "AWAITING_APPROVAL",
      next_stage: stage,
      next_stage_label: stage === null ? null : STAGE_LABELS[stage],
      stages: ORDER.map((candidate) => ({
        stage: candidate,
        label: STAGE_LABELS[candidate],
        status: committed.includes(candidate)
          ? "committed"
          : failure?.stage === candidate
            ? "failed"
            : (attempts.get(candidate) ?? 0) > 0
              ? "pending"
              : "waiting",
        attempts: attempts.get(candidate) ?? 0,
        repaired: (attempts.get(candidate) ?? 0) > 1 && committed.includes(candidate),
      })),
      model_calls: [...attempts.values()].reduce((total, count) => total + count, 0),
      version_id: committed.includes("validate") ? VERSION_ID : null,
      failure,
      workflow_state: workflowState(),
      last_good_version_id: activeVersion,
    };
  }

  function projectView() {
    return {
      id: PROJECT_ID,
      title: "The Second Copy",
      brief: BRIEF,
      revision,
      workflow_state: workflowState(),
      anchor_confirmed: true,
      anchor: {
        entity_id: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
        name: "Radiohead",
        short_description: "An English rock band.",
        disambiguation: "Radiohead",
        identity_hints: ["musicbrainz"],
        query: "Radiohead",
        normalized_query: "radiohead",
        search_capture_id: "11111111-1111-4111-8111-111111111111",
        original_rank: 1,
        confirmed_at: "2026-10-04T10:00:00.000Z",
      },
      active_version_id: activeVersion,
      pending_version_id: pendingVersion,
      approved_slots: ["discovery"],
      approvals: [
        {
          approval_id: "44444444-4444-4444-8444-000000000001",
          slot: "discovery",
          reference_id: "ref.mv.moon",
          entity_id: "6BBB34F4-9345-4459-82AE-10991FA35CD2",
          reference_name: "Moon",
          domain: "movie",
          capture_id: "22222222-2222-4222-8222-222222222222",
          selected_evidence_ids: ["ref.mv.moon#ev1"],
          approved_text:
            "Inspection reveals an identity contradiction. Discussing it is required before returning the letter.",
          intended_effect:
            "Inspection unlocks a question; that question unlocks the return action.",
          proposed_idea: "Borrow the idea of a contradictory identity.",
          proposed_interaction: "Before returning it, ask about the second name.",
          proposed_relevance: "The cited excerpt turns on an identity that does not match itself.",
          edited_by_creator: false,
          source_kind: "qloo",
          project_revision: revision,
          predecessor_id: null,
          approved_at: "2026-10-04T10:05:00.000Z",
        },
      ],
      provenance: [],
      proposals: [],
      reference_capture_ids: ["22222222-2222-4222-8222-222222222222"],
      created_at: "2026-10-04T09:00:00.000Z",
      updated_at: "2026-10-04T11:00:00.000Z",
    };
  }

  function playable() {
    if (pendingVersion !== null) return playableFor("pending");
    if (activeVersion !== null) return playableFor("active");
    return null;
  }

  function versions() {
    if (pendingVersion === null && activeVersion === null) return [];
    return [
      {
        id: VERSION_ID,
        parent_version_id: null,
        state: pendingVersion !== null ? "pending" : "active",
        created_at: "2026-10-04T11:00:00.000Z",
        base_hash: "b".repeat(64),
        module_hashes: { discovery: "c".repeat(64) },
        active_slots: ["discovery"],
        model_identifier: "gpt-4o-mini-2024-07-18",
        compiler_identifier: "fp-compiler-4.2",
        validator_identifier: "fp-engine-validator-1.0",
      },
    ];
  }

  async function json(route: Route, bodyValue: unknown, statusCode = 200): Promise<void> {
    await route.fulfill({
      status: statusCode,
      contentType: "application/json",
      headers: { "x-request-id": "11111111-2222-3333-4444-555555555555" },
      body: JSON.stringify(bodyValue),
    });
  }

  async function failureResponse(
    route: Route,
    statusCode: number,
    code: string,
    message: string,
  ): Promise<void> {
    await json(
      route,
      {
        code,
        message,
        retryable: statusCode === 429,
        last_good_version_id: activeVersion,
        request_id: "11111111-2222-3333-4444-555555555555",
      },
      statusCode,
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
      await failureResponse(route, 404, "NOT_FOUND", "No project is available at this address.");
      return;
    }

    if (path.endsWith("/compile")) {
      compileRequests += 1;
      // Idempotent: a second request for the same frozen inputs replays.
      await json(route, { status: status(), replayed: compileRequests > 1 }, 201);
      return;
    }

    if (path.endsWith("/advance")) {
      const stage = nextStage();
      if (stage !== null) {
        const spent = (attempts.get(stage) ?? 0) + 1;
        attempts.set(stage, spent);
        if (options.failAt === stage) {
          // One normal attempt, one repair, then an explicit failure.
          if (spent >= 2) {
            failure = {
              code: "VALIDATION_FAILED",
              stage,
              message:
                "This draft did not pass the interaction checks. Edit or remove the approval and build again.",
            };
          }
        } else {
          committed = [...committed, stage];
          if (stage === "validate") pendingVersion = VERSION_ID;
        }
      }
      await json(route, { status: status(), model_calls: 1, replayed: false });
      return;
    }

    if (path.startsWith("/api/operations/")) {
      await json(route, { status: status(), replayed: true });
      return;
    }

    if (path.endsWith("/activate")) {
      const requestBody = (() => {
        try {
          return JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      if (requestBody["decline"] === true) {
        pendingVersion = null;
        await json(route, {
          outcome: "declined",
          active_version_id: activeVersion,
          pending_version_id: null,
          workflow_state: activeVersion === null ? "AWAITING_APPROVAL" : "READY",
        });
        return;
      }
      activeVersion = VERSION_ID;
      pendingVersion = null;
      await json(route, {
        outcome: "activated",
        active_version_id: activeVersion,
        pending_version_id: null,
        workflow_state: "READY",
      });
      return;
    }

    if (path.startsWith("/api/projects/")) {
      await json(route, {
        project: projectView(),
        references: null,
        playable: playable(),
        versions: versions(),
      });
      return;
    }

    await failureResponse(route, 404, "NOT_FOUND", "No project is available at this address.");
  });

  void revision;
  return { calls };
}
