/**
 * Bundles the trusted offline player, at build time.
 *
 *   npm run build:export        # also runs automatically before `npm run build`
 *
 * Why a build step rather than a runtime bundle: the exported HTML must carry
 * one inline script whose SHA-256 is named in the file's own Content-Security
 * Policy, and it must carry the **real** Phase 1 engine rather than a second
 * implementation of the transition rules. Browsers cannot load ES modules from
 * `file://`, so the engine has to be bundled into one classic script, and the
 * only honest moment to do that is before the deployment is built.
 *
 * The result is committed as `src/export/generated/offline-player.ts`, so what a
 * deployment serves is exactly the reviewed bytes, and
 * `tests/server/export.test.ts` rebuilds it and fails if the committed file has
 * drifted. That test is what makes "the export carries the engine the server
 * validated with" checkable rather than asserted.
 *
 * What the bundle deliberately does **not** contain: Zod. The authoritative
 * contract's fast path constructs functions at runtime, which an offline file
 * under a restrictive CSP must not do. The export's own load check is
 * `src/export/guard.ts`, and the bundle is scanned for `eval`, `Function`,
 * `fetch`, `XMLHttpRequest`, and dynamic `import` by the same test.
 */

import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../src/engine/hash";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = join(repoRoot, "src", "export", "offline-entry.ts");
const outputPath = join(repoRoot, "src", "export", "generated", "offline-player.ts");

/** Identifiers an offline, CSP-restricted, network-free bundle must not contain. */
export const FORBIDDEN_IN_BUNDLE: readonly { name: string; pattern: RegExp }[] = [
  { name: "eval", pattern: /\beval\s*\(/ },
  { name: "Function constructor", pattern: /\bnew\s+(Function|F)\s*\(/ },
  { name: "fetch", pattern: /\bfetch\s*\(/ },
  { name: "XMLHttpRequest", pattern: /XMLHttpRequest/ },
  { name: "dynamic import", pattern: /\bimport\s*\(/ },
  { name: "WebSocket", pattern: /WebSocket/ },
  { name: "importScripts", pattern: /importScripts/ },
  { name: "innerHTML", pattern: /innerHTML/ },
  { name: "document.write", pattern: /document\s*\.\s*write/ },
];

export async function bundleOfflinePlayer(): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    charset: "utf8",
    // No external: everything the player needs is bundled, because there is
    // nothing an offline file could resolve at runtime.
    external: [],
  });

  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error("esbuild produced no output file");
  const code = output.text.trim();

  for (const forbidden of FORBIDDEN_IN_BUNDLE) {
    if (forbidden.pattern.test(code)) {
      throw new Error(
        `the offline bundle contains ${forbidden.name}, which an offline export must not do`,
      );
    }
  }
  if (code.includes("</script")) {
    throw new Error("the offline bundle contains a script-closing sequence");
  }
  return code;
}

/** The committed module, generated deterministically from the bundle. */
export function moduleSourceFor(code: string): string {
  return [
    "/**",
    " * GENERATED FILE — do not edit.",
    " *",
    " * Produced by `npm run build:export` from `src/export/offline-entry.ts` and",
    " * the Phase 1 engine. It is committed so a deployment serves exactly the",
    " * reviewed bytes, and `tests/server/export.test.ts` rebuilds it and fails if",
    " * this file has drifted from its source.",
    " *",
    " * It contains no Zod, no network call, and no generated-code construct; the",
    " * build script refuses to write a bundle that does.",
    " */",
    "",
    `/** SHA-256 of {@link OFFLINE_PLAYER_JS}, for the exported file's own CSP. */`,
    `export const OFFLINE_PLAYER_SHA256 = ${JSON.stringify(sha256Hex(code))};`,
    "",
    `export const OFFLINE_PLAYER_JS = ${JSON.stringify(code)};`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const code = await bundleOfflinePlayer();
  const source = moduleSourceFor(code);
  mkdirSync(dirname(outputPath), { recursive: true });

  let previous: string | null = null;
  try {
    previous = readFileSync(outputPath, "utf8");
  } catch {
    previous = null;
  }

  if (previous === source) {
    console.log(`build:export OK — unchanged (${code.length} bytes of script)`);
    return;
  }
  writeFileSync(outputPath, source, "utf8");
  console.log(
    `build:export wrote src/export/generated/offline-player.ts (${code.length} bytes of script)`,
  );
}

// Importable by the test, runnable as a script.
if (process.argv[1] !== undefined && process.argv[1].includes("build-export-runtime")) {
  void main();
}
