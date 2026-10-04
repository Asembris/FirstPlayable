import type { Page, Route } from "@playwright/test";

import {
  SECOND_COPY_BASE,
  SECOND_COPY_BRIEF,
  SECOND_COPY_DISCOVERY_V1,
  SECOND_COPY_DISCOVERY_V2,
} from "../../../fixtures/second-copy";
import {
  type PublicSnapshot,
  PublicSnapshotSchema,
  PUBLIC_SNAPSHOT_SCHEMA,
  SHARE_WARNING,
} from "../../../src/domain/publish";
import { verifyCandidate } from "../../../src/server/compile/verify";
import { revisionDiffView } from "../../../src/server/revision/diff";
import { sceneChangedFrom } from "../../../src/server/db/versions";
import { previewHash } from "../../../src/server/revision/overrides";

/**
 * A deterministic stand-in for this application's own Phase 5 API.
 *
 * Why mock the application's own routes rather than the upstream services:
 * `playwright.config.ts` starts the app with invalid persistence sentinels, so
 * the browser gate needs no credential and reaches no external service. These
 * tests are therefore about the **studio and share interfaces** — can one
 * influence be removed, does the result carry the engine's own label, does the
 * comparison replay the same choices locally, does publishing preview exactly
 * what it will publish, is a share read-only, does revocation close it.
 *
 * What is **not** mocked is the scene, its validation, its comparison, or its
 * witness. The playables are the hand-authored Phase 1 fixtures, and the
 * validation summary, the "Scene changed" sentences, and the whole revision
 * diff — including its replay — are computed here by the **real** engine, so
 * the labels and sentences the browser renders are the ones the server produces.
 *
 * The route contract, the compare-and-swap, the attempt ceiling, the payload
 * isolation, the token hashing, and the snapshot whitelist are covered by the
 * offline unit suite against the real handlers.
 */

export const PROJECT_ID = "7c1c2d4e-5a6b-4c8d-9e0f-112233445566";
export const ACTIVE_VERSION_ID = "9e3e4f60-7c8d-4ea0-9012-334455667788";
export const PREVIOUS_VERSION_ID = "8d2d3e5f-6b7c-4d9e-8f01-223344556677";
export const PENDING_VERSION_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const PUBLICATION_ID = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
export const READ_TOKEN = "T".repeat(43);

const DISCOVERY_APPROVAL_UUID = "44444444-4444-4444-8444-000000000001";

/** The ending wording a scripted preview returns. */
export const KINDER_ENDING =
  "She takes the letter back and holds it a moment longer than she needs to. Whatever it cost her to ask, she does not make you carry it.";

function playableFor(
  scene: typeof SECOND_COPY_DISCOVERY_V1,
  versionId: string,
  state: "pending" | "active" | "superseded",
  options: { parent?: typeof SECOND_COPY_DISCOVERY_V1; parentId?: string } = {},
) {
  const approvals = scene.influences.map((influence) => influence.approval_id);
  const verdict = verifyCandidate(scene, SECOND_COPY_BRIEF, approvals);
  if (!verdict.ok) {
    throw new Error(
      `the phase 5 browser fixture must be valid: ${JSON.stringify(verdict.summary.finding_codes)}`,
    );
  }
  const diff =
    options.parent === undefined
      ? null
      : revisionDiffView({
          before: { versionId: options.parentId ?? PREVIOUS_VERSION_ID, scene: options.parent },
          after: { versionId, scene },
          changedBy: "remove",
        });
  return {
    version_id: versionId,
    state,
    created_at: "2026-10-04T11:00:00.000Z",
    scene,
    validation: verdict.summary,
    scene_changed: sceneChangedFrom(scene, verdict.summary),
    diff,
  };
}

/** The canonical pair: v1 is current, v2 is the version a revision produces. */
const ACTIVE = playableFor(SECOND_COPY_DISCOVERY_V1, ACTIVE_VERSION_ID, "active", {
  parent: SECOND_COPY_BASE,
  parentId: PREVIOUS_VERSION_ID,
});
const PREVIOUS = playableFor(SECOND_COPY_BASE, PREVIOUS_VERSION_ID, "superseded");
/** The result of revising the influence: the canonical mechanical difference. */
const REVISED = playableFor(SECOND_COPY_DISCOVERY_V2, PENDING_VERSION_ID, "pending", {
  parent: SECOND_COPY_DISCOVERY_V1,
  parentId: ACTIVE_VERSION_ID,
});
/** The result of removing it: the foundation alone. */
const REMOVED = playableFor(SECOND_COPY_BASE, PENDING_VERSION_ID, "pending", {
  parent: SECOND_COPY_DISCOVERY_V1,
  parentId: ACTIVE_VERSION_ID,
});

/** Parsed through the authoritative contract, so the mock cannot drift from it. */
export function publicSnapshot(includeProvenance = true): PublicSnapshot {
  return PublicSnapshotSchema.parse({
    schema: PUBLIC_SNAPSHOT_SCHEMA,
    title: SECOND_COPY_DISCOVERY_V1.title,
    version_id: ACTIVE_VERSION_ID,
    created_at: "2026-10-04T11:00:00.000Z",
    scene: SECOND_COPY_DISCOVERY_V1,
    active_slots: ["discovery"],
    identifiers: {
      model: "gpt-4o-mini-2024-07-18",
      compiler: "fp-compiler-4.2",
      validator: "fp-engine-validator-1.0",
    },
    provenance_included: includeProvenance,
    provenance: includeProvenance
      ? [
          {
            slot: "discovery",
            approval_id: SECOND_COPY_DISCOVERY_V1.influences[0]!.approval_id,
            retrieved: {
              reference_name: "Moon",
              domain: "movie",
              source_kind: SECOND_COPY_DISCOVERY_V1.influences[0]!.source_kind,
            },
            proposed: "Borrow the idea of a contradictory identity.",
            approved: {
              text: SECOND_COPY_DISCOVERY_V1.influences[0]!.approved_text,
              intended_effect: SECOND_COPY_DISCOVERY_V1.influences[0]!.intended_effect,
              edited_by_creator: false,
            },
            scene_changed: ACTIVE.scene_changed[0]?.witness.sentence ?? null,
          },
        ]
      : [],
  });
}

type VersionRow = {
  id: string;
  parent_version_id: string | null;
  state: string;
  created_at: string;
  base_hash: string;
  module_hashes: Record<string, string>;
  active_slots: string[];
  model_identifier: string;
  compiler_identifier: string;
  validator_identifier: string;
  revision_label: string | null;
};

export type Phase5Options = {
  /** Start with a link already published. */
  published?: boolean;
  /** Refuse every revision command with a finished failure. */
  refuseRevisions?: boolean;
};

export type Phase5State = { calls: string[] };

export async function installPhase5Api(
  page: Page,
  options: Phase5Options = {},
): Promise<Phase5State> {
  const calls: string[] = [];

  let revision = 7;
  let pending: "revised" | "removed" | null = null;
  let endingOverride: { ending_id: string; text: string } | null = null;
  let publicationRevoked = false;
  let published = options.published === true;
  let lastPreview: { ending_id: string; text: string; preview_hash: string } | null = null;

  function current() {
    if (pending === "revised") return REVISED;
    if (pending === "removed") return REMOVED;
    return ACTIVE;
  }

  function previous() {
    return pending === null ? PREVIOUS : ACTIVE;
  }

  function projectView() {
    return {
      id: PROJECT_ID,
      title: "The Second Copy",
      brief: SECOND_COPY_BRIEF,
      revision,
      workflow_state: pending === null ? "READY" : "REVIEW_PLAYABLE",
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
      active_version_id: ACTIVE_VERSION_ID,
      pending_version_id: pending === null ? null : PENDING_VERSION_ID,
      approved_slots: ["discovery"],
      approvals: [
        {
          approval_id: DISCOVERY_APPROVAL_UUID,
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
          proposed_relevance:
            "The cited excerpt turns on an identity that does not match itself.",
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

  function versions(): VersionRow[] {
    const list: VersionRow[] = [
      {
        id: ACTIVE_VERSION_ID,
        parent_version_id: PREVIOUS_VERSION_ID,
        state: pending === null ? "active" : "active",
        created_at: "2026-10-04T11:00:00.000Z",
        base_hash: "b".repeat(64),
        module_hashes: { discovery: "c".repeat(64) },
        active_slots: ["discovery"],
        model_identifier: "gpt-4o-mini-2024-07-18",
        compiler_identifier: "fp-compiler-4.2",
        validator_identifier: "fp-engine-validator-1.0",
        revision_label: ACTIVE.diff?.label ?? null,
      },
      {
        id: PREVIOUS_VERSION_ID,
        parent_version_id: null,
        state: "superseded",
        created_at: "2026-10-04T10:30:00.000Z",
        base_hash: "b".repeat(64),
        module_hashes: {},
        active_slots: [],
        model_identifier: "gpt-4o-mini-2024-07-18",
        compiler_identifier: "fp-compiler-4.2",
        validator_identifier: "fp-engine-validator-1.0",
        revision_label: null,
      },
    ];
    if (pending !== null) {
      list.unshift({
        id: PENDING_VERSION_ID,
        parent_version_id: ACTIVE_VERSION_ID,
        state: "pending",
        created_at: "2026-10-04T11:30:00.000Z",
        base_hash: "b".repeat(64),
        module_hashes: pending === "revised" ? { discovery: "d".repeat(64) } : {},
        active_slots: pending === "revised" ? ["discovery"] : [],
        model_identifier: "gpt-4o-mini-2024-07-18",
        compiler_identifier: "fp-compiler-4.2",
        validator_identifier: "fp-engine-validator-1.0",
        revision_label: current().diff?.label ?? null,
      });
    }
    return list;
  }

  function publications() {
    if (!published) return [];
    return [
      {
        id: PUBLICATION_ID,
        scene_version_id: ACTIVE_VERSION_ID,
        created_at: "2026-10-04T12:00:00.000Z",
        revoked_at: publicationRevoked ? "2026-10-04T12:30:00.000Z" : null,
        provenance_included: true,
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
        last_good_version_id: ACTIVE_VERSION_ID,
        request_id: "11111111-2222-3333-4444-555555555555",
      },
      statusCode,
    );
  }

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    calls.push(`${method} ${path}`);

    if (path === "/api/session") {
      await json(route, { established: true, expires_at: "2026-12-03T10:00:00.000Z" });
      return;
    }

    if (path.startsWith("/api/public/")) {
      const token = path.replace("/api/public/", "");
      if (token !== READ_TOKEN || publicationRevoked) {
        await failureResponse(
          route,
          404,
          "NOT_FOUND",
          "This playable could not be loaded.",
        );
        return;
      }
      await json(route, {
        snapshot: publicSnapshot(),
        published_at: "2026-10-04T12:00:00.000Z",
      });
      return;
    }

    if (path.startsWith("/api/publications/") && method === "DELETE") {
      publicationRevoked = true;
      await json(route, {
        outcome: "revoked",
        publication: {
          id: PUBLICATION_ID,
          scene_version_id: ACTIVE_VERSION_ID,
          created_at: "2026-10-04T12:00:00.000Z",
          revoked_at: "2026-10-04T12:30:00.000Z",
          provenance_included: true,
        },
      });
      return;
    }

    if (path.endsWith("/revisions")) {
      if (options.refuseRevisions === true) {
        await failureResponse(
          route,
          422,
          "REQUEST_REFUSED",
          "SLOT_EMPTY: That influence slot holds no approval, so there is nothing to change. Your active version 9e3e4f60-7c8d-4ea0-9012-334455667788 is unchanged and still plays.",
        );
        return;
      }
      const command = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      const kind = String(command["kind"]);

      if (kind === "ending_copy_preview") {
        const endingId = String(command["ending_id"]);
        lastPreview = {
          ending_id: endingId,
          text: KINDER_ENDING,
          preview_hash: previewHash(endingId, KINDER_ENDING),
        };
        await json(route, {
          outcome: "preview",
          kind,
          project: projectView(),
          decision_id: null,
          pending_version_id: null,
          last_good_version_id: ACTIVE_VERSION_ID,
          diff: null,
          preview: {
            ending_id: endingId,
            current_text:
              SECOND_COPY_DISCOVERY_V1.core.endings.find(
                (ending) => ending.id === endingId,
              )?.text ?? "",
            proposed_text: KINDER_ENDING,
            preview_hash: lastPreview.preview_hash,
            wording_only: true,
            model: "gpt-4o-mini-2024-07-18",
          },
          model_calls: 1,
        });
        return;
      }

      if (kind === "ending_copy_apply") {
        if (
          lastPreview === null ||
          lastPreview.preview_hash !== command["preview_hash"]
        ) {
          await failureResponse(
            route,
            422,
            "REQUEST_REFUSED",
            "PREVIEW_MISMATCH: This wording is not the one that was previewed.",
          );
          return;
        }
        endingOverride = { ending_id: lastPreview.ending_id, text: lastPreview.text };
        revision += 1;
        pending = "revised";
        await json(route, {
          outcome: "version_pending",
          kind,
          project: projectView(),
          decision_id: null,
          pending_version_id: PENDING_VERSION_ID,
          last_good_version_id: ACTIVE_VERSION_ID,
          diff: {
            ...(current().diff ?? {}),
            changed_by: "ending_copy_apply",
            label: "wording",
            mechanical_change: false,
            wording_change_only: true,
            summary: ["Wording changed; interaction unchanged."],
          },
          preview: null,
          model_calls: 0,
        });
        return;
      }

      if (kind === "edit") {
        revision += 1;
        await json(route, {
          outcome: "requires_compilation",
          kind,
          project: projectView(),
          decision_id: "55555555-5555-4555-8555-000000000002",
          pending_version_id: null,
          last_good_version_id: ACTIVE_VERSION_ID,
          diff: null,
          preview: null,
          model_calls: 0,
        });
        return;
      }

      // remove
      revision += 1;
      pending = "removed";
      await json(route, {
        outcome: "version_pending",
        kind,
        project: projectView(),
        decision_id: "55555555-5555-4555-8555-000000000003",
        pending_version_id: PENDING_VERSION_ID,
        last_good_version_id: ACTIVE_VERSION_ID,
        diff: REMOVED.diff,
        preview: null,
        model_calls: 0,
      });
      return;
    }

    if (path.endsWith("/publish")) {
      const request = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      const includeProvenance = request["include_provenance"] === true;
      const snapshot = publicSnapshot(includeProvenance);
      const hash = includeProvenance ? "a".repeat(48) : "b".repeat(48);
      if (request["preview"] === true) {
        await json(route, {
          outcome: "previewed",
          snapshot,
          snapshot_hash: hash,
          publication: null,
          play_path: null,
          warning: SHARE_WARNING,
        });
        return;
      }
      if (request["snapshot_hash"] !== hash) {
        await failureResponse(
          route,
          422,
          "REQUEST_REFUSED",
          "This is not the document that was previewed. Preview it again, then publish it.",
        );
        return;
      }
      published = true;
      publicationRevoked = false;
      await json(
        route,
        {
          outcome: "published",
          snapshot,
          snapshot_hash: hash,
          publication: {
            id: PUBLICATION_ID,
            scene_version_id: ACTIVE_VERSION_ID,
            created_at: "2026-10-04T12:00:00.000Z",
            revoked_at: null,
            provenance_included: includeProvenance,
          },
          play_path: `/play/${READ_TOKEN}`,
          warning: SHARE_WARNING,
        },
        201,
      );
      return;
    }

    if (path.endsWith("/activate")) {
      const request = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      if (request["decline"] === true) {
        pending = null;
        endingOverride = null;
        await json(route, {
          outcome: "declined",
          active_version_id: ACTIVE_VERSION_ID,
          pending_version_id: null,
          workflow_state: "READY",
        });
        return;
      }
      await json(route, {
        outcome: "activated",
        active_version_id: PENDING_VERSION_ID,
        pending_version_id: null,
        workflow_state: "READY",
      });
      return;
    }

    if (path.endsWith("/compile")) {
      await failureResponse(
        route,
        429,
        "RATE_LIMITED",
        "This browser has used its builds for today.",
      );
      return;
    }

    if (path.startsWith("/api/projects/")) {
      await json(route, {
        project: projectView(),
        references: null,
        playable: current(),
        previous_playable: previous(),
        versions: versions(),
        publications: publications(),
      });
      return;
    }

    await failureResponse(route, 404, "NOT_FOUND", "No project is available at this address.");
  });

  void endingOverride;
  return { calls };
}
