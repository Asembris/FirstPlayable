import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Raw fixture JSON, re-read from disk for every mutation, so a test can edit a
 * deep copy without touching the parsed fixtures other tests share.
 */
export function rawFixture(name: string): Record<string, unknown> {
  const path = fileURLToPath(
    new URL(`../../fixtures/${name}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export const rawBase = (): Record<string, unknown> => rawFixture("second_copy.base");
export const rawV1 = (): Record<string, unknown> =>
  rawFixture("second_copy.discovery_v1");
export const rawV2 = (): Record<string, unknown> =>
  rawFixture("second_copy.discovery_v2");

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Mutable = any;

export function findAction(scene: Mutable, id: string): Mutable {
  const found = (scene.core.actions as Mutable[]).find(
    (action) => action.id === id,
  );
  if (found === undefined) throw new Error(`no core action "${id}"`);
  return found;
}

export const whenFlags = (
  atoms: readonly [string, boolean][],
): Mutable => ({
  kind: "any",
  clauses: [atoms.map(([var_id, equals]) => ({ var_id, equals }))],
});
