/**
 * The three checks every phase 3 route repeats, in one place so none of them
 * can be forgotten by a new handler.
 *
 * Each one collapses a distinguishable failure into an indistinguishable one:
 *
 *   * a malformed project id answers exactly like a project that is not yours;
 *   * a missing project and a foreign project answer identically;
 *   * a Zod failure logs the field *paths* and never the submitted values.
 */

import type { z } from "zod";
import { readProjectForOwner } from "../db/projects";
import type { DataGateway, ProjectRow, SessionRow } from "../db/gateway";
import { appErrors } from "../security/errors";

const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A project id is an address, never an authorisation. A bad one is `NOT_FOUND`. */
export function parseProjectId(value: string): string {
  if (!UUID_SHAPE.test(value)) throw appErrors.notFound();
  return value;
}

/** The owner-scoped read. `null` becomes the one shared `NOT_FOUND` envelope. */
export async function requireProject(
  gateway: DataGateway,
  session: SessionRow,
  projectId: string,
): Promise<ProjectRow> {
  const row = await readProjectForOwner(gateway, session, projectId);
  if (row === null) throw appErrors.notFound();
  return row;
}

/**
 * Validates a request body against the authoritative contract.
 *
 * Only the failing field paths travel into the diagnostic. The values the
 * creator submitted never do, so a validation log cannot become a transcript
 * of somebody's brief.
 */
export function validateBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw appErrors.validationFailed(
      parsed.error.issues.map((issue) => issue.path.join(".")).join(","),
    );
  }
  return parsed.data as z.output<S>;
}
