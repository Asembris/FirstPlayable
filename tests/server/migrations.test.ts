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
      "20261004085412_phase3_qloo.sql",
      "20261004160000_phase4_compilation.sql",
    ]);
  });

  it("never rewrites an earlier migration's tables or columns", () => {
    const phase3 = readFileSync(join(migrationsDir, "20261004085412_phase3_qloo.sql"), "utf8");
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

  /**
   * Phase 4 is additive too, with one deliberate exception: it swaps the
   * `operations.stage` check constraint to admit the `compile` controller
   * stage. A constraint swap adds a permitted value; it rewrites no column, no
   * table, and no earlier function's behaviour.
   */
  it("adds phase 4 without rewriting an earlier migration's schema", () => {
    const phase4 = readFileSync(
      join(migrationsDir, "20261004160000_phase4_compilation.sql"),
      "utf8",
    );
    expect(/drop\s+(table|column|function|trigger|index)/i.test(phase4)).toBe(false);
    expect(/alter\s+column/i.test(phase4)).toBe(false);
    expect(/create\s+table/i.test(phase4)).toBe(false);
    // Only additive column work, and only on the two tables phase 4 extends.
    const touched = [...phase4.matchAll(/alter table public\.([a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(touched)].sort()).toEqual([
      "operations",
      "projects",
      "scene_versions",
    ]);
    for (const statement of phase4.matchAll(/add column([^;]*);/g)) {
      expect(statement[0]).toContain("if not exists");
    }
    // The one constraint it drops, and the value that drop exists to admit.
    const drops = [...phase4.matchAll(/drop constraint ([a-z_]+)/g)].map((m) => m[1]);
    expect(drops).toEqual(["operations_stage_known"]);
    expect(phase4).toContain("'compile'");
  });

  it("makes an unvalidated scene version unrepresentable in the schema", () => {
    expect(sql).toContain("scene_versions_validation_passed");
    const constraint = sql.slice(sql.indexOf("add constraint scene_versions_validation_passed"));
    const body = constraint.slice(0, constraint.indexOf(";"));
    expect(body).toContain("(validation_summary ->> 'ok')::boolean is true");
    expect(body).toContain("validation_summary ? 'subsets'");
    expect(body).toContain("validation_summary ? 'witnesses'");
  });

  it("keeps the pending review pointer separate from the active version", () => {
    expect(sql).toContain("add column if not exists pending_version_id uuid");
    expect(sql).toContain("projects_pending_version_fk");
    // Committing a version sets the pending pointer and never the active one.
    const commit = sql.slice(sql.indexOf("create or replace function public.commit_scene_version("));
    const body = commit.slice(0, commit.indexOf("$func$;"));
    expect(body).toContain("pending_version_id = v_version.id");
    expect(body).toContain("'REVIEW_PLAYABLE'");
    expect(/set[\s\S]*?active_version_id\s*=/.test(body)).toBe(false);
  });

  it("refuses to let a stale compilation result become current", () => {
    for (const fn of ["commit_scene_version", "activate_scene_version"]) {
      const body = sql.slice(sql.indexOf(`create or replace function public.${fn}(`));
      const statement = body.slice(0, body.indexOf("$func$;"));
      expect(statement).toContain("'stale_input'");
      expect(statement).toContain("v_project.revision <> p_expected_revision");
    }
    // Activation reads the frozen values off the version row, never from the
    // request body, so knowing a version id is not enough to activate it.
    const activate = sql.slice(sql.indexOf("create or replace function public.activate_scene_version("));
    const statement = activate.slice(0, activate.indexOf("$func$;"));
    expect(statement).toContain("v_version.input_snapshot");
    expect(statement).toContain("v_version.approval_snapshot");
    expect(statement).toContain("v_project.pending_version_id is distinct from p_version_id");
  });

  it("keeps the model-stage attempt ceiling out of the controller lease", () => {
    const lease = sql.slice(sql.indexOf("create or replace function public.lease_compile_operation("));
    const body = lease.slice(0, lease.indexOf("$func$;"));
    // The controller row is leased once per advance and spends no attempt.
    expect(/attempts\s*=/.test(body)).toBe(false);
    expect(body).toContain("v_operation.stage <> 'compile'");
    // Parking releases a lease without settling, which is how the one
    // permitted repair stays inside the same max_attempts ceiling.
    const park = sql.slice(sql.indexOf("create or replace function public.park_operation("));
    const parkBody = park.slice(0, park.indexOf("$func$;"));
    expect(/attempts\s*=/.test(parkBody)).toBe(false);
    expect(parkBody).toContain("status = 'reserved'");
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
      "activate_scene_version",
      "append_influence_decision",
      "commit_scene_version",
      "complete_operation",
      "confirm_project_anchor",
      "decline_scene_version",
      "lease_compile_operation",
      "operation_summary",
      "park_operation",
      "read_scene_versions",
      "reconcile_model_budget",
      "reject_content_mutation",
      "release_qloo_launch",
      "reserve_model_budget",
      "reserve_operation",
      "reserve_qloo_launch",
      "set_project_compilation_state",
      "set_project_proposal_draft",
      "set_project_references",
    ]);
  });

  it("keeps Qloo launch pacing in its own scope, away from model budgeting", () => {
    const phase3 = readFileSync(join(migrationsDir, "20261004085412_phase3_qloo.sql"), "utf8");
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
      "lease_compile_operation",
      "park_operation",
      "set_project_compilation_state",
      "commit_scene_version",
      "activate_scene_version",
      "decline_scene_version",
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

  it("defines the phase 4 compilation primitives, and nothing else new", () => {
    for (const fn of [
      "public.lease_compile_operation",
      "public.park_operation",
      "public.set_project_compilation_state",
      "public.commit_scene_version",
      "public.activate_scene_version",
      "public.decline_scene_version",
      "public.read_scene_versions",
    ]) {
      expect(sql).toContain(`create or replace function ${fn}(`);
    }
    // No revision, publication, share, token, or export primitive: those are
    // phase 5 and must not exist yet.
    for (const absent of ["publication", "publish", "read_token", "revoke_share", "export_"]) {
      expect(
        new RegExp(`create or replace function public\\.[a-z_0-9]*${absent}`).test(sql),
        `${absent} is not part of phase 4`,
      ).toBe(false);
    }
  });

  it("introduces no phase 3 Qloo call and no model call in SQL", () => {
    expect(/qloo\.com|api\.openai\.com|http:\/\/|https:\/\//i.test(sql)).toBe(false);
  });
});
