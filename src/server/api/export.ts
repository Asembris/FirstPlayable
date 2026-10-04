/**
 * `GET /api/projects/:id/export?version=<id>` (specification sections 11 and 12).
 *
 * Owner-only, and a read: it writes nothing, publishes nothing, and creates no
 * link. What it returns is one self-contained HTML file built from the same
 * `PublicSnapshot` a published link would serve — so "an export contains exactly
 * what a share would have shown" is true by construction rather than by review.
 *
 * The file plays from `file://` with the network unplugged, because there is
 * nothing in it to fetch: the Phase 1 engine is bundled at build time, the
 * styles are first-party, the scene is inert base64, and the Content-Security
 * Policy is `default-src 'none'` plus the two hashes of the script and the
 * stylesheet it carries.
 *
 * The creator is told, before they get here, that a downloaded copy cannot be
 * revoked (`SHARE_WARNING`). That sentence is in the contract and in the file.
 */

import { buildOfflineExport } from "@/export/html";
import { refreshOwnerActivity, requireOwnerSession } from "../db/sessions";
import { readVersionRow } from "../db/versions";
import { buildPublicSnapshot } from "../publish/snapshot";
import { appErrors, errorResponse, newRequestId } from "../security/errors";
import { readOwnerSecret } from "../security/session";
import type { RouteDeps } from "./deps";
import { parseProjectId, requireProject } from "./shared";

const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function handleExport(
  request: Request,
  deps: RouteDeps,
  projectId: string,
): Promise<Response> {
  const requestId = newRequestId();
  try {
    const gateway = deps.gateway();
    const now = deps.now?.() ?? new Date();
    const session = await requireOwnerSession(gateway, readOwnerSecret(request), now);
    await refreshOwnerActivity(gateway, session, now);

    const id = parseProjectId(projectId);
    const row = await requireProject(gateway, session, id);

    const url = new URL(request.url);
    const requested = url.searchParams.get("version");
    // Defaults to the active version, which is the one the creator confirmed.
    // A version awaiting review is exportable only if named explicitly, and a
    // project with nothing confirmed has nothing to export.
    const versionId = requested ?? row.active_version_id;
    if (versionId === null) throw appErrors.notFound();
    if (!UUID_SHAPE.test(versionId)) throw appErrors.notFound();

    const version = await readVersionRow(gateway, session, row, versionId);
    if (version === null) throw appErrors.notFound();

    // The creator may export without the source disclosure, exactly as they may
    // publish without it.
    const includeProvenance = url.searchParams.get("provenance") !== "0";
    const built = buildPublicSnapshot(version, { includeProvenance });
    if (!built.ok) {
      throw appErrors.refused(
        "That version could not be read back as an exportable document, so nothing was exported.",
      );
    }

    const file = buildOfflineExport(built.snapshot, now.toISOString());
    return new Response(file.html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
