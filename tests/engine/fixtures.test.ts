import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SECOND_COPY_VERSIONS,
  SECOND_COPY_BRIEF,
} from "../../fixtures/second-copy";
import { BUDGET } from "../../src/domain/limits";
import { canonicalJson } from "../../src/engine/hash";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("fixture honesty", () => {
  it("labels every influence as a design fixture", () => {
    for (const version of SECOND_COPY_VERSIONS) {
      for (const influence of version.scene.influences) {
        expect(influence.source_kind).toBe("design_fixture");
      }
    }
  });

  it("contains no Qloo identifier, timestamp, or API metadata", () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    for (const file of walk(join(repoRoot, "fixtures"))) {
      if (!file.endsWith(".json")) continue;
      const text = readFileSync(file, "utf8");
      expect(uuid.test(text), `${file} contains a UUID`).toBe(false);
      expect(iso.test(text), `${file} contains a timestamp`).toBe(false);
      expect(/qloo/i.test(text), `${file} mentions Qloo`).toBe(false);
      expect(/affinity|retrieved_at|x-api-key/i.test(text)).toBe(false);
    }
  });

  it("makes no retrieval claim in the brief", () => {
    expect(SECOND_COPY_BRIEF.cultural_anchor_query).toBeNull();
  });

  it("stays inside the serialized size budget", () => {
    for (const version of SECOND_COPY_VERSIONS) {
      const bytes = new TextEncoder().encode(canonicalJson(version.scene)).byteLength;
      expect(bytes).toBeLessThanOrEqual(BUDGET.serialized_bytes);
    }
  });
});

describe("no external service reaches the engine or the player", () => {
  /**
   * Phase 2 adds a deliberately narrow server boundary: `src/server/` and the
   * route handlers under `src/app/api/` may read configuration and talk to
   * Supabase and OpenAI. Nothing else may. This suite enforces that split, so
   * the pure engine, the trusted player, and the rendered pages stay offline
   * and credential-free exactly as they were in phase 1.
   */
  const SERVER_BOUNDARY = ["/src/server/", "/src/app/api/"];

  function sources(...dirs: string[]): string[] {
    return dirs
      .flatMap((dir) => walk(join(repoRoot, ...dir.split("/"))))
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
      .map((file) => file.split("\\").join("/"));
  }

  const pure = sources("src/domain", "src/engine", "fixtures");
  const clientReachable = sources("src/app", "src/components").filter(
    (file) => !SERVER_BOUNDARY.some((boundary) => file.includes(boundary)),
  );

  it("has sources to inspect on both sides of the boundary", () => {
    expect(pure.length).toBeGreaterThan(5);
    expect(clientReachable.length).toBeGreaterThan(3);
  });

  it("keeps the engine, the domain, and the fixtures entirely offline", () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /\bWebSocket\b/,
      /process\.env/,
      /from\s+["']openai["']/,
      /@supabase\//,
      /hackathon\.api\.qloo\.com/,
      /from\s+["']@\/server\//,
    ];
    for (const file of pure) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("never lets a client-reachable module read a credential or a provider SDK", () => {
    const forbidden = [
      /process\.env/,
      /from\s+["']openai["']/,
      /@supabase\//,
      /hackathon\.api\.qloo\.com/,
      /from\s+["']@\/server\//,
      /\.\.\/server\//,
    ];
    for (const file of clientReachable) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("keeps the trusted player free of network access", () => {
    const player = clientReachable.filter((file) => file.includes("/src/components/player/"));
    expect(player.length).toBeGreaterThan(0);
    for (const file of player) {
      const text = readFileSync(file, "utf8");
      expect(/\bfetch\s*\(/.test(text), file).toBe(false);
      expect(/XMLHttpRequest/.test(text), file).toBe(false);
    }
  });

  it("never evaluates generated code anywhere in src or fixtures", () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /dangerouslySetInnerHTML/];
    for (const file of sources("src", "fixtures")) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("keeps the engine and the domain free of React and Next imports", () => {
    const engineAndDomain = pure.filter(
      (file) => file.includes("/src/engine/") || file.includes("/src/domain/"),
    );
    expect(engineAndDomain.length).toBeGreaterThan(5);
    for (const file of engineAndDomain) {
      const text = readFileSync(file, "utf8");
      expect(/from\s+["']react/.test(text), file).toBe(false);
      expect(/from\s+["']next/.test(text), file).toBe(false);
    }
  });

  it("declares only the phase 2 route subset, and no phase 3 route", () => {
    const routes = walk(join(repoRoot, "src", "app"))
      .filter((file) => /route\.(ts|tsx)$/.test(file))
      .map((file) => relative(join(repoRoot, "src", "app"), file).split("\\").join("/"))
      .sort();
    expect(routes).toEqual([
      "api/projects/[id]/route.ts",
      "api/projects/route.ts",
      "api/session/route.ts",
    ]);
  });
});
