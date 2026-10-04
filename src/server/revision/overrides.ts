/**
 * Reading and writing the creator's ending-wording overrides.
 *
 * An override is three fields — which declared ending, the exact wording, and
 * the id of the creator edit that produced it — and the authoritative contract
 * for all three is `EndingCopyOverrideSchema` in `src/domain/scene.ts`. A
 * stored value that no longer satisfies it is dropped rather than half-trusted,
 * so a corrupt row reads as "this ending has no override" and the scene falls
 * back to its own base wording.
 *
 * What an override structurally cannot be: a condition, an effect, a gate, a
 * variable, an action, a reachability change, or a second ending's text. The
 * composer applies it by replacing one ending's `text` and nothing else
 * (`composeScene` in `src/engine/compose.ts`), which is why section 9 can call
 * this a wording change rather than trusting a label.
 */

import { BUDGET } from "@/domain/limits";
import type { EndingCopyOverride } from "@/domain/scene";
import { EndingCopyOverrideSchema } from "@/domain/scene";
import { sha256Hex } from "@/engine/hash";

/** Reads the stored list, dropping every entry that fails its own contract. */
export function readEndingCopyOverrides(value: unknown): EndingCopyOverride[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const overrides: EndingCopyOverride[] = [];
  for (const entry of value) {
    const parsed = EndingCopyOverrideSchema.safeParse(entry);
    if (!parsed.success) continue;
    // One override per ending. A duplicate would make the composed wording
    // depend on array order, which is not a thing a creator chose.
    if (seen.has(parsed.data.ending_id)) continue;
    seen.add(parsed.data.ending_id);
    overrides.push(parsed.data);
    if (overrides.length >= BUDGET.ending_copy_overrides) break;
  }
  return overrides;
}

/**
 * The id one creator edit owns.
 *
 * Derived from the ending and the wording, so applying the same wording twice
 * is the same edit and a stored list cannot grow by re-applying it. It is a
 * scene identifier, so it uses the identifier alphabet.
 */
export function creatorEditId(endingId: string, text: string): string {
  return `edit.${sha256Hex(`${endingId}|${text}`).slice(0, 24)}`;
}

/** The hash a preview returns and an apply must present, so apply shows what was previewed. */
export function previewHash(endingId: string, text: string): string {
  return sha256Hex(`ending_copy|${endingId}|${text}`).slice(0, 48);
}

/**
 * Replaces one ending's override in a list, or removes it when the wording
 * matches the ending's own base text.
 *
 * Removing in that case keeps "no override" and "an override that happens to
 * equal the original" from being two states that look identical on screen.
 */
export function withOverride(
  current: readonly EndingCopyOverride[],
  override: EndingCopyOverride | { ending_id: string; remove: true },
): EndingCopyOverride[] {
  const without = current.filter((entry) => entry.ending_id !== override.ending_id);
  if ("remove" in override) return without;
  return [...without, override].slice(0, BUDGET.ending_copy_overrides);
}
