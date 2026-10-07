import { describe, expect, it } from "vitest";

import {
  PUBLIC_UNAVAILABLE_MESSAGE,
  type PublicReadResponse,
  type PublishResponse,
  type RevokeResponse,
  SHARE_WARNING,
} from "../../src/domain/publish";
import type { RevisionResponse } from "../../src/domain/revision";
import { handleExport } from "../../src/server/api/export";
import {
  handlePublicRead,
  handlePublish,
  handleRevoke,
} from "../../src/server/api/publish";
import { handleRevision } from "../../src/server/api/revisions";
import { ERROR_CODES } from "../../src/server/security/errors";
import { loadOfflinePlayable } from "../../src/export/guard";
import { availableActions, initialState, step } from "../../src/engine/interpreter";
import { body, envelope, mutation, owner, readRequest, ORIGIN } from "./support/phase3-harness";
import { activeProject, type ActiveProject, readState } from "./support/phase5-harness";

/**
 * Publication, revocation, the public read, and the offline export, driven end
 * to end offline over the real handlers and the in-memory gateway that
 * re-implements the committed SQL.
 */

async function publish(
  state: ActiveProject,
  options: {
    versionId?: string;
    includeProvenance?: boolean;
    preview?: boolean;
    snapshotHash?: string;
    revision?: number;
    cookie?: string;
  } = {},
): Promise<Response> {
  return handlePublish(
    mutation(`/api/projects/${state.projectId}/publish`, {
      cookie: options.cookie ?? state.cookie,
      body: JSON.stringify({
        expected_revision: options.revision ?? state.activeRevision,
        version_id: options.versionId ?? state.versionId,
        include_provenance: options.includeProvenance ?? true,
        preview: options.preview ?? false,
        ...(options.snapshotHash === undefined ? {} : { snapshot_hash: options.snapshotHash }),
      }),
    }),
    state.deps,
    state.projectId,
  );
}

/** Previews, then publishes exactly what the preview returned. */
async function previewAndPublish(
  state: ActiveProject,
  includeProvenance = true,
): Promise<PublishResponse> {
  const previewed = await body<PublishResponse>(
    await publish(state, { preview: true, includeProvenance }),
  );
  expect(previewed.outcome).toBe("previewed");
  const response = await publish(state, {
    includeProvenance,
    snapshotHash: previewed.snapshot_hash,
  });
  expect(response.status).toBe(201);
  return body<PublishResponse>(response);
}

function tokenOf(published: PublishResponse): string {
  const path = published.play_path;
  expect(path).not.toBeNull();
  return (path as string).replace("/play/", "");
}

describe("POST /api/projects/:id/publish", () => {
  it("previews the exact document that publishing will store, and writes nothing", async () => {
    const state = await activeProject(["discovery"]);
    const response = await publish(state, { preview: true });
    expect(response.status).toBe(200);
    const previewed = await body<PublishResponse>(response);

    expect(previewed.outcome).toBe("previewed");
    expect(previewed.publication).toBeNull();
    expect(previewed.play_path).toBeNull();
    expect(previewed.warning).toBe(SHARE_WARNING);
    expect(previewed.snapshot.version_id).toBe(state.versionId);
    expect(previewed.snapshot_hash).toHaveLength(48);
    // Nothing was published.
    expect(state.h.gateway.publications).toHaveLength(0);

    const published = await previewAndPublish(state);
    // Byte-for-byte the document that was previewed.
    expect(published.snapshot_hash).toBe(previewed.snapshot_hash);
    expect(JSON.stringify(published.snapshot)).toBe(JSON.stringify(previewed.snapshot));
  });

  it("stores only the token's hash and returns the token exactly once", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const token = tokenOf(published);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = state.h.gateway.publications[0]!;
    expect(row.read_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.read_token_hash).not.toBe(token);
    expect(JSON.stringify(row).includes(token)).toBe(false);

    // The owner's own listing never carries it back.
    const read = await readState(state);
    expect(read.publications).toHaveLength(1);
    expect(JSON.stringify(read.publications).includes(token)).toBe(false);
    expect(read.publications[0]?.scene_version_id).toBe(state.versionId);
    expect(read.publications[0]?.provenance_included).toBe(true);
    expect(read.publications[0]?.revoked_at).toBeNull();
  });

  it("refuses a document that is not the one previewed", async () => {
    const state = await activeProject(["discovery"]);
    const previewed = await body<PublishResponse>(
      await publish(state, { preview: true, includeProvenance: true }),
    );
    // The same hash, but a different disclosure choice: a different document.
    const response = await publish(state, {
      includeProvenance: false,
      snapshotHash: previewed.snapshot_hash,
    });
    expect(response.status).toBe(422);
    expect(state.h.gateway.publications).toHaveLength(0);

    // And no hash at all is refused too.
    expect((await publish(state, { includeProvenance: true })).status).toBe(422);
  });

  it("refuses to publish a version still awaiting review", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const revised = await body<RevisionResponse>(
      await handleRevision(
        mutation(`/api/projects/${state.projectId}/revisions`, {
          cookie: state.cookie,
          body: JSON.stringify({
            expected_revision: state.activeRevision,
            kind: "remove",
            slot: "commitment",
          }),
        }),
        state.deps,
        state.projectId,
      ),
    );
    const pending = revised.pending_version_id as string;
    const read = await readState(state);

    const response = await publish(state, {
      versionId: pending,
      revision: read.project.revision,
      preview: true,
    });
    expect(response.status).toBe(422);
    expect((await envelope(response)).message).toContain("awaiting your review");
  });

  it("answers a foreign session and an unknown version identically", async () => {
    const state = await activeProject(["discovery"]);
    const intruder = await owner(state.h);
    expect((await publish(state, { preview: true, cookie: intruder })).status).toBe(404);
    expect(
      (
        await publish(state, {
          preview: true,
          versionId: "99999999-9999-4999-8999-999999999999",
        })
      ).status,
    ).toBe(404);
    expect(state.h.gateway.publications).toHaveLength(0);
  });
});

describe("the public snapshot reveals nothing private", () => {
  it("carries the scene and the approved chain, and no owner or project data", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const serialized = JSON.stringify(published.snapshot);
    const read = await readState(state);

    expect(published.snapshot.provenance).toHaveLength(1);
    expect(published.snapshot.provenance[0]?.approved.text.length).toBeGreaterThan(10);
    expect(published.snapshot.provenance[0]?.scene_changed).not.toBeNull();

    // Nothing that belongs to the owner's side of the boundary.
    for (const forbidden of [
      state.projectId,
      read.project.brief.premise,
      read.project.anchor?.entity_id ?? "lanternfold-entity",
      read.project.anchor?.query ?? "Lanternfold",
      read.project.approvals[0]?.capture_id ?? "capture-id",
      read.project.approvals[0]?.entity_id ?? "entity-id",
    ]) {
      expect(serialized.includes(forbidden), `the snapshot carried ${forbidden}`).toBe(false);
    }
    for (const key of [
      "project_id",
      "owner_session",
      "proposal_draft",
      "request_fingerprint",
      "read_token",
      "input_snapshot",
      "capture_id",
      "cultural_anchor_query",
      "forbidden_wording",
      "premise",
    ]) {
      expect(serialized.includes(key), `the snapshot carried the key ${key}`).toBe(false);
    }
  });

  it("omits the whole chain when the creator publishes without it", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state, false);
    expect(published.snapshot.provenance_included).toBe(false);
    expect(published.snapshot.provenance).toEqual([]);
    // The scene still carries its own approved wording, which is part of it.
    expect(published.snapshot.scene.influences).toHaveLength(1);
  });
});

describe("GET /api/public/:token", () => {
  it("serves one immutable version, read-only, and never from a shared cache", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const token = tokenOf(published);

    const response = await handlePublicRead(
      readRequest(`/api/public/${token}`, null),
      state.deps,
      token,
    );
    expect(response.status).toBe(200);
    // A CDN honours `public, max-age` and would keep serving a revoked link,
    // so nothing may store this response: revocation takes effect on the next read.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");

    const read = await body<PublicReadResponse>(response);
    expect(read.snapshot.version_id).toBe(state.versionId);
    expect(JSON.stringify(read.snapshot)).toBe(JSON.stringify(published.snapshot));

    // It plays through the shared engine with no further request.
    const scene = read.snapshot.scene;
    let bits = initialState(scene);
    const first = availableActions(scene, bits).find((action) => action.enabled);
    const stepped = step(scene, bits, first!.action_id);
    expect(stepped.ok).toBe(true);
    if (stepped.ok) bits = stepped.state;
    expect(bits.bits).not.toBe(0);
  });

  it("needs no session at all, and grants none", async () => {
    const state = await activeProject(["discovery"]);
    const token = tokenOf(await previewAndPublish(state));
    const response = await handlePublicRead(
      readRequest(`/api/public/${token}`, null),
      state.deps,
      token,
    );
    expect(response.status).toBe(200);
    // No cookie is set by reading a share.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps a published link pinned to its version when the project moves on", async () => {
    const state = await activeProject(["discovery", "commitment"]);
    const token = tokenOf(await previewAndPublish(state));

    await handleRevision(
      mutation(`/api/projects/${state.projectId}/revisions`, {
        cookie: state.cookie,
        body: JSON.stringify({
          expected_revision: state.activeRevision,
          kind: "remove",
          slot: "commitment",
        }),
      }),
      state.deps,
      state.projectId,
    );

    const response = await handlePublicRead(
      readRequest(`/api/public/${token}`, null),
      state.deps,
      token,
    );
    const read = await body<PublicReadResponse>(response);
    expect(read.snapshot.version_id).toBe(state.versionId);
    // Still two modules: the link names a version, never "whatever is latest".
    expect(read.snapshot.scene.modules).toHaveLength(2);
  });

  it("answers an unknown, malformed and revoked token identically", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const token = tokenOf(published);

    const unknown = await handlePublicRead(
      readRequest("/api/public/x", null),
      state.deps,
      "A".repeat(43),
    );
    const malformed = await handlePublicRead(
      readRequest("/api/public/x", null),
      state.deps,
      "not-a-token",
    );

    const revoked = await handleRevoke(
      mutation(`/api/publications/${published.publication!.id}`, {
        method: "DELETE",
        cookie: state.cookie,
      }),
      state.deps,
      published.publication!.id,
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await handlePublicRead(
      readRequest(`/api/public/${token}`, null),
      state.deps,
      token,
    );

    for (const response of [unknown, malformed, afterRevoke]) {
      expect(response.status).toBe(404);
      const failure = await envelope(response);
      expect(failure.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(failure.message).toBe(PUBLIC_UNAVAILABLE_MESSAGE);
    }
  });

  it("says nothing at all when persistence is unavailable", async () => {
    const state = await activeProject(["discovery"]);
    const token = tokenOf(await previewAndPublish(state));
    state.h.gateway.failAll();
    const response = await handlePublicRead(
      readRequest(`/api/public/${token}`, null),
      state.deps,
      token,
    );
    expect(response.status).toBe(404);
    expect((await envelope(response)).message).toBe(PUBLIC_UNAVAILABLE_MESSAGE);
  });
});

describe("DELETE /api/publications/:id", () => {
  it("revokes without deleting the version or the snapshot", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const publicationId = published.publication!.id;

    const response = await handleRevoke(
      mutation(`/api/publications/${publicationId}`, {
        method: "DELETE",
        cookie: state.cookie,
      }),
      state.deps,
      publicationId,
    );
    expect(response.status).toBe(200);
    const revoked = await body<RevokeResponse>(response);
    expect(revoked.outcome).toBe("revoked");
    expect(revoked.publication.revoked_at).not.toBeNull();

    // The row, the snapshot, and the private source version all survive.
    expect(state.h.gateway.publications).toHaveLength(1);
    expect(state.h.gateway.publications[0]?.public_snapshot).not.toBeNull();
    expect(state.h.gateway.versions.some((row) => row.id === state.versionId)).toBe(true);
    const read = await readState(state);
    expect(read.playable?.version_id).toBe(state.versionId);

    // Revoking twice is idempotent.
    const again = await handleRevoke(
      mutation(`/api/publications/${publicationId}`, {
        method: "DELETE",
        cookie: state.cookie,
      }),
      state.deps,
      publicationId,
    );
    expect((await body<RevokeResponse>(again)).outcome).toBe("already_revoked");
  });

  it("refuses a foreign session and a cross-site request", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const publicationId = published.publication!.id;
    const intruder = await owner(state.h);

    const foreign = await handleRevoke(
      mutation(`/api/publications/${publicationId}`, {
        method: "DELETE",
        cookie: intruder,
      }),
      state.deps,
      publicationId,
    );
    expect(foreign.status).toBe(404);

    const crossSite = await handleRevoke(
      mutation(`/api/publications/${publicationId}`, {
        method: "DELETE",
        cookie: state.cookie,
        origin: "https://attacker.example",
      }),
      state.deps,
      publicationId,
    );
    expect(crossSite.status).toBe(403);

    // Still live after both refusals.
    expect(state.h.gateway.publications[0]?.revoked_at).toBeNull();
  });
});

describe("GET /api/projects/:id/export", () => {
  it("returns one self-contained file that plays with no service at all", async () => {
    const state = await activeProject(["discovery"]);
    const response = await handleExport(
      readRequest(
        `${ORIGIN}/api/projects/${state.projectId}/export?version=${state.versionId}`,
        state.cookie,
      ),
      state.deps,
      state.projectId,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const html = await response.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("default-src &#39;none&#39;");
    // One inline script, one inline style, nothing fetched.
    expect([...html.matchAll(/<script/g)]).toHaveLength(1);
    expect(/src="http|href="http/.test(html)).toBe(false);

    // The embedded data decodes and passes the file's own load check.
    const block = /<div id="fp-data" hidden>([^<]*)<\/div>/.exec(html);
    const decoded = JSON.parse(Buffer.from(block![1]!, "base64").toString("utf8")) as unknown;
    const loaded = loadOfflinePlayable(decoded);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.playable.versionId).toBe(state.versionId);

    // And it is the same engine: a real step runs over the loaded scene.
    const scene = loaded.playable.scene;
    const first = availableActions(scene, initialState(scene)).find((a) => a.enabled);
    expect(step(scene, initialState(scene), first!.action_id).ok).toBe(true);
  });

  it("exports exactly what a share would have shown", async () => {
    const state = await activeProject(["discovery"]);
    const published = await previewAndPublish(state);
    const response = await handleExport(
      readRequest(
        `${ORIGIN}/api/projects/${state.projectId}/export?version=${state.versionId}`,
        state.cookie,
      ),
      state.deps,
      state.projectId,
    );
    const html = await response.text();
    const block = /<div id="fp-data" hidden>([^<]*)<\/div>/.exec(html);
    const decoded = JSON.parse(Buffer.from(block![1]!, "base64").toString("utf8")) as {
      snapshot: unknown;
    };
    expect(JSON.stringify(decoded.snapshot)).toBe(JSON.stringify(published.snapshot));
  });

  it("carries no credential, no private draft, and no owner cookie", async () => {
    const state = await activeProject(["discovery"]);
    const read = await readState(state);
    const response = await handleExport(
      readRequest(`${ORIGIN}/api/projects/${state.projectId}/export`, state.cookie),
      state.deps,
      state.projectId,
    );
    const html = await response.text();

    for (const forbidden of [
      state.projectId,
      state.cookie.replace("fp_owner=", ""),
      read.project.brief.premise,
      "fp_owner",
      "sb_secret_",
      "sb_publishable_",
      "api.openai.com",
      "supabase.co",
      "qloo.com",
      "read_token",
      "proposal_draft",
    ]) {
      expect(html.includes(forbidden), `the export carried ${forbidden}`).toBe(false);
    }
  });

  it("drops the source chain when the creator asks it to", async () => {
    const state = await activeProject(["discovery"]);
    const response = await handleExport(
      readRequest(
        `${ORIGIN}/api/projects/${state.projectId}/export?provenance=0`,
        state.cookie,
      ),
      state.deps,
      state.projectId,
    );
    const html = await response.text();
    const block = /<div id="fp-data" hidden>([^<]*)<\/div>/.exec(html);
    const decoded = JSON.parse(Buffer.from(block![1]!, "base64").toString("utf8")) as {
      snapshot: { provenance_included: boolean; provenance: unknown[] };
    };
    expect(decoded.snapshot.provenance_included).toBe(false);
    expect(decoded.snapshot.provenance).toEqual([]);
  });

  it("answers a foreign session and an unknown version with NOT_FOUND", async () => {
    const state = await activeProject(["discovery"]);
    const intruder = await owner(state.h);
    expect(
      (
        await handleExport(
          readRequest(`${ORIGIN}/api/projects/${state.projectId}/export`, intruder),
          state.deps,
          state.projectId,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleExport(
          readRequest(
            `${ORIGIN}/api/projects/${state.projectId}/export?version=not-a-uuid`,
            state.cookie,
          ),
          state.deps,
          state.projectId,
        )
      ).status,
    ).toBe(404);
  });
});
