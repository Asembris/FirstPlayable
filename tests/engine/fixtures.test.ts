import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
  const sources = [
    ...walk(join(repoRoot, "src")),
    ...walk(join(repoRoot, "fixtures")),
  ].filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

  it("has sources to inspect", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it("never performs network access or reads provider credentials", () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /\bWebSocket\b/,
      /process\.env/,
      /from\s+["']openai["']/,
      /@supabase\//,
      /hackathon\.api\.qloo\.com/,
    ];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("never evaluates generated code", () => {
    const forbidden = [/\beval\s*\(/, /new\s+Function\s*\(/, /dangerouslySetInnerHTML/];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("keeps the engine and the domain free of React and Next imports", () => {
    const pure = sources.filter(
      (file) => file.includes("/src/engine/") || file.includes("/src/domain/"),
    );
    expect(pure.length).toBeGreaterThan(5);
    for (const file of pure) {
      const text = readFileSync(file, "utf8");
      expect(/from\s+["']react/.test(text), file).toBe(false);
      expect(/from\s+["']next/.test(text), file).toBe(false);
    }
  });

  it("declares no API route in this phase", () => {
    const routes = walk(join(repoRoot, "src", "app")).filter((file) =>
      /route\.(ts|tsx)$/.test(file),
    );
    expect(routes).toEqual([]);
  });
});
