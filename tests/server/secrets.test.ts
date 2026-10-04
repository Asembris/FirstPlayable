import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AppError,
  ERROR_CODES,
  errorEnvelope,
  redactDiagnostic,
} from "../../src/server/security/errors";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".sql",
  ".css", ".html", ".txt", ".yml", ".yaml", ".toml", ".example", ".map", "",
]);

/** Credential shapes, not credential values. Mirrors scripts/scan-secrets.ts. */
const CREDENTIAL_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{8,}/ },
  { name: "supabase publishable key", pattern: /sb_publishable_[A-Za-z0-9_-]{8,}/ },
  { name: "supabase personal access token", pattern: /sbp_[0-9a-f]{40,}/ },
  { name: "supabase legacy service jwt", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
  { name: "openai project key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: "openai legacy key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
];

describe("nothing secret is tracked", () => {
  const trackedFiles = tracked();

  it("has files to inspect", () => {
    expect(trackedFiles.length).toBeGreaterThan(30);
  });

  it("does not track .env or .vercel", () => {
    for (const forbidden of [".env", ".vercel"]) {
      const hits = trackedFiles.filter(
        (file) => file === forbidden || file.startsWith(`${forbidden}/`),
      );
      expect(hits, `${forbidden} must stay untracked`).toEqual([]);
    }
  });

  it("ignores .env and .vercel, so neither can be added by accident", () => {
    for (const path of [".env", ".vercel/project.json"]) {
      const output = execFileSync("git", ["check-ignore", "-v", path], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(output, path).toContain(".gitignore");
    }
  });

  it("keeps .env out of a CLI deployment upload, which does not read .gitignore", () => {
    const rules = (file: string): string[] =>
      readFileSync(join(repoRoot, file), "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    const upload = rules(".vercelignore");

    expect(upload).toContain(".env");
    expect(upload).toContain(".env.*");
    expect(upload.indexOf("!.env.example")).toBeGreaterThan(upload.indexOf(".env.*"));
    for (const rule of rules(".gitignore")) {
      expect(upload, `.vercelignore must repeat the .gitignore rule ${rule}`).toContain(rule);
    }
  });

  it("contains no credential shape in any tracked file", () => {
    for (const relative of trackedFiles) {
      if (!TEXT_EXTENSIONS.has(extname(relative))) continue;
      const text = readFileSync(join(repoRoot, relative), "utf8");
      for (const shape of CREDENTIAL_SHAPES) {
        expect(shape.pattern.test(text), `${relative} contains a ${shape.name}`).toBe(false);
      }
    }
  });

  it("declares no NEXT_PUBLIC variable that could carry a server secret", () => {
    const forbidden =
      /NEXT_PUBLIC_[A-Z0-9_]*(SUPABASE|OPENAI|QLOO|SECRET|API_KEY|ACCESS_TOKEN)[A-Z0-9_]*/;
    for (const relative of trackedFiles) {
      if (!TEXT_EXTENSIONS.has(extname(relative))) continue;
      const text = readFileSync(join(repoRoot, relative), "utf8");
      expect(forbidden.test(text), `${relative} declares a public server secret`).toBe(false);
    }
  });

  it("names every server-only variable in the environment template", () => {
    const template = readFileSync(join(repoRoot, ".env.example"), "utf8");
    for (const name of [
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
      "SUPABASE_ACCESS_TOKEN",
      "OPENAI_API_KEY",
      "OPENAI_CHAT_MODEL",
    ]) {
      expect(template, name).toContain(`${name}=`);
    }
    // The template carries names and the pinned model, never a value.
    expect(template).toContain("OPENAI_CHAT_MODEL=gpt-4o-mini-2024-07-18");
    expect(template).toMatch(/^SUPABASE_SECRET_KEY=$/m);
    expect(template).toMatch(/^OPENAI_API_KEY=$/m);
  });
});

describe("the browser has no path to Supabase or to a provider", () => {
  const sources = walk(join(repoRoot, "src")).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".tsx"),
  );
  const clientReachable = sources.filter((file) => {
    const normalized = file.split("\\").join("/");
    return !normalized.includes("/src/server/") && !normalized.includes("/src/app/api/");
  });

  it("uses no browser Supabase client and no public-key architecture", () => {
    const all = sources.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(all).not.toContain("@supabase/ssr");
    expect(all).not.toContain("@supabase/auth-helpers");
    expect(all).not.toMatch(/createBrowserClient|createClientComponentClient/);
    // Exactly one module constructs a client, and it is the server boundary.
    const constructors = sources.filter((file) =>
      readFileSync(file, "utf8").includes("createClient("),
    );
    expect(constructors.map((file) => file.split("\\").join("/").split("/src/")[1])).toEqual([
      "server/db/supabase-gateway.ts",
    ]);
  });

  it("keeps every credential read inside the server boundary", () => {
    expect(clientReachable.length).toBeGreaterThan(3);
    for (const file of clientReachable) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("process.env");
      expect(text, file).not.toContain("@supabase/");
      expect(text, file).not.toMatch(/from\s+["']openai/);
      expect(text, file).not.toMatch(/from\s+["']@\/server\//);
    }
  });

  it("lets the studio client talk only to this application's own API", () => {
    const studio = clientReachable
      .filter((file) => file.split("\\").join("/").includes("/src/components/studio/"))
      .map((file) => ({ file, text: readFileSync(file, "utf8") }));
    expect(studio.length).toBeGreaterThan(0);

    const callers = studio.filter(({ text }) => /\bfetch\(/.test(text));
    // Exactly one module in the studio shell performs network access at all.
    expect(callers).toHaveLength(1);

    for (const { file, text } of callers) {
      for (const target of [...text.matchAll(/fetch\(\s*([^,)]+)/g)]) {
        const argument = (target[1] ?? "").trim();
        expect(
          /^(path|`\/|"\/|'\/)/.test(argument),
          `${file} fetches something other than a same-origin path: ${argument}`,
        ).toBe(true);
      }
      expect(text, file).toContain('credentials: "same-origin"');
      expect(text, file).not.toMatch(/https?:\/\//);
    }
  });
});

describe("error responses are redacted", () => {
  it("strips every credential shape, hash, and URL from a diagnostic", () => {
    /**
     * Every prefix is assembled at runtime, so this file does not itself
     * contain a string shaped like a credential. The scan above is strict on
     * purpose, and a test fixture must not be the reason it is loosened.
     */
    const supabaseKeyPrefix = ["sb", "secret", ""].join("_");
    const openAiKeyPrefix = ["sk", "proj", ""].join("-");
    const accessTokenPrefix = ["sbp", ""].join("_");
    const jwtPrefix = ["ey", "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"].join("");

    const hostile = [
      `connect ECONNREFUSED https://project-ref.${["supabase", "co"].join(".")}/rest/v1/projects`,
      `apikey ${supabaseKeyPrefix}abcdefghijklmnopqrstuvwxyz`,
      `Authorization: Bearer ${openAiKeyPrefix}abcdefghijklmnopqrstuvwxyz0123456789`,
      `token ${accessTokenPrefix}0123456789abcdef0123456789abcdef01234567`,
      `jwt ${jwtPrefix}.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature`,
      `session hash ${"a".repeat(64)}`,
    ].join(" | ");

    const redacted = redactDiagnostic(hostile, 1_000);

    expect(redacted).not.toContain(supabaseKeyPrefix);
    expect(redacted).not.toContain(openAiKeyPrefix);
    expect(redacted).not.toContain(accessTokenPrefix);
    expect(redacted).not.toContain(jwtPrefix);
    expect(redacted).not.toContain("a".repeat(64));
    expect(redacted).not.toContain(["supabase", "co"].join("."));
    expect(redacted).toContain("[redacted]");
  });

  it("collapses newlines and caps the length, so a stack trace cannot be logged whole", () => {
    const error = new Error("boom");
    error.stack = `Error: boom\n    at Object.<anonymous> (${"x".repeat(2_000)})`;
    const redacted = redactDiagnostic(error);
    expect(redacted).toBe("Error: boom");

    const long = redactDiagnostic("y".repeat(5_000));
    expect(long.length).toBeLessThanOrEqual(301);
  });

  it("keeps the diagnostic out of the envelope the browser receives", () => {
    const error = new AppError({
      code: ERROR_CODES.PERSISTENCE_UNAVAILABLE,
      status: 503,
      publicMessage: "Saving is unavailable right now.",
      retryable: true,
      diagnostic: "insertProject: duplicate key value violates unique constraint",
    });

    const envelope = errorEnvelope(error, "11111111-2222-3333-4444-555555555555");

    expect(Object.keys(envelope).sort()).toEqual([
      "code",
      "last_good_version_id",
      "message",
      "request_id",
      "retryable",
    ]);
    expect(JSON.stringify(envelope)).not.toContain("duplicate key");
    expect(JSON.stringify(envelope)).not.toContain("insertProject");
  });

  it("never carries a diagnostic for any code the routes can produce", () => {
    const keyPrefix = ["sb", "secret", ""].join("_");
    for (const code of Object.values(ERROR_CODES)) {
      const envelope = errorEnvelope(
        new AppError({
          code,
          status: 500,
          publicMessage: "x",
          retryable: false,
          diagnostic: `${keyPrefix}abcdefghijklmnop`,
        }),
        "req",
      );
      expect(JSON.stringify(envelope)).not.toContain(keyPrefix);
    }
  });
});

describe("built assets, when a build is present", () => {
  const buildDirs = [join(repoRoot, ".next", "static"), join(repoRoot, ".next", "server")];
  const built = buildDirs.flatMap(walk).filter((file) => TEXT_EXTENSIONS.has(extname(file)));

  it("carries no credential shape", () => {
    if (built.length === 0) {
      // `npm run check:secrets` is the gate that requires a build to exist.
      expect(built).toEqual([]);
      return;
    }
    for (const file of built) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const shape of CREDENTIAL_SHAPES) {
        expect(shape.pattern.test(text), `${file} contains a ${shape.name}`).toBe(false);
      }
    }
  });

  it("carries no Supabase host in a client bundle", () => {
    const clientFiles = walk(join(repoRoot, ".next", "static")).filter(
      (file) => extname(file) === ".js",
    );
    for (const file of clientFiles) {
      const text = readFileSync(file, "utf8");
      expect(/\.supabase\.co/.test(text), `${file} names a Supabase host`).toBe(false);
      expect(/api\.openai\.com/.test(text), `${file} names the OpenAI host`).toBe(false);
    }
  });
});
