import { describe, expect, it } from "vitest";
import { MOON_ENTITY_ID, QLOO_FIXTURES, RADIOHEAD_ENTITY_ID } from "../../fixtures/qloo";
import type {
  ArtistSearchResponseSchema,
  ConfirmAnchorResponseSchema,
  ProjectView,
  ReferencesResponse,
} from "../../src/domain/project";
import type { z } from "zod";
import {
  handleArtistSearch,
  handleConfirmAnchor,
  handleReferences,
} from "../../src/server/api/qloo";
import { handleReadProject } from "../../src/server/api/projects";
import { CREATOR_COMMAND_BODY_LIMIT_BYTES } from "../../src/server/security/request";
import {
  body,
  envelope,
  harness,
  type Harness,
  jsonResponse,
  mutation,
  owner,
  project,
  readRequest,
  routedTransport,
} from "./support/phase3-harness";

type SearchResponse = z.infer<typeof ArtistSearchResponseSchema>;
type AnchorResponse = z.infer<typeof ConfirmAnchorResponseSchema>;

/** Search, then confirm Radiohead. The shared prelude of most tests below. */
async function confirmedProject(
  harnessed: Harness,
): Promise<{ cookie: string; projectId: string; revision: number }> {
  const cookie = await owner(harnessed);
  const projectId = await project(harnessed, cookie);

  const search = await handleArtistSearch(
    mutation(`/api/projects/${projectId}/artist-search`, {
      cookie,
      body: JSON.stringify({ query: "Radiohead" }),
    }),
    harnessed.deps,
    projectId,
  );
  expect(search.status).toBe(200);
  const searched = await body<SearchResponse>(search);

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
    harnessed.deps,
    projectId,
  );
  expect(anchor.status).toBe(200);
  const confirmed = await body<AnchorResponse>(anchor);
  return { cookie, projectId, revision: confirmed.project.revision };
}

describe("POST /api/projects/:id/artist-search", () => {
  it("refetches an expired search into a new immutable row and then reuses that fresh row", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    const request = () => handleArtistSearch(mutation(`/api/projects/${projectId}/artist-search`, {
      cookie, body: JSON.stringify({ query: "Radiohead" }),
    }), h.deps, projectId);
    const first = await body<SearchResponse>(await request());
    const oldId = first.search.capture_id!;
    const before = await h.gateway.findQlooCapturesByIds([oldId]);
    h.advance(24 * 60 * 60 * 1000 + 1000);
    const response = await request();
    expect(response.status).toBe(200);
    const fresh = await body<SearchResponse>(response);
    expect(fresh.search.capture_id).not.toBe(oldId);
    expect(h.transport.calls).toHaveLength(2);
    expect(await h.gateway.findQlooCapturesByIds([oldId])).toEqual(before);
    const [row] = await h.gateway.findQlooCapturesByIds([fresh.search.capture_id!]);
    expect(row?.captured_at).toBe(fresh.search.retrieved_at);
    expect(Date.parse(row!.cache_expires_at)).toBeGreaterThan(h.now().getTime());
    expect((await h.gateway.findQlooCaptureByFingerprint(row!.request_fingerprint))?.id).toBe(row?.id);
    const repeat = await body<SearchResponse>(await request());
    expect(repeat.search.capture_id).toBe(fresh.search.capture_id);
    expect(repeat.search.cache).toBe("cached");
    expect(h.transport.calls).toHaveLength(2);
    // An old search can still validate the historical creator choice.
    const confirmation = await handleConfirmAnchor(mutation(`/api/projects/${projectId}/anchor`, {
      method: "PUT", cookie, body: JSON.stringify({ expected_revision: first.project.revision,
        search_capture_id: oldId, entity_id: RADIOHEAD_ENTITY_ID }),
    }), h.deps, projectId);
    expect(confirmation.status).toBe(200);
  });

  it("returns every returned artist, in order, and selects none of them", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);

    const response = await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, {
        cookie,
        body: JSON.stringify({ query: "Radiohead" }),
      }),
      h.deps,
      projectId,
    );

    expect(response.status).toBe(200);
    const result = await body<SearchResponse>(response);
    expect(result.search.candidates).toHaveLength(5);
    expect(result.search.candidates[0]?.entity_id).toBe(RADIOHEAD_ENTITY_ID);
    expect(result.search.cache).toBe("live");
    // Searching is not confirming. The project is untouched.
    expect(result.project.anchor_confirmed).toBe(false);
    expect(result.project.anchor).toBeNull();
    expect(result.project.revision).toBe(1);
  });

  it("answers a repeated search from the capture, with zero upstream calls", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    const request = () =>
      handleArtistSearch(
        mutation(`/api/projects/${projectId}/artist-search`, {
          cookie,
          body: JSON.stringify({ query: "radiohead" }),
        }),
        h.deps,
        projectId,
      );

    await request();
    expect(h.transport.calls).toHaveLength(1);

    h.advance(60_000);
    const second = await request();
    const result = await body<SearchResponse>(second);
    expect(result.search.cache).toBe("cached");
    // Still one. The repeat made no request at all.
    expect(h.transport.calls).toHaveLength(1);
    expect(h.launches).toEqual(["artist_search"]);
  });

  it("treats a differently spaced and cased query as the same search", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    for (const query of ["Radiohead", "  radioHEAD ", "RADIOHEAD"]) {
      await handleArtistSearch(
        mutation(`/api/projects/${projectId}/artist-search`, {
          cookie,
          body: JSON.stringify({ query }),
        }),
        h.deps,
        projectId,
      );
    }
    expect(h.transport.calls).toHaveLength(1);
  });

  it("reports an unknown artist honestly and retrieves nothing downstream", async () => {
    const h = harness({
      transport: routedTransport({ search: () => jsonResponse(QLOO_FIXTURES.searchNoMatch) }),
    });
    const cookie = await owner(h);
    const projectId = await project(h, cookie);

    const response = await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, {
        cookie,
        body: JSON.stringify({ query: "zzqxvnotanartist" }),
      }),
      h.deps,
      projectId,
    );
    const result = await body<SearchResponse>(response);
    expect(result.search.candidates).toEqual([]);
    expect(result.project.anchor_confirmed).toBe(false);
    // One search, and no first hop was attempted.
    expect(h.transport.calls).toHaveLength(1);
  });

  it("accepts only a query, and never a caller-supplied parameter", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);

    for (const hostile of [
      { query: "Radiohead", types: "urn:entity:movie" },
      { query: "Radiohead", take: 50 },
      { query: "Radiohead", url: "https://example.invalid/" },
      { query: "Radiohead", "filter.type": "urn:entity:brand" },
    ]) {
      const response = await handleArtistSearch(
        mutation(`/api/projects/${projectId}/artist-search`, {
          cookie,
          body: JSON.stringify(hostile),
        }),
        h.deps,
        projectId,
      );
      expect(response.status).toBe(422);
      expect((await envelope(response)).code).toBe("VALIDATION_FAILED");
    }
    expect(h.transport.calls).toHaveLength(0);
  });

  it("refuses a query outside the declared length bounds", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    for (const query of ["", "a", "x".repeat(81)]) {
      const response = await handleArtistSearch(
        mutation(`/api/projects/${projectId}/artist-search`, {
          cookie,
          body: JSON.stringify({ query }),
        }),
        h.deps,
        projectId,
      );
      expect(response.status).toBe(422);
    }
    expect(h.transport.calls).toHaveLength(0);
  });

  it("enforces origin, content type, body size, and ownership before any call", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    const path = `/api/projects/${projectId}/artist-search`;
    const good = JSON.stringify({ query: "Radiohead" });

    const cases: { request: Request; status: number; code: string }[] = [
      {
        request: mutation(path, { cookie, body: good, origin: null }),
        status: 403,
        code: "ORIGIN_REQUIRED",
      },
      {
        request: mutation(path, { cookie, body: good, origin: "https://evil.example" }),
        status: 403,
        code: "ORIGIN_MISMATCH",
      },
      {
        request: mutation(path, { cookie, body: good, contentType: "text/plain" }),
        status: 415,
        code: "CONTENT_TYPE_UNSUPPORTED",
      },
      {
        request: mutation(path, {
          cookie,
          body: JSON.stringify({ query: "x".repeat(CREATOR_COMMAND_BODY_LIMIT_BYTES) }),
        }),
        status: 413,
        code: "BODY_TOO_LARGE",
      },
      { request: mutation(path, { cookie: null, body: good }), status: 401, code: "SESSION_REQUIRED" },
    ];

    for (const testCase of cases) {
      const response = await handleArtistSearch(testCase.request, h.deps, projectId);
      expect(response.status, testCase.code).toBe(testCase.status);
      expect((await envelope(response)).code).toBe(testCase.code);
    }
    expect(h.transport.calls).toHaveLength(0);
  });

  it("answers a foreign project exactly like a nonexistent one", async () => {
    const h = harness();
    const alice = await owner(h);
    const bob = await owner(h);
    const projectId = await project(h, alice);
    const good = JSON.stringify({ query: "Radiohead" });

    const foreign = await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, { cookie: bob, body: good }),
      h.deps,
      projectId,
    );
    const nonexistent = await handleArtistSearch(
      mutation("/api/projects/x/artist-search", { cookie: bob, body: good }),
      h.deps,
      "00000000-0000-4000-8000-000000000000",
    );
    const malformed = await handleArtistSearch(
      mutation("/api/projects/x/artist-search", { cookie: bob, body: good }),
      h.deps,
      "not-a-uuid",
    );

    for (const response of [foreign, nonexistent, malformed]) {
      expect(response.status).toBe(404);
      expect((await envelope(response)).code).toBe("NOT_FOUND");
    }
    expect(h.transport.calls).toHaveLength(0);
  });
});

describe("PUT /api/projects/:id/anchor", () => {
  it("freezes the artist the creator chose, with its rank and capture", async () => {
    const h = harness();
    const { projectId, cookie } = await confirmedProject(h);

    const response = await handleReadProject(
      readRequest(`/api/projects/${projectId}`, cookie),
      h.deps,
      projectId,
    );
    const { project: view } = await body<{ project: ProjectView }>(response);
    expect(view.anchor_confirmed).toBe(true);
    expect(view.anchor?.entity_id).toBe(RADIOHEAD_ENTITY_ID);
    expect(view.anchor?.name).toBe("Radiohead");
    expect(view.anchor?.original_rank).toBe(1);
    expect(view.anchor?.query).toBe("Radiohead");
    expect(view.anchor?.search_capture_id).not.toBeNull();
    expect(view.workflow_state).toBe("ANCHOR_CONFIRMED");
    // A confirmation is a consequential creator edit, so the revision moved.
    expect(view.revision).toBe(2);
    // And it approved nothing.
    expect(view.approved_slots).toEqual([]);
    expect(view.approvals).toEqual([]);
  });

  it("copies every anchor field from the capture, never from the request body", async () => {
    const h = harness();
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
    const searched = await body<SearchResponse>(search);

    // A body that tries to install a different name and description alongside
    // a real entity id is rejected outright by the strict contract.
    const forged = await handleConfirmAnchor(
      mutation(`/api/projects/${projectId}/anchor`, {
        method: "PUT",
        cookie,
        body: JSON.stringify({
          expected_revision: searched.project.revision,
          search_capture_id: searched.search.capture_id,
          entity_id: RADIOHEAD_ENTITY_ID,
          name: "Totally Different Band",
          short_description: "Something Qloo never said.",
        }),
      }),
      h.deps,
      projectId,
    );
    expect(forged.status).toBe(422);

    const confirmed = await handleConfirmAnchor(
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
    const result = await body<AnchorResponse>(confirmed);
    expect(result.project.anchor?.name).toBe("Radiohead");
    expect(result.project.anchor?.short_description).toContain("English rock band");
  });

  it("refuses an entity id that is not in the named snapshot", async () => {
    const h = harness();
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
    const searched = await body<SearchResponse>(search);

    // A real-looking UUID that this application never retrieved.
    const response = await handleConfirmAnchor(
      mutation(`/api/projects/${projectId}/anchor`, {
        method: "PUT",
        cookie,
        body: JSON.stringify({
          expected_revision: searched.project.revision,
          search_capture_id: searched.search.capture_id,
          entity_id: "11111111-2222-4333-8444-555555555555",
        }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(422);
    expect((await envelope(response)).code).toBe("VALIDATION_FAILED");
  });

  it("refuses a snapshot id that does not exist", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    const response = await handleConfirmAnchor(
      mutation(`/api/projects/${projectId}/anchor`, {
        method: "PUT",
        cookie,
        body: JSON.stringify({
          expected_revision: 1,
          search_capture_id: "00000000-0000-4000-8000-000000000000",
          entity_id: RADIOHEAD_ENTITY_ID,
        }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(422);
  });

  it("rejects a confirmation taken against a stale revision", async () => {
    const h = harness();
    const { projectId, cookie } = await confirmedProject(h);
    const search = await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, {
        cookie,
        body: JSON.stringify({ query: "Radiohead" }),
      }),
      h.deps,
      projectId,
    );
    const searched = await body<SearchResponse>(search);

    const response = await handleConfirmAnchor(
      mutation(`/api/projects/${projectId}/anchor`, {
        method: "PUT",
        cookie,
        body: JSON.stringify({
          expected_revision: 1, // the project is at 2
          search_capture_id: searched.search.capture_id,
          entity_id: RADIOHEAD_ENTITY_ID,
        }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(429);
    expect((await envelope(response)).message).toContain("revision 2");
  });

  it("lets a creator re-confirm the same artist without a rebranch", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);
    const search = await handleArtistSearch(
      mutation(`/api/projects/${projectId}/artist-search`, {
        cookie,
        body: JSON.stringify({ query: "Radiohead" }),
      }),
      h.deps,
      projectId,
    );
    const searched = await body<SearchResponse>(search);

    const again = await handleConfirmAnchor(
      mutation(`/api/projects/${projectId}/anchor`, {
        method: "PUT",
        cookie,
        body: JSON.stringify({
          expected_revision: revision,
          search_capture_id: searched.search.capture_id,
          entity_id: RADIOHEAD_ENTITY_ID,
        }),
      }),
      h.deps,
      projectId,
    );
    expect(again.status).toBe(200);
    const result = await body<AnchorResponse>(again);
    expect(result.invalidated).toBe(false);
  });
});

describe("POST /api/projects/:id/references", () => {
  it("retrieves both first hops in one request, costing two upstream calls", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);

    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(200);
    const result = await body<ReferencesResponse>(response);

    expect(result.upstream_calls).toBe(2);
    // One search plus two first hops: the three calls of a normal creation.
    expect(h.transport.calls).toHaveLength(3);
    expect(result.references.any_usable).toBe(true);
    expect(result.references.movie.status).toBe("ready");
    expect(result.references.videogame.status).toBe("ready");
    expect(result.project.workflow_state).toBe("REFERENCES_READY");
    expect(result.project.reference_capture_ids).toHaveLength(2);
  });

  it("shows three usable cards per domain and keeps the rest as ranked skips", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    const { references } = await body<ReferencesResponse>(response);

    expect(references.movie.displayed.map((candidate) => candidate.name)).toEqual([
      "Children of Men",
      "Being John Malkovich",
      "Moon",
    ]);
    expect(references.videogame.displayed.map((candidate) => candidate.name)).toEqual([
      "Mass Effect 2",
      "Dragon Age: Origins",
      "Mass Effect",
    ]);
    expect(references.movie.returned_count).toBe(10);
    expect(references.movie.skipped.map((skip) => skip.original_rank)).toEqual([
      4, 5, 6, 7, 8, 9, 10,
    ]);
    for (const skip of references.movie.skipped) {
      expect(skip.reason).toBe("beyond_display_limit");
    }
    const moon = references.movie.displayed.find((candidate) => candidate.name === "Moon");
    expect(moon?.entity_id).toBe(MOON_ENTITY_ID);
    expect(moon?.original_rank).toBe(3);
  });

  it("never sends an affinity score to the browser", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    const text = await response.text();
    expect(text).not.toContain("affinity");
    expect(text).not.toContain("popularity");
    expect(text).not.toContain("request_fingerprint");
    expect(text).not.toContain("x-api-key");
  });

  it("spaces the two hops by the global launch gap", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);
    await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    expect(h.launches).toEqual(["artist_search", "references_movie", "references_videogame"]);
    const times = h.gateway.qlooLaunches.map((launch) => Date.parse(launch.at));
    expect(times).toHaveLength(3);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(250);
    }
  });

  it("answers a repeat retrieval from the captures, with zero upstream calls", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);
    const request = () =>
      handleReferences(
        mutation(`/api/projects/${projectId}/references`, {
          cookie,
          body: JSON.stringify({ expected_revision: revision }),
        }),
        h.deps,
        projectId,
      );

    await request();
    expect(h.transport.calls).toHaveLength(3);

    h.advance(60_000);
    const second = await request();
    const result = await body<ReferencesResponse>(second);
    expect(result.upstream_calls).toBe(0);
    expect(h.transport.calls).toHaveLength(3);
    expect(result.references.movie.cache).toBe("cached");
    expect(result.references.videogame.cache).toBe("cached");
    // No new lease was taken either, because nothing was launched.
    expect(h.launches).toEqual(["artist_search", "references_movie", "references_videogame"]);
  });

  it("keeps one domain usable when the other fails", async () => {
    const h = harness({
      transport: routedTransport({
        search: () => jsonResponse(QLOO_FIXTURES.searchRadiohead),
        movie: () => new Response("", { status: 503 }),
        videogame: () => jsonResponse(QLOO_FIXTURES.videogamesRadiohead),
      }),
    });
    const { projectId, cookie, revision } = await confirmedProject(h);

    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(200);
    const { references, project: view } = await body<ReferencesResponse>(response);

    expect(references.movie.status).toBe("unavailable");
    expect(references.movie.failure_code).toBe("QLOO_UPSTREAM");
    expect(references.movie.displayed).toEqual([]);
    expect(references.videogame.status).toBe("ready");
    expect(references.any_usable).toBe(true);
    // Only the successful domain's capture is attached.
    expect(view.reference_capture_ids).toHaveLength(1);
  });

  it("keeps the other domain usable when one comes back with no usable context", async () => {
    const h = harness({
      transport: routedTransport({
        search: () => jsonResponse(QLOO_FIXTURES.searchRadiohead),
        movie: () => jsonResponse({ success: true, results: { entities: [] } }),
        videogame: () => jsonResponse(QLOO_FIXTURES.videogamesRadiohead),
      }),
    });
    const { projectId, cookie, revision } = await confirmedProject(h);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    const { references } = await body<ReferencesResponse>(response);
    expect(references.movie.status).toBe("ready");
    expect(references.movie.returned_count).toBe(0);
    expect(references.movie.usable_count).toBe(0);
    expect(references.videogame.usable_count).toBeGreaterThan(0);
    expect(references.any_usable).toBe(true);
  });

  it("says so honestly when neither domain is usable, and invents nothing", async () => {
    const identityOnly = {
      success: true,
      results: {
        entities: [
          {
            name: "Identity Only",
            entity_id: "11111111-2222-4333-8444-555555555555",
            subtype: "urn:entity:movie",
            properties: {},
          },
        ],
      },
    };
    const h = harness({
      transport: routedTransport({
        search: () => jsonResponse(QLOO_FIXTURES.searchRadiohead),
        movie: () => jsonResponse(identityOnly),
        videogame: () =>
          jsonResponse({
            success: true,
            results: {
              entities: [
                {
                  name: "Identity Only Game",
                  entity_id: "22222222-3333-4444-8555-666666666666",
                  subtype: "urn:entity:videogame",
                  properties: {},
                },
              ],
            },
          }),
      }),
    });
    const { projectId, cookie, revision } = await confirmedProject(h);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    const { references } = await body<ReferencesResponse>(response);

    expect(references.any_usable).toBe(false);
    expect(references.movie.displayed).toEqual([]);
    expect(references.movie.skipped[0]?.reason).toBe("no_usable_context");
    expect(references.videogame.displayed).toEqual([]);
    const text = JSON.stringify(references);
    expect(text).not.toContain("Children of Men");
  });

  it("fails the domain when the returned subtype contradicts the request", async () => {
    const h = harness({
      transport: routedTransport({
        search: () => jsonResponse(QLOO_FIXTURES.searchRadiohead),
        // The silently-ignored-parameter case: a movie filter answered with games.
        movie: () => jsonResponse(QLOO_FIXTURES.videogamesRadiohead),
        videogame: () => jsonResponse(QLOO_FIXTURES.videogamesRadiohead),
      }),
    });
    const { projectId, cookie, revision } = await confirmedProject(h);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    const { references } = await body<ReferencesResponse>(response);
    expect(references.movie.status).toBe("unavailable");
    expect(references.movie.failure_code).toBe("QLOO_CONTRACT");
  });

  it("refuses to retrieve before an artist is confirmed", async () => {
    const h = harness();
    const cookie = await owner(h);
    const projectId = await project(h, cookie);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: 1 }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(422);
    expect(h.transport.calls).toHaveLength(0);
  });

  it("rejects a retrieval taken against a stale revision", async () => {
    const h = harness();
    const { projectId, cookie } = await confirmedProject(h);
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: 1 }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(429);
    expect(h.transport.calls).toHaveLength(1);
  });

  it("rebuilds the domain rows on a plain reload, with zero upstream calls", async () => {
    const h = harness();
    const { projectId, cookie, revision } = await confirmedProject(h);
    await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    const callsAfterRetrieval = h.transport.calls.length;

    const reload = await handleReadProject(
      readRequest(`/api/projects/${projectId}`, cookie),
      h.deps,
      projectId,
    );
    const reloaded = await body<{ project: ProjectView; references: ReferencesResponse["references"] | null }>(
      reload,
    );
    expect(reloaded.references?.movie.displayed).toHaveLength(3);
    expect(reloaded.references?.videogame.displayed).toHaveLength(3);
    expect(reloaded.project.approvals).toEqual([]);
    expect(h.transport.calls).toHaveLength(callsAfterRetrieval);
  });

  it("holds the whole retrieval back once the local reserve is spent", async () => {
    const h = harness({ qloo: { monthlyCallAllowance: 2, judgingReserveCalls: 0 } });
    const { projectId, cookie, revision } = await confirmedProject(h);
    // The search already spent two of the two reservable calls.
    const response = await handleReferences(
      mutation(`/api/projects/${projectId}/references`, {
        cookie,
        body: JSON.stringify({ expected_revision: revision }),
      }),
      h.deps,
      projectId,
    );
    expect(response.status).toBe(429);
    expect((await envelope(response)).code).toBe("BUDGET_EXHAUSTED");
    // One search happened; neither first hop did.
    expect(h.transport.calls).toHaveLength(1);
  });
});
