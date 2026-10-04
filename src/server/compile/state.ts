/**
 * What a compilation stores between advance requests
 * (specification section 8, "Limits and execution lifetime").
 *
 * There are no background jobs here. A stage that commits writes its artifact
 * to the database and returns; the browser asks for the next stage afterwards;
 * a closed browser simply means no further request arrives. Reopening the
 * project reads these values back and resumes from the last committed stage.
 *
 * Two stores, each with a contract, because a stored value that no longer
 * satisfies its contract must read as "absent" rather than as a partially
 * trusted artifact a later stage would build on:
 *
 *   * `projects.base_scene` holds the clean foundation: a title and a
 *     `CoreScene`, with the canonical hash it was committed under. It is keyed
 *     by the brief-only base input hash, so a base compiled for one brief can
 *     never be reused for another.
 *   * `projects.compiled_modules` holds one entry per slot, each with the
 *     module and the stage input hash that authorised it. A module whose
 *     stored input hash no longer matches the frozen snapshot is stale and is
 *     not reused.
 */

import { z } from "zod";
import { SLOTS } from "@/domain/limits";
import type { Slot } from "@/domain/influence";
import {
  CoreSceneSchema,
  InfluenceModuleSchema,
  type CoreScene,
  type InfluenceModule,
} from "@/domain/scene";
import { boundedText } from "@/domain/scene";
import { TEXT } from "@/domain/limits";

/** The clean brief-only foundation, exactly as it is persisted. */
export const StoredBaseSchema = z.strictObject({
  /** The brief-only base stage input hash this foundation was compiled for. */
  input_hash: z.string().min(16).max(64),
  /** The canonical hash of `core`, which is the project's `base_hash`. */
  hash: z.string().min(16).max(64),
  title: boundedText(TEXT.scene_title),
  core: CoreSceneSchema,
  model: z.string().min(1).max(80),
  compiled_at: z.string(),
});

export type StoredBase = z.infer<typeof StoredBaseSchema>;

export function readStoredBase(value: unknown): StoredBase | null {
  if (value === null || value === undefined) return null;
  const parsed = StoredBaseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function storedBaseFor(input: {
  inputHash: string;
  hash: string;
  title: string;
  core: CoreScene;
  model: string;
  compiledAt: string;
}): StoredBase {
  return {
    input_hash: input.inputHash,
    hash: input.hash,
    title: input.title,
    core: input.core,
    model: input.model,
    compiled_at: input.compiledAt,
  };
}

/** One committed module artifact. */
export const StoredModuleSchema = z.strictObject({
  /** The module stage input hash that authorised it. */
  input_hash: z.string().min(16).max(64),
  hash: z.string().min(16).max(64),
  module: InfluenceModuleSchema,
  model: z.string().min(1).max(80),
  compiled_at: z.string(),
});

export type StoredModule = z.infer<typeof StoredModuleSchema>;

export const StoredModulesSchema = z.record(z.enum(SLOTS), StoredModuleSchema);

export type StoredModules = Partial<Record<Slot, StoredModule>>;

/**
 * Reads the committed module artifacts, dropping any entry that no longer
 * satisfies the contract.
 *
 * Dropping rather than failing is the conservative direction: the compilation
 * then recompiles that slot instead of composing something it cannot validate.
 */
export function readStoredModules(value: unknown): StoredModules {
  if (value === null || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const modules: StoredModules = {};
  for (const slot of SLOTS) {
    const parsed = StoredModuleSchema.safeParse(source[slot]);
    if (parsed.success && parsed.data.module.slot === slot) modules[slot] = parsed.data;
  }
  return modules;
}

export function storedModuleFor(input: {
  inputHash: string;
  hash: string;
  module: InfluenceModule;
  model: string;
  compiledAt: string;
}): StoredModule {
  return {
    input_hash: input.inputHash,
    hash: input.hash,
    module: input.module,
    model: input.model,
    compiled_at: input.compiledAt,
  };
}
