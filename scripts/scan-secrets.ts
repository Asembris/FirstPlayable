/**
 * Secret scanner for tracked files and built assets.
 *
 * Reports the file, the pattern name, and the byte offset of any hit. It never
 * prints the matched text, so a true positive cannot leak the credential it
 * found. Run after `npm run build` so the client bundle is included:
 *
 *   npm run build && npm run check:secrets
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type Rule = { name: string; pattern: RegExp; allow?: RegExp };

/**
 * Credential shapes, not credential values. `allow` marks the one legitimate
 * reason a shape may appear: a documentation comment or an environment template
 * naming the shape without carrying a value.
 */
const RULES: readonly Rule[] = [
  { name: "supabase secret key", pattern: /sb_secret_[A-Za-z0-9_-]{8,}/g },
  { name: "supabase publishable key", pattern: /sb_publishable_[A-Za-z0-9_-]{8,}/g },
  { name: "supabase legacy service jwt", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./g },
  { name: "supabase personal access token", pattern: /sbp_[0-9a-f]{40,}/g },
  { name: "openai api key", pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "qloo-style bare api key header", pattern: /x-api-key\s*[:=]\s*["'][^"']{8,}/gi },
  {
    name: "NEXT_PUBLIC server secret",
    pattern: /NEXT_PUBLIC_[A-Z0-9_]*(SUPABASE|OPENAI|QLOO|SECRET|API_KEY|ACCESS_TOKEN)[A-Z0-9_]*/g,
  },
];

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".sql",
  ".css", ".html", ".txt", ".yml", ".yaml", ".toml", ".example", ".map", "",
]);

function tracked(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\0").filter((entry) => entry.length > 0);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

type Finding = { file: string; rule: string; offset: number };

function scan(files: readonly string[], label: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rule of RULES) {
      for (const match of text.matchAll(rule.pattern)) {
        if (rule.allow?.test(match[0])) continue;
        findings.push({ file: `${label}:${relative(repoRoot, file)}`, rule: rule.name, offset: match.index });
      }
    }
  }
  return findings;
}

const checks: { label: string; ok: boolean; detail: string }[] = [];

const trackedFiles = tracked();
for (const forbidden of [".env", ".vercel"]) {
  const hits = trackedFiles.filter((file) => file === forbidden || file.startsWith(`${forbidden}/`));
  checks.push({
    label: `${forbidden} is untracked`,
    ok: hits.length === 0,
    detail: hits.length === 0 ? "not in git ls-files" : `tracked: ${hits.join(", ")}`,
  });
}

const trackedFindings = scan(
  trackedFiles.map((file) => join(repoRoot, file)),
  "tracked",
);
checks.push({
  label: "tracked files carry no credential shape",
  ok: trackedFindings.length === 0,
  detail: trackedFindings.length === 0 ? `${trackedFiles.length} files scanned` : "see findings",
});

const buildDirs = [join(repoRoot, ".next", "static"), join(repoRoot, ".next", "server")];
const builtFiles = buildDirs.flatMap(walk);
if (builtFiles.length === 0) {
  checks.push({
    label: "built assets scanned",
    ok: false,
    detail: "no .next output found — run `npm run build` first",
  });
} else {
  const buildFindings = scan(builtFiles, "build");
  checks.push({
    label: "built client and server assets carry no credential shape",
    ok: buildFindings.length === 0,
    detail: buildFindings.length === 0 ? `${builtFiles.length} files scanned` : "see findings",
  });
  trackedFindings.push(...buildFindings);
}

for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.label} — ${check.detail}`);
}
for (const finding of trackedFindings) {
  console.log(`FAIL  ${finding.rule} at byte ${finding.offset} of ${finding.file}`);
}

const failed = checks.filter((check) => !check.ok).length + trackedFindings.length;
console.log(failed === 0 ? "\nscan:secrets OK" : `\nscan:secrets FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
