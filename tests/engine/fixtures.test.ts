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

  /**
   * The design fixtures must stay design fixtures. Phase 3 adds real redacted
   * Qloo captures under `fixtures/qloo/`, which do legitimately carry real
   * entity UUIDs — that is checked separately below. The hand-authored scene
   * fixtures still may not, because a fixture cannot mint a production Qloo
   * badge (specification section 5, "Layer A").
   */
  it("keeps the hand-authored scene fixtures free of Qloo identity", () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const designFixtures = walk(join(repoRoot, "fixtures")).filter(
      (file) => file.endsWith(".json") && !file.split("\\").join("/").includes("/fixtures/qloo/"),
    );
    expect(designFixtures.length).toBeGreaterThan(3);
    for (const file of designFixtures) {
      const text = readFileSync(file, "utf8");
      expect(uuid.test(text), `${file} contains a UUID`).toBe(false);
      expect(iso.test(text), `${file} contains a timestamp`).toBe(false);
      expect(/qloo/i.test(text), `${file} mentions Qloo`).toBe(false);
      expect(/affinity|retrieved_at|x-api-key/i.test(text)).toBe(false);
    }
  });

  /**
   * The opposite claim, for the phase 3 captures: they are real responses, so
   * they must carry real identity, and they must carry no credential, header,
   * or request diagnostic.
   */
  it("keeps the real Qloo captures real, and free of any credential", () => {
    const uuid = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/;
    const captures = walk(join(repoRoot, "fixtures", "qloo")).filter((file) =>
      file.endsWith(".json"),
    );
    expect(captures.length).toBeGreaterThan(2);
    let withIdentity = 0;
    for (const file of captures) {
      const text = readFileSync(file, "utf8");
      if (uuid.test(text)) withIdentity += 1;
      expect(/x-api-key/i.test(text), `${file} carries a key header`).toBe(false);
      expect(/authorization/i.test(text), `${file} carries an auth header`).toBe(false);
      // Removed during redaction: images, marketing links, audience and
      // demographic claims. None of these may be stored or sent onward.
      for (const forbidden of [
        "images.qloo.com",
        "audience_identity",
        "situational_contexts",
        "player_demographics",
        "websites",
      ]) {
        expect(text.includes(forbidden), `${file} retains ${forbidden}`).toBe(false);
      }
    }
    expect(withIdentity).toBeGreaterThan(0);
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

  /**
   * The frozen route surface, phase by phase. Phase 4 adds exactly its four
   * locked routes of specification section 11 and nothing else.
   */
  it("declares only the phase 2 to phase 4 route subset", () => {
    const routes = walk(join(repoRoot, "src", "app"))
      .filter((file) => /route\.(ts|tsx)$/.test(file))
      .map((file) => relative(join(repoRoot, "src", "app"), file).split("\\").join("/"))
      .sort();
    expect(routes).toEqual([
      "api/operations/[id]/advance/route.ts",
      "api/operations/[id]/route.ts",
      "api/projects/[id]/activate/route.ts",
      "api/projects/[id]/anchor/route.ts",
      "api/projects/[id]/artist-search/route.ts",
      "api/projects/[id]/compile/route.ts",
      "api/projects/[id]/decisions/route.ts",
      "api/projects/[id]/proposals/route.ts",
      "api/projects/[id]/references/route.ts",
      "api/projects/[id]/route.ts",
      "api/projects/route.ts",
      "api/session/route.ts",
    ]);
  });

  /**
   * Revision, publication, export, and the public share belong to phase 5.
   * None of them may exist yet, and no route may expose an arbitrary Qloo,
   * model, prompt, or operation-stage request either.
   */
  it("declares no phase 5 route, and no arbitrary upstream or stage route", () => {
    const routes = walk(join(repoRoot, "src", "app"))
      .filter((file) => /route\.(ts|tsx)$/.test(file))
      .map((file) => relative(join(repoRoot, "src", "app"), file).split("\\").join("/"));
    for (const laterPhase of [
      "revisions",
      "publish",
      "publications",
      "public",
      "export",
      "share",
      "qloo",
      "openai",
      "model",
      "prompt",
      // The browser asks for *the next* stage; it can never name one.
      "stage",
      "base",
      "module",
      "validate",
    ]) {
      expect(
        routes.filter((route) => route.includes(laterPhase)),
        `${laterPhase} is not part of phase 4`,
      ).toEqual([]);
    }
  });

  /**
   * The advance route's body contract has no stage field, which is what makes
   * "the controller, not the browser, chooses the next valid stage" structural
   * rather than a convention.
   */
  it("gives the advance route an empty request contract", () => {
    const contracts = readFileSync(join(repoRoot, "src", "domain", "compile.ts"), "utf8");
    const declaration = /export const AdvanceRequestSchema = z\.strictObject\(\{\}\);/.exec(
      contracts,
    );
    expect(declaration, "AdvanceRequestSchema must be a strict empty object").not.toBeNull();
  });
});

/**
 * The offline gate has to test what the repository currently says.
 *
 * `next start` serves whatever `.next` already holds, so a browser gate that
 * only starts the server tests the last build that happened on the machine,
 * which can be a build of a different commit. That produces failures for code
 * that is present in the source and absent only from the stale bundle — and,
 * just as dangerous, a pass for code that has since been removed. The gate has
 * to build the assets it then serves, whatever order the surrounding steps run
 * in. This was found by running the gate, not by reading it.
 */
describe("the offline gate tests what the repository currently says", () => {
  const playwrightConfig = readFileSync(
    join(repoRoot, "playwright.config.ts"),
    "utf8",
  );

  it("builds the application before the browser gate serves it", () => {
    const webServer = /command:\s*`([^`]+)`/.exec(playwrightConfig);
    expect(webServer, "the browser gate must declare a webServer command").not.toBeNull();
    const command = webServer?.[1] ?? "";
    expect(command).toContain("npm run build");
    expect(command).toContain("npm run start");
    expect(
      command.indexOf("npm run build") < command.indexOf("npm run start"),
      "the build has to happen before the server starts",
    ).toBe(true);
  });
});
