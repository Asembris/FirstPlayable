/**
 * Project contracts shared by the browser and the server (specification
 * section 11).
 *
 * These live in `src/domain/` beside the scene and brief contracts because
 * both sides need them and neither side may hold a second, handwritten copy.
 * Nothing here reads configuration or touches a service.
 *
 * `ProjectView` is the *whole* public shape of a project. Provider
 * diagnostics, request fingerprints, quota counters, the owner session id, and
 * the clean base scene are all absent by construction, so a route cannot leak
 * one by forgetting to strip it.
 */

import { z } from "zod";
import { BriefSchema, workingTitle, type Brief } from "./brief";
import { SLOTS } from "./limits";

/** The model-and-orchestration state machine of specification section 8. */
export const WORKFLOW_STATES = [
  "DRAFT",
  "ANCHOR_CONFIRMED",
  "REFERENCES_READY",
  "PROPOSALS_READY",
  "AWAITING_APPROVAL",
  "BASE_READY",
  "MODULES_READY",
  "VALIDATING",
  "REVIEW_PLAYABLE",
  "READY",
  "REVISION_PENDING",
  "FAILED",
] as const;

export const WorkflowStateSchema = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/**
 * The phase 2 project-creation payload: one frozen brief, nothing else.
 *
 * A creator cannot supply a revision counter, a workflow state, an approval
 * id, a base scene, or an owner session id. The server assigns every one of
 * those, which is why no scene can self-authorise an approval.
 */
export const CreateProjectRequestSchema = z.strictObject({
  brief: BriefSchema,
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectViewSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  brief: BriefSchema,
  revision: z.number().int().positive(),
  workflow_state: WorkflowStateSchema,
  /** Phase 3 confirms a cultural anchor. Phase 2 always reports false. */
  anchor_confirmed: z.boolean(),
  /** Phase 4 produces the first validated version. Phase 2 always reports null. */
  active_version_id: z.uuid().nullable(),
  /** Which influence slots currently hold an approval. Empty throughout phase 2. */
  approved_slots: z.array(z.enum(SLOTS)),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const CreateProjectResponseSchema = z.strictObject({ project: ProjectViewSchema });
export const ReadProjectResponseSchema = z.strictObject({ project: ProjectViewSchema });

export const SessionResponseSchema = z.strictObject({
  established: z.boolean(),
  expires_at: z.string(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** The title the server assigns when the creator left it empty. */
export function projectTitleFor(brief: Brief): string {
  const derived = workingTitle(brief).trim();
  return derived.length === 0 ? "Untitled encounter" : derived;
}
