import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static checks on the committed SQL. These do not need a database: they
 * assert the *intended access posture* is written down and reproducible, so a
 * later phase cannot quietly add a policy, a ninth table, or a grant to a
 * browser role. The live Supabase smoke command verifies the applied state.
 */

const migrationsDir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const sql = files.map((name) => readFileSync(join(migrationsDir, name), "utf8")).join("\n");

/** The eight tables of specification section 11, and no ninth. */
const EXPECTED_TABLES = [
  "budget_buckets",
  "influence_decisions",
  "operations",
  "projects",
  "publications",
  "qloo_captures",
  "scene_versions",
  "sessions",
] as const;

describe("committed migrations", () => {
  it("are committed in deterministic order", () => {
    expect(files).toEqual([
      "20261003222350_phase2_schema.sql",
      "20261003222456_phase2_atomic_functions.sql",
      "20261004100500_phase3_qloo.sql",
    ]);
  });

  it("never rewrites an earlier migration's tables or columns", () => {
    const phase3 = readFileSync(join(migrationsDir, "20261004100500_phase3_qloo.sql"), "utf8");
    expect(/drop\s+(table|column|function|trigger|index)/i.test(phase3)).toBe(false);
    expect(/alter\s+column/i.test(phase3)).toBe(false);
    expect(/create\s+table/i.test(phase3)).toBe(false);
    // Only additive column work, and only on the two tables phase 3 extends.
    const added = [...phase3.matchAll(/alter table public\.([a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(added)].sort()).toEqual(["budget_buckets", "projects"]);
    for (const statement of phase3.matchAll(/add column([^;]*);/g)) {
      expect(statement[0]).toContain("if not exists");
    }
  });

  it("create exactly the eight intended tables", () => {
    const created = [...sql.matchAll(/create table public\.([a-z_]+)/g)]
      .map((match) => match[1])
      .sort();
    expect(created).toEqual([...EXPECTED_TABLES]);
  });

  it("enable row-level security on every one of them", () => {
    for (const table of EXPECTED_TABLES) {
      expect(
        sql.includes(`alter table public.${table} enable row level security;`),
        `${table} is missing an explicit RLS statement`,
      ).toBe(true);
    }
  });

  it("creates no policy at all, so browser roles stay denied by default", () => {
    expect(/create\s+policy/i.test(sql)).toBe(false);
  });

  it("grants nothing to anon or authenticated", () => {
    const grants = [...sql.matchAll(/^grant[\s\S]*?;/gim)].map((match) => match[0]);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(/\banon\b/.test(grant), `grant reaches anon: ${grant}`).toBe(false);
      expect(/\bauthenticated\b/.test(grant), `grant reaches authenticated: ${grant}`).toBe(false);
      expect(/\bto\s+public\b/i.test(grant), `grant reaches public: ${grant}`).toBe(false);
    }
  });

  it("revokes the browser roles explicitly even though no policy exists", () => {
    expect(sql).toContain("revoke all on all tables in schema public from anon, authenticated;");
    expect(sql).toContain("revoke all on all functions in schema public from anon, authenticated;");
  });

  it("grants table access to the server secret key's role only", () => {
    expect(sql).toContain("grant usage on schema public to service_role;");
    for (const table of EXPECTED_TABLES) {
      expect(sql).toMatch(new RegExp(`public\\.${table}[\\s\\S]{0,400}?to service_role;`));
    }
  });

  it("defines the three atomic primitives phase 2 needs", () => {
    for (const fn of [
      "public.reserve_operation",
      "public.complete_operation",
      "public.append_influence_decision",
      "public.reserve_model_budget",
      "public.reconcile_model_budget",
    ]) {
      expect(sql).toContain(`create or replace function ${fn}(`);
    }
  });

  it("defines the phase 3 launch policy and project writes, and nothing else", () => {
    for (const fn of [
      "public.reserve_qloo_launch",
      "public.release_qloo_launch",
      "public.confirm_project_anchor",
      "public.set_project_references",
      "public.set_project_proposal_draft",
    ]) {
      expect(sql).toContain(`create or replace function ${fn}(`);
    }
    const defined = [...sql.matchAll(/create or replace function public\.([a-z_0-9]+)\(/g)]
      .map((match) => match[1])
      .sort();
    expect(defined).toEqual([
      "append_influence_decision",
      "complete_operation",
      "confirm_project_anchor",
      "operation_summary",
      "reconcile_model_budget",
      "reject_content_mutation",
      "release_qloo_launch",
      "reserve_model_budget",
      "reserve_operation",
      "reserve_qloo_launch",
      "set_project_proposal_draft",
      "set_project_references",
    ]);
  });

  it("keeps Qloo launch pacing in its own scope, away from model budgeting", () => {
    const phase3 = readFileSync(join(migrationsDir, "20261004100500_phase3_qloo.sql"), "utf8");
    // The launch policy writes last_launch_at; the model-budget functions in
    // the phase 2 migration never mention that column, so the two share the
    // table without sharing a row or a counter.
    const phase2 = readFileSync(
      join(migrationsDir, "20261003222456_phase2_atomic_functions.sql"),
      "utf8",
    );
    expect(phase3).toContain("last_launch_at");
    expect(phase2.includes("last_launch_at")).toBe(false);
    // Releasing a launch lease is scoped, so it cannot reclaim a model lease.
    const release = phase3.slice(
      phase3.indexOf("create or replace function public.release_qloo_launch("),
    );
    expect(release.slice(0, release.indexOf("$func$;"))).toContain("where scope = p_scope");
  });

  it("uses no security definer function and no mutable search path", () => {
    expect(/security\s+definer/i.test(sql)).toBe(false);
    const functions = [...sql.matchAll(/create or replace function[\s\S]*?\nas \$func\$/g)];
    expect(functions.length).toBeGreaterThan(5);
    for (const fn of functions) {
      expect(/set search_path = ''/.test(fn[0]), `missing pinned search_path:\n${fn[0]}`).toBe(true);
    }
  });

  it("takes a row lock in every function that enforces a shared limit", () => {
    for (const fn of [
      "reserve_operation",
      "reserve_model_budget",
      "reconcile_model_budget",
      "append_influence_decision",
      "reserve_qloo_launch",
      "release_qloo_launch",
      "confirm_project_anchor",
      "set_project_references",
      "set_project_proposal_draft",
    ]) {
      const body = sql.slice(
        sql.indexOf(`create or replace function public.${fn}(`),
      );
      const end = body.indexOf("$func$;");
      expect(body.slice(0, end)).toContain("for update");
    }
  });

  it("keeps the append-only tables immutable with a trigger", () => {
    for (const table of ["qloo_captures", "influence_decisions", "scene_versions"]) {
      expect(sql).toMatch(
        new RegExp(`before update on public\\.${table}[\\s\\S]{0,200}?reject_content_mutation`),
      );
    }
  });

  it("stores only a hashed owner secret and a hashed read token", () => {
    expect(sql).toContain("owner_secret_hash text not null");
    expect(sql).toContain("read_token_hash text not null");
    expect(/owner_secret\s+text/.test(sql)).toBe(false);
    expect(/read_token\s+text/.test(sql)).toBe(false);
  });

  it("introduces no phase 3 Qloo call and no model call in SQL", () => {
    expect(/qloo\.com|api\.openai\.com|http:\/\/|https:\/\//i.test(sql)).toBe(false);
  });
});
