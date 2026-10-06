/**
 * Share copy: versions and links in the creator's words.
 *
 * A version is still addressed by its id everywhere it matters (the select's
 * value, the publish request, the export link). What the creator reads is
 * what the version is: current or earlier, which influences it carries, when
 * it was built, and a short id to tell two apart.
 */

import type { SceneVersionSummary } from "../domain/compile";

const SLOT_NAME: Readonly<Record<string, string>> = {
  discovery: "Discovery",
  commitment: "Commitment",
};

/** The first eight characters: enough to tell versions apart on screen. */
export function shortVersion(id: string): string {
  return id.slice(0, 8);
}

export function slotsLabel(slots: readonly string[]): string {
  return slots.length === 0
    ? "foundation only, no influence"
    : `with ${slots.map((slot) => SLOT_NAME[slot] ?? slot).join(" + ")}`;
}

/** A stored timestamp as a date a person reads; the stored text if unreadable. */
export function whenLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function versionOptionLabel(version: SceneVersionSummary): string {
  const state =
    version.state === "active"
      ? "Current version"
      : version.state === "pending"
        ? "Awaiting review"
        : "Earlier version";
  return `${state} · ${slotsLabel(version.active_slots)} · built ${whenLabel(version.created_at)} · ${shortVersion(version.id)}`;
}
