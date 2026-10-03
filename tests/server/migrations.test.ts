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

describe("phase 2 migrations", () => {
  it("are committed in deterministic order", () => {
    expect(files).toEqual([
      "20261003222350_phase2_schema.sql",
      "20261003222456_phase2_atomic_functions.sql",
    ]);
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

  it("uses no security definer function and no mutable search path", () => {
    expect(/security\s+definer/i.test(sql)).toBe(false);
    const functions = [...sql.matchAll(/create or replace function[\s\S]*?\nas \$func\$/g)];
    expect(functions.length).toBeGreaterThan(5);
    for (const fn of functions) {
      expect(/set search_path = ''/.test(fn[0]), `missing pinned search_path:\n${fn[0]}`).toBe(true);
    }
  });

  it("takes a row lock in every function that enforces a shared limit", () => {
    for (const fn of ["reserve_operation", "reserve_model_budget", "reconcile_model_budget", "append_influence_decision"]) {
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
