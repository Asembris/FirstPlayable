import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  bundleOfflinePlayer,
  FORBIDDEN_IN_BUNDLE,
  moduleSourceFor,
} from "../../scripts/build-export-runtime";
import {
  OFFLINE_EXPORT_SCHEMA,
  PUBLIC_SNAPSHOT_SCHEMA,
  type PublicSnapshot,
  PublicSnapshotSchema,
  SHARE_WARNING,
} from "../../src/domain/publish";
import { parseScene, type Scene } from "../../src/domain/scene";
import {
  OFFLINE_PLAYER_JS,
  OFFLINE_PLAYER_SHA256,
} from "../../src/export/generated/offline-player";
import { loadOfflinePlayable } from "../../src/export/guard";
import { buildOfflineExport, cspHash, escapeHtml } from "../../src/export/html";
import { OFFLINE_PLAYER_CSS } from "../../src/export/styles";
import { sha256Hex } from "../../src/engine/hash";
import { availableActions, initialState, step } from "../../src/engine/interpreter";
import {
  SECOND_COPY_BASE,
  SECOND_COPY_DISCOVERY_V1,
} from "../../fixtures/second-copy";

const generatedPath = fileURLToPath(
  new URL("../../src/export/generated/offline-player.ts", import.meta.url),
);

const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function snapshotOf(scene: Scene, includeProvenance = true): PublicSnapshot {
  return PublicSnapshotSchema.parse({
    schema: PUBLIC_SNAPSHOT_SCHEMA,
    title: scene.title,
    version_id: VERSION_ID,
    created_at: "2026-10-04T12:00:00.000Z",
    scene,
    active_slots: scene.modules.map((module) => module.slot),
    identifiers: {
      model: "gpt-4o-mini-2024-07-18",
      compiler: "fp-compiler-4.2",
      validator: "fp-engine-validator-1.0",
    },
    provenance_included: includeProvenance,
    provenance: includeProvenance
      ? scene.influences.map((influence) => ({
          slot: scene.modules[0]?.slot ?? "discovery",
          approval_id: influence.approval_id,
          retrieved: {
            reference_name: "Moon",
            domain: "movie",
            source_kind: influence.source_kind,
          },
          proposed: "Borrow the idea of a contradictory identity.",
          approved: {
            text: influence.approved_text,
            intended_effect: influence.intended_effect,
            edited_by_creator: false,
          },
          scene_changed: 'After core.inspect, "core.give" is locked with the influence.',
        }))
      : [],
  });
}

describe("the offline bundle is the engine, built at build time", () => {
  it("is committed in sync with its source", async () => {
    const rebuilt = moduleSourceFor(await bundleOfflinePlayer());
    const committed = readFileSync(generatedPath, "utf8").replace(/\r\n/g, "\n");
    expect(
      rebuilt,
      "run `npm run build:export`: the committed offline bundle has drifted from its source",
    ).toBe(committed);
  });

  it("records its own hash, which is what the exported CSP names", () => {
    expect(OFFLINE_PLAYER_SHA256).toBe(sha256Hex(OFFLINE_PLAYER_JS));
    expect(cspHash(OFFLINE_PLAYER_JS)).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  });

  /**
   * The bundle must be able to do nothing but play. No network identifier, no
   * generated-code construct, and no markup assignment appears in it, so an
   * exported file cannot reach a provider, a database, or a CDN even if one
   * were available.
   */
  it("contains no network call, no generated code, and no markup assignment", () => {
    for (const forbidden of FORBIDDEN_IN_BUNDLE) {
      expect(
        forbidden.pattern.test(OFFLINE_PLAYER_JS),
        `the bundle contains ${forbidden.name}`,
      ).toBe(false);
    }
    expect(OFFLINE_PLAYER_JS.includes("</script")).toBe(false);
    // And no credential shape, and no host.
    for (const shape of [
      /sb_secret_/,
      /sb_publishable_/,
      /sk-[A-Za-z0-9]{8,}/,
      /supabase\.co/,
      /api\.openai\.com/,
      /qloo\.com/,
    ]) {
      expect(shape.test(OFFLINE_PLAYER_JS), `the bundle matches ${String(shape)}`).toBe(false);
    }
  });

  /** It carries the real engine, not a second implementation of the rules. */
  it("carries the shared interpreter rather than a parallel one", () => {
    for (const marker of ["set_true", "blocked", "schema_version"]) {
      expect(OFFLINE_PLAYER_JS.includes(marker), marker).toBe(true);
    }
    // Zod is deliberately absent: its fast path constructs functions.
    expect(/ZodError|_zod|zod/i.test(OFFLINE_PLAYER_JS)).toBe(false);
  });
});

describe("the exported file is self-contained and inert", () => {
  const built = buildOfflineExport(snapshotOf(SECOND_COPY_DISCOVERY_V1), "2026-10-04T13:00:00.000Z");

  it("names its own script and stylesheet in a closed policy", () => {
    expect(built.html).toContain("default-src &#39;none&#39;");
    expect(built.html).toContain(escapeHtml(`script-src '${cspHash(OFFLINE_PLAYER_JS)}'`));
    expect(built.html).toContain(escapeHtml(`style-src '${cspHash(OFFLINE_PLAYER_CSS)}'`));
    for (const closed of [
      "img-src &#39;none&#39;",
      "connect-src &#39;none&#39;",
      "form-action &#39;none&#39;",
      "base-uri &#39;none&#39;",
      "object-src &#39;none&#39;",
    ]) {
      expect(built.html).toContain(closed);
    }
  });

  it("requests nothing from anywhere", () => {
    for (const shape of [/src="http/, /href="http/, /@import/, /url\(/]) {
      expect(shape.test(built.html), String(shape)).toBe(false);
    }
    // One script element and one style element, both inline.
    expect([...built.html.matchAll(/<script/g)]).toHaveLength(1);
    expect([...built.html.matchAll(/<style/g)]).toHaveLength(1);
  });

  it("carries the scene as base64, so no scene string can become markup", () => {
    const block = /<div id="fp-data" hidden>([^<]*)<\/div>/.exec(built.html);
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("names the version and warns that a download cannot be recalled", () => {
    expect(built.fileName).toBe(`firstplayable-${VERSION_ID.slice(0, 8)}.html`);
    expect(built.html).toContain(escapeHtml(SHARE_WARNING));
    expect(built.bytes).toBeGreaterThan(1000);
    // Comfortably inside anything a browser or an email will carry.
    expect(built.bytes).toBeLessThan(512 * 1024);
  });

  /**
   * The script-breakout test of specification section 16.
   *
   * A scene whose strings contain a closing script tag, an HTML event handler,
   * and a URL is exported, and none of it reaches the document as markup: it is
   * base64 inside a `div`, and it decodes back to the exact characters.
   */
  it("survives a scene full of script-breakout strings", () => {
    const hostile = parseScene({
      ...SECOND_COPY_BASE,
      title: "</script><img onerror=alert(1) src=x>",
      core: {
        ...SECOND_COPY_BASE.core,
        endings: SECOND_COPY_BASE.core.endings.map((ending, index) =>
          index === 0
            ? {
                ...ending,
                text: "</style></script><svg onload=\"alert(1)\"> see https://evil.example/x   ",
              }
            : ending,
        ),
      },
    });
    const file = buildOfflineExport(snapshotOf(hostile, false), "2026-10-04T13:00:00.000Z");

    // Nothing hostile appears as markup anywhere in the bytes.
    expect(file.html.includes("<img onerror")).toBe(false);
    expect(file.html.includes("<svg onload")).toBe(false);
    expect(file.html.includes("https://evil.example")).toBe(false);
    expect(file.html.includes(" ")).toBe(false);
    // Exactly one script element still, and the title is escaped in <title>.
    expect([...file.html.matchAll(/<script/g)]).toHaveLength(1);
    expect(file.html).toContain("&lt;/script&gt;&lt;img onerror=alert(1) src=x&gt;");

    // And the data block round-trips to the exact original characters.
    const block = /<div id="fp-data" hidden>([^<]*)<\/div>/.exec(file.html);
    const decoded = JSON.parse(
      Buffer.from(block?.[1] ?? "", "base64").toString("utf8"),
    ) as { schema: string; snapshot: { scene: { title: string } } };
    expect(decoded.schema).toBe(OFFLINE_EXPORT_SCHEMA);
    expect(decoded.snapshot.scene.title).toBe(hostile.title);
  });

  it("contains no credential, no host, and no private draft", () => {
    for (const shape of [
      /sb_secret_/,
      /sb_publishable_/,
      /sbp_[0-9a-f]{8,}/,
      /sk-[A-Za-z0-9]{8,}/,
      /supabase\.co/,
      /api\.openai\.com/,
      /qloo\.com/,
      /fp_owner/,
      /owner_session/,
      /read_token/,
      /proposal_draft/,
      /request_fingerprint/,
    ]) {
      expect(shape.test(built.html), `the export matches ${String(shape)}`).toBe(false);
    }
  });
});

describe("the offline load guard refuses what it cannot run", () => {
  function payload(snapshot: unknown): unknown {
    return {
      schema: OFFLINE_EXPORT_SCHEMA,
      exported_at: "2026-10-04T13:00:00.000Z",
      snapshot,
    };
  }

  it("accepts a real exported snapshot and plays it with the shared engine", () => {
    const loaded = loadOfflinePlayable(payload(snapshotOf(SECOND_COPY_DISCOVERY_V1)));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // The engine the guard handed back is the engine: a complete playthrough
    // runs over it with no further input of any kind.
    const scene = loaded.playable.scene;
    let state = initialState(scene);
    const first = availableActions(scene, state).find((action) => action.enabled);
    expect(first).toBeDefined();
    const result = step(scene, state, first!.action_id);
    expect(result.ok).toBe(true);
    if (result.ok) state = result.state;
    expect(state.bits).not.toBe(0);
    expect(loaded.playable.provenance.length).toBeGreaterThan(0);
    expect(loaded.playable.identifiers.validator).toBe("fp-engine-validator-1.0");
  });

  it("refuses a file built for another contract version", () => {
    expect(loadOfflinePlayable({ schema: "fp-offline-0.9" }).ok).toBe(false);
    const wrongSnapshot = payload({
      ...snapshotOf(SECOND_COPY_BASE),
      schema: "fp-public-0.9",
    });
    expect(loadOfflinePlayable(wrongSnapshot).ok).toBe(false);
  });

  it("refuses a corrupt scene instead of running an approximate one", () => {
    const base = snapshotOf(SECOND_COPY_DISCOVERY_V1);
    const cases: { label: string; scene: unknown }[] = [
      { label: "not an object", scene: "a scene" },
      { label: "unsupported schema", scene: { ...base.scene, schema_version: "2.0" } },
      {
        label: "missing endings",
        scene: { ...base.scene, core: { ...base.scene.core, endings: [] } },
      },
      {
        label: "a dangling dialogue reference",
        scene: {
          ...base.scene,
          core: {
            ...base.scene.core,
            actions: base.scene.core.actions.map((action, index) =>
              index === 0
                ? {
                    ...action,
                    branches: action.branches.map((branch) => ({
                      ...branch,
                      dialogue_id: "nope.missing",
                    })),
                  }
                : action,
            ),
          },
        },
      },
      {
        label: "an undeclared variable read",
        scene: {
          ...base.scene,
          core: {
            ...base.scene.core,
            actions: base.scene.core.actions.map((action, index) =>
              index === 0
                ? {
                    ...action,
                    when: {
                      kind: "any",
                      clauses: [[{ var_id: "nope.missing", equals: false }]],
                    },
                  }
                : action,
            ),
          },
        },
      },
      {
        label: "a gate on an action that does not exist",
        scene: {
          ...base.scene,
          modules: base.scene.modules.map((module) => ({
            ...module,
            gates: module.gates.map((gate) => ({ ...gate, action_id: "nope.missing" })),
          })),
        },
      },
    ];
    for (const entry of cases) {
      const loaded = loadOfflinePlayable(payload({ ...base, scene: entry.scene }));
      expect(loaded.ok, entry.label).toBe(false);
    }
  });

  it("refuses a snapshot with no identity", () => {
    const base = snapshotOf(SECOND_COPY_BASE);
    const { version_id: _versionId, ...withoutId } = base;
    expect(loadOfflinePlayable(payload(withoutId)).ok).toBe(false);
  });
});
