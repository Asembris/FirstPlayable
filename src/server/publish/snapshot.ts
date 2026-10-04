/**
 * Building the public snapshot (specification sections 12 and 13).
 *
 * This is the whole of what leaves the owner's boundary, and it is built from
 * exactly three inputs: one immutable version row, the creator's explicit
 * disclosure choice, and nothing else. There is no project row in scope, no
 * session, no brief, no anchor, no proposal draft, no capture, and no
 * operation — so the usual leak, "a field that should have been stripped", is
 * not prevented here, it is unreachable.
 *
 * The provenance chain, when the creator includes it, is read off the version's
 * **frozen** approval snapshot rather than today's approvals, which is what
 * makes a published link stable: the document says what was approved when that
 * version was built, and it does not change because the creator has since
 * revised the project. The fourth line is the engine's own witness sentence
 * from the stored validation summary, so nothing in a public document is a
 * model describing its own output.
 *
 * What the chain deliberately omits from the capture: the entity UUID, the
 * original rank, any affinity, the capture id, the request fingerprint, the
 * retrieval diagnostics, and every unselected or rejected proposal.
 */

import { z } from "zod";
import {
  PUBLIC_SNAPSHOT_SCHEMA,
  type PublicProvenanceLine,
  type PublicSnapshot,
  PublicSnapshotSchema,
} from "@/domain/publish";
import { SlotSchema } from "@/domain/influence";
import { QlooDomainSchema } from "@/domain/qloo";
import { safeParseScene } from "@/domain/scene";
import { ValidationSummaryViewSchema } from "@/domain/compile";
import { hashCanonical } from "@/engine/hash";
import type { SceneVersionRow } from "../db/gateway";

/**
 * The frozen approval, as a version row stores it.
 *
 * Deliberately loose about which fields are present: a version committed before
 * `proposed_idea` was recorded still publishes, with that one line absent
 * rather than invented.
 */
const FrozenApprovalSchema = z.object({
  slot: SlotSchema,
  scene_approval_id: z.string().min(1).max(64),
  reference_name: z.string().min(1).max(300),
  domain: QlooDomainSchema,
  source_kind: z.enum(["qloo", "model_selected", "design_fixture"]),
  approved_text: z.string().min(1),
  intended_effect: z.string().min(1),
  proposed_idea: z.string().min(1).optional(),
  edited_by_creator: z.boolean(),
});

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: PublicSnapshot; readonly hash: string }
  | { readonly ok: false };

/**
 * Builds the snapshot for one version, or reports that it is not publishable.
 *
 * A version whose stored scene or validation summary cannot be read back is
 * **not** published with the readable part: the honest outcome is "this version
 * cannot be published", never a partial public document.
 */
export function buildPublicSnapshot(
  row: SceneVersionRow,
  options: { readonly includeProvenance: boolean },
): SnapshotResult {
  const scene = safeParseScene(row.scene);
  if (!scene.ok) return { ok: false };
  const validation = ValidationSummaryViewSchema.safeParse(row.validation_summary);
  if (!validation.success) return { ok: false };

  const approvals = Array.isArray(row.approval_snapshot)
    ? row.approval_snapshot.flatMap((entry) => {
        const parsed = FrozenApprovalSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

  const provenance: PublicProvenanceLine[] = options.includeProvenance
    ? approvals.map((approval) => {
        const witness = validation.data.witnesses.find(
          (candidate) => candidate.slot === approval.slot && candidate.mechanical,
        );
        return {
          slot: approval.slot,
          approval_id: approval.scene_approval_id,
          retrieved: {
            reference_name: approval.reference_name,
            domain: approval.domain,
            source_kind: approval.source_kind,
          },
          proposed: approval.proposed_idea ?? null,
          approved: {
            text: approval.approved_text,
            intended_effect: approval.intended_effect,
            edited_by_creator: approval.edited_by_creator,
          },
          scene_changed: witness?.sentence ?? null,
        };
      })
    : [];

  const candidate = {
    schema: PUBLIC_SNAPSHOT_SCHEMA,
    title: scene.scene.title,
    version_id: row.id,
    created_at: row.created_at,
    scene: scene.scene,
    active_slots: scene.scene.modules.map((module) => module.slot),
    identifiers: {
      model: row.model_identifier,
      compiler: row.compiler_identifier,
      validator: row.validator_identifier,
    },
    provenance_included: options.includeProvenance,
    provenance,
  };

  const parsed = PublicSnapshotSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false };
  return { ok: true, snapshot: parsed.data, hash: snapshotHash(parsed.data) };
}

/**
 * The hash the creator confirms.
 *
 * `POST .../publish` requires it to equal the hash of the snapshot the server
 * computes at publish time, which is the mechanism behind "the publish action
 * previews exactly what will be public": a document that differs from the
 * previewed one in any byte — including the disclosure flag — cannot be
 * published by accident.
 */
export function snapshotHash(snapshot: PublicSnapshot): string {
  return hashCanonical(snapshot).slice(0, 48);
}
