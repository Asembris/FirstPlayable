/**
 * The offline load guard (specification section 12, "Export and share safety").
 *
 * What this is: the check an exported file performs on its own embedded data
 * before it runs it, so a corrupt, truncated, or hand-edited file shows "This
 * playable could not be loaded" rather than executing an approximate version.
 *
 * What this is **not**: a second validator. The authoritative decision was made
 * on the server by the Phase 1 engine — `validateScene`,
 * `validateSceneSubsets`, and `findMechanicalWitness` — before the version was
 * ever committed, and the exported file records which validator accepted it.
 * The deliberate split exists for one concrete reason: `validateScene` reaches
 * the Zod contract, and Zod's fast path constructs functions at runtime. An
 * offline file that must run under a restrictive CSP with no network, and that
 * must not evaluate generated code, cannot carry that. So the export carries
 * the engine — the real `composeScene`, `availableActions`, and `step`, not a
 * second implementation of the rules — plus the checks below, which are exactly
 * the ones that make the interpreter total:
 *
 *   * the contract versions are the ones this bundle was built for;
 *   * the flag count fits the engine's ordered bitset;
 *   * every variable an atom reads or an effect writes is declared;
 *   * every dialogue node, ending, and port an action, gate, or hook names
 *     resolves;
 *   * there are the three endings the product contract fixes.
 *
 * A file that passes these runs; a file that fails any of them is refused whole.
 */

import { BUDGET } from "../domain/limits";
import type {
  Action,
  Condition,
  EndingCopyOverride,
  Scene,
} from "../domain/scene";
import { composeScene } from "../engine/compose";

/** The two contract versions a bundle is built against. */
export const SUPPORTED_SCENE_SCHEMA = "1.0";
export const SUPPORTED_SNAPSHOT_SCHEMA = "fp-public-1.0";
export const SUPPORTED_EXPORT_SCHEMA = "fp-offline-1.0";

export type LoadedPlayable = {
  readonly title: string;
  readonly versionId: string;
  readonly createdAt: string;
  readonly exportedAt: string;
  readonly scene: Scene;
  readonly provenance: readonly {
    readonly slot: string;
    readonly referenceName: string | null;
    readonly domain: string | null;
    readonly proposed: string | null;
    readonly approvedText: string;
    readonly editedByCreator: boolean;
    readonly sceneChanged: string | null;
  }[];
  readonly identifiers: {
    readonly model: string | null;
    readonly compiler: string | null;
    readonly validator: string | null;
  };
};

export type LoadResult =
  | { readonly ok: true; readonly playable: LoadedPlayable }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads an exported data block, or refuses it with a short reason. */
export function loadOfflinePlayable(value: unknown): LoadResult {
  if (!isRecord(value)) return { ok: false, reason: "the embedded data is not an object" };
  if (value["schema"] !== SUPPORTED_EXPORT_SCHEMA) {
    return { ok: false, reason: "this file was made for a different export version" };
  }
  const snapshot = value["snapshot"];
  if (!isRecord(snapshot)) return { ok: false, reason: "the embedded snapshot is missing" };
  if (snapshot["schema"] !== SUPPORTED_SNAPSHOT_SCHEMA) {
    return { ok: false, reason: "this snapshot was made for a different version" };
  }

  const title = str(snapshot["title"]);
  const versionId = str(snapshot["version_id"]);
  const createdAt = str(snapshot["created_at"]);
  const exportedAt = str(value["exported_at"]);
  if (title === null || versionId === null || createdAt === null || exportedAt === null) {
    return { ok: false, reason: "the snapshot is missing its identity" };
  }

  const scene = checkScene(snapshot["scene"]);
  if (!scene.ok) return scene;

  const identifiersSource = isRecord(snapshot["identifiers"]) ? snapshot["identifiers"] : {};
  const provenanceSource = Array.isArray(snapshot["provenance"])
    ? snapshot["provenance"]
    : [];

  return {
    ok: true,
    playable: {
      title,
      versionId,
      createdAt,
      exportedAt,
      scene: scene.scene,
      provenance: provenanceSource.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const approved = isRecord(entry["approved"]) ? entry["approved"] : {};
        const retrieved = isRecord(entry["retrieved"]) ? entry["retrieved"] : {};
        const approvedText = str(approved["text"]);
        const slot = str(entry["slot"]);
        if (approvedText === null || slot === null) return [];
        return [
          {
            slot,
            referenceName: str(retrieved["reference_name"]),
            domain: str(retrieved["domain"]),
            proposed: str(entry["proposed"]),
            approvedText,
            editedByCreator: approved["edited_by_creator"] === true,
            sceneChanged: str(entry["scene_changed"]),
          },
        ];
      }),
      identifiers: {
        model: str(identifiersSource["model"]),
        compiler: str(identifiersSource["compiler"]),
        validator: str(identifiersSource["validator"]),
      },
    },
  };
}

type SceneCheck = { ok: true; scene: Scene } | { ok: false; reason: string };

function checkScene(value: unknown): SceneCheck {
  if (!isRecord(value)) return { ok: false, reason: "the scene is not an object" };
  if (value["schema_version"] !== SUPPORTED_SCENE_SCHEMA) {
    return { ok: false, reason: "this scene uses an unsupported schema version" };
  }

  const scene = value as unknown as Scene;
  const core = scene.core;
  const world = scene.world;
  if (
    !isRecord(core) ||
    !isRecord(world) ||
    !Array.isArray(core.variables) ||
    !Array.isArray(core.actions) ||
    !Array.isArray(core.dialogue) ||
    !Array.isArray(core.endings) ||
    !Array.isArray(scene.modules) ||
    !Array.isArray(scene.ending_copy_overrides) ||
    !Array.isArray(scene.influences) ||
    !Array.isArray(scene.provenance) ||
    !Array.isArray(world.characters) ||
    world.characters.length !== 1
  ) {
    return { ok: false, reason: "the scene is not shaped like a scene" };
  }
  if (core.endings.length !== BUDGET.endings) {
    return { ok: false, reason: "the scene does not declare its three endings" };
  }

  let view;
  try {
    view = composeScene(
      core,
      scene.modules,
      scene.ending_copy_overrides as readonly EndingCopyOverride[],
    );
  } catch {
    return { ok: false, reason: "the scene could not be composed" };
  }

  // The engine's ordered bitset is what every state is, so a scene with more
  // flags than it can address is refused rather than silently truncated.
  if (view.variables.length > BUDGET.total_variables) {
    return { ok: false, reason: "the scene declares more state than the engine addresses" };
  }

  const resolvesCondition = (condition: Condition): boolean => {
    if (condition.kind !== "any") return true;
    return condition.clauses.every((clause) =>
      clause.every((atom) => view.variableBit.has(atom.var_id)),
    );
  };

  const resolvesAction = (action: Action): boolean => {
    if (!resolvesCondition(action.when)) return false;
    if (!Array.isArray(action.branches) || action.branches.length === 0) return false;
    return action.branches.every((branch) => {
      if (!resolvesCondition(branch.when)) return false;
      if (!branch.effects.every((effect) => view.variableBit.has(effect.var_id))) return false;
      if (branch.dialogue_id !== null && !view.dialogueById.has(branch.dialogue_id)) {
        return false;
      }
      return branch.ending_id === null || view.endingById.has(branch.ending_id);
    });
  };

  for (const entry of view.actions) {
    if (!resolvesAction(entry.action)) {
      return { ok: false, reason: "an action refers to something the scene does not declare" };
    }
  }
  for (const module of scene.modules) {
    for (const gate of module.gates) {
      if (!view.actionById.has(gate.action_id) || !resolvesCondition(gate.when)) {
        return { ok: false, reason: "a gate refers to something the scene does not declare" };
      }
    }
    for (const hook of module.on_actions) {
      if (!view.actionById.has(hook.action_id)) {
        return { ok: false, reason: "a hook refers to an action the scene does not declare" };
      }
      if (!resolvesCondition(hook.when)) {
        return { ok: false, reason: "a hook condition reads state the scene does not declare" };
      }
      if (!hook.effects.every((effect) => view.variableBit.has(effect.var_id))) {
        return { ok: false, reason: "a hook writes state the scene does not declare" };
      }
      if (hook.dialogue_id !== null && !view.dialogueById.has(hook.dialogue_id)) {
        return { ok: false, reason: "a hook names a line the scene does not declare" };
      }
    }
  }

  return { ok: true, scene };
}
