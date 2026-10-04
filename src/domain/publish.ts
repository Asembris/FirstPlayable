/**
 * Publication, the public read-only snapshot, and the offline export
 * (specification sections 1, 11, 12, and 13).
 *
 * One shape does the work of three surfaces, deliberately: the publish
 * preview, the public read, and the bytes embedded in the exported HTML are all
 * the same {@link PublicSnapshot}. That is what makes "the publish action
 * previews exactly what will be public" checkable rather than a claim — the
 * preview and the published document are computed by one function from one
 * contract, and the creator confirms the hash of the value they saw.
 *
 * What a snapshot carries: the public title, the whole validated scene, the
 * immutable version's own identity and the identifiers of what produced it,
 * and — only when the creator explicitly included it — the approved provenance
 * chain with the engine's own "Scene changed" sentence.
 *
 * What it has no field for, and therefore cannot leak: the project id, the
 * owner session, the brief, the premise, the artist query, the confirmed
 * anchor, any rejected or unselected proposal, any proposal draft, any capture
 * id or request fingerprint, any quota diagnostic, any operation id, any
 * prompt, any hash of an owner secret, and any read token. A route cannot
 * forget to strip one of those, because there is nowhere to put it.
 */

import { z } from "zod";
import { SlotSchema } from "./influence";
import { QlooDomainSchema } from "./qloo";
import { SceneSchema } from "./scene";
import { TEXT } from "./limits";

/** The snapshot contract's own version, so a stale published document is refused. */
export const PUBLIC_SNAPSHOT_SCHEMA = "fp-public-1.0";

/** The read token's entropy. 32 bytes is 256 bits, well above the required 128. */
export const READ_TOKEN_BYTES = 32;

/**
 * One line of the approved provenance chain, as a public viewer sees it.
 *
 * Three of the four layers of section 13, plus the engine's own observation.
 * The retrieved layer carries the reference's name and domain and nothing else
 * from the capture: no entity UUID, no original rank, no affinity, no capture
 * id, and no request diagnostic.
 */
export const PublicProvenanceLineSchema = z.strictObject({
  slot: SlotSchema,
  /** The scene-level approval id, the same one the scene's own influence uses. */
  approval_id: z.string().min(1).max(64),
  retrieved: z
    .strictObject({
      reference_name: z.string().min(1).max(300),
      domain: QlooDomainSchema,
      source_kind: z.enum(["qloo", "model_selected", "design_fixture"]),
    })
    .nullable(),
  /** Explicitly a FirstPlayable interpretation, never a Qloo assertion. */
  proposed: z.string().min(1).max(500).nullable(),
  approved: z.strictObject({
    text: z.string().min(1).max(TEXT.approved_interpretation),
    intended_effect: z.string().min(1).max(300),
    edited_by_creator: z.boolean(),
  }),
  /** The deterministic engine sentence, or null when no witness was stored. */
  scene_changed: z.string().min(1).max(300).nullable(),
});

export type PublicProvenanceLine = z.infer<typeof PublicProvenanceLineSchema>;

export const PublicSnapshotSchema = z.strictObject({
  schema: z.literal(PUBLIC_SNAPSHOT_SCHEMA),
  title: z.string().min(1).max(TEXT.scene_title),
  /** The immutable version this link names. One link is one version, forever. */
  version_id: z.uuid(),
  created_at: z.string(),
  scene: SceneSchema,
  active_slots: z.array(SlotSchema).max(2),
  identifiers: z.strictObject({
    model: z.string().max(80).nullable(),
    compiler: z.string().max(80).nullable(),
    validator: z.string().max(80).nullable(),
  }),
  /** False when the creator published the scene without its source disclosure. */
  provenance_included: z.boolean(),
  provenance: z.array(PublicProvenanceLineSchema).max(2),
});

export type PublicSnapshot = z.infer<typeof PublicSnapshotSchema>;

/* ------------------------------------------------------------- publishing */

/**
 * `POST /api/projects/:id/publish`.
 *
 * `preview: true` computes and returns the snapshot and publishes nothing.
 * Publishing requires `snapshot_hash`, which must equal the hash of the
 * snapshot the server computes now; that is the mechanism behind "publish what
 * you previewed". A creator who changes `include_provenance` between the
 * preview and the publish gets a refusal, not a silently different document.
 */
export const PublishRequestSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  version_id: z.uuid(),
  include_provenance: z.boolean(),
  preview: z.boolean(),
  snapshot_hash: z.string().min(16).max(64).optional(),
});

export type PublishRequest = z.infer<typeof PublishRequestSchema>;

/** One publication, as its owner sees it. The token is never stored or re-read. */
export const PublicationSummarySchema = z.strictObject({
  id: z.uuid(),
  scene_version_id: z.uuid(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  provenance_included: z.boolean(),
});

export type PublicationSummary = z.infer<typeof PublicationSummarySchema>;

export const PublishResponseSchema = z.strictObject({
  outcome: z.enum(["previewed", "published"]),
  snapshot: PublicSnapshotSchema,
  snapshot_hash: z.string().min(16).max(64),
  publication: PublicationSummarySchema.nullable(),
  /**
   * The read path, including the token, returned **once** and never again:
   * only the token's SHA-256 hash is stored.
   */
  play_path: z.string().max(200).nullable(),
  /** The sentence the creator must see before publishing or exporting. */
  warning: z.string().min(1).max(300),
});

export type PublishResponse = z.infer<typeof PublishResponseSchema>;

/**
 * The exact sentence shown beside publish and export.
 *
 * It is here, in the contract, so neither surface can soften it: a copy that is
 * already downloaded or already read cannot be recalled by revoking the link.
 */
export const SHARE_WARNING =
  "Anyone with this link can play this version. Revoking stops new reads within five minutes; it cannot recall a copy somebody already downloaded.";

export const RevokeResponseSchema = z.strictObject({
  outcome: z.enum(["revoked", "already_revoked"]),
  publication: PublicationSummarySchema,
});

export type RevokeResponse = z.infer<typeof RevokeResponseSchema>;

/** `GET /api/public/:token`. No project, no history, no owner anything. */
export const PublicReadResponseSchema = z.strictObject({
  snapshot: PublicSnapshotSchema,
  /** When the link was created. Not who made it and not from what. */
  published_at: z.string(),
});

export type PublicReadResponse = z.infer<typeof PublicReadResponseSchema>;

/** What a public viewer sees when a token is unknown, revoked, or malformed. */
export const PUBLIC_UNAVAILABLE_MESSAGE = "This playable could not be loaded.";

/* ---------------------------------------------------------------- export */

/** The export's own data-block contract version. */
export const OFFLINE_EXPORT_SCHEMA = "fp-offline-1.0";

/**
 * The inert data block embedded in an exported HTML file.
 *
 * It is the public snapshot and nothing more, which is the honest statement of
 * what an export contains: exactly what a published link would have shown.
 */
export const OfflineExportSchema = z.strictObject({
  schema: z.literal(OFFLINE_EXPORT_SCHEMA),
  exported_at: z.string(),
  snapshot: PublicSnapshotSchema,
});

export type OfflineExport = z.infer<typeof OfflineExportSchema>;

/** A stable, owner-neutral download name. It names the version, not the project. */
export function exportFileName(versionId: string): string {
  return `firstplayable-${versionId.slice(0, 8)}.html`;
}
