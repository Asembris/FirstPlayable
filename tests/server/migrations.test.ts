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
      "20261004173000_phase4_validation_boolean.sql",
      "20261004190000_phase5_revision_share.sql",
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

  /**
   * The validated-version guard, in its hardened form.
   *
   * `20261004160000` wrote it as `(validation_summary ->> 'ok')::boolean is
   * true`, which goes through `text::boolean` and therefore accepted the JSON
   * *string* `"true"`. A live probe found that (`docs/PHASE4_EVIDENCE.md`
   * §12.9) and `20261004173000` replaces it with a jsonb value comparison.
   *
   * This reads the **last** definition in migration order, which is the one
   * the database ends up with, so the test cannot pass on a superseded form.
   */
  it("makes an unvalidated scene version unrepresentable in the schema", () => {
    expect(sql).toContain("scene_versions_validation_passed");
    const marker = "add constraint scene_versions_validation_passed";
    const constraint = sql.slice(sql.lastIndexOf(marker));
    const body = constraint.slice(0, constraint.indexOf(";"));

    // The key's presence is asserted before its type, because a check
    // constraint accepts a NULL expression: without this conjunct a summary
    // with no `ok` key would make `jsonb_typeof` NULL and pass.
    expect(body).toContain("validation_summary ? 'ok'");
    expect(body).toContain("jsonb_typeof(validation_summary -> 'ok') = 'boolean'");
    expect(body).toContain("(validation_summary -> 'ok') = 'true'::jsonb");
    expect(body).toContain("validation_summary ? 'subsets'");
    expect(body).toContain("validation_summary ? 'witnesses'");

    // And no text projection of `ok` survives anywhere in the final form: that
    // is the coercion path the defect came through.
    expect(body).not.toContain("->> 'ok'");
    expect(body).not.toContain("::boolean");
  });

  /**
   * The hardening migration is a constraint replacement and nothing else.
   *
   * Replacing a check constraint needs a drop, which is why it is a separate
   * forward migration rather than an edit to `20261004160000`. It must not
   * take the opportunity to touch anything else.
   */
  it("hardens the validation guard without changing anything else", () => {
    const hardening = readFileSync(
      join(migrationsDir, "20261004173000_phase4_validation_boolean.sql"),
      "utf8",
    );
    expect(/drop\s+(table|column|function|trigger|index|policy)/i.test(hardening)).toBe(false);
    expect(/alter\s+column/i.test(hardening)).toBe(false);
    expect(/create\s+table/i.test(hardening)).toBe(false);
    expect(/create\s+or\s+replace\s+function/i.test(hardening)).toBe(false);
    expect(/add column/i.test(hardening)).toBe(false);
    expect(/^\s*(grant|revoke)/im.test(hardening)).toBe(false);

    // Exactly one table, exactly one constraint dropped, exactly one re-added.
    const touched = [...hardening.matchAll(/alter table public\.([a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(touched)]).toEqual(["scene_versions"]);
    expect(
      [...hardening.matchAll(/drop constraint ([a-z_]+)/g)].map((m) => m[1]),
    ).toEqual(["scene_versions_validation_passed"]);
    expect(
      [...hardening.matchAll(/add constraint ([a-z_]+)/g)].map((m) => m[1]),
    ).toEqual(["scene_versions_validation_passed"]);

    // The earlier migration is untouched and still carries its original form,
    // so the history says what was applied and when it was corrected.
    const phase4 = readFileSync(
      join(migrationsDir, "20261004160000_phase4_compilation.sql"),
      "utf8",
    );
    expect(phase4).toContain("(validation_summary ->> 'ok')::boolean is true");
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
      // Defined twice: phase 4 wrote it, phase 5 replaces it with the
      // revision-diff parameter. Both definitions are history.
      "commit_scene_version",
      "commit_scene_version",
      "complete_operation",
      "confirm_project_anchor",
      "decline_scene_version",
      "lease_compile_operation",
      "operation_summary",
      "park_operation",
      "publish_scene_version",
      "read_publication_by_token",
      "read_publications_for_owner",
      // Likewise: phase 5 replaces the version read so a summary carries its
      // stored diff. Same signature, so this one needs no drop.
      "read_scene_versions",
      "read_scene_versions",
      "reconcile_model_budget",
      "reject_content_mutation",
      "release_qloo_launch",
      "reserve_model_budget",
      "reserve_operation",
      "reserve_qloo_launch",
      "revoke_publication",
      "set_project_compilation_state",
      "set_project_ending_copy_overrides",
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
      "set_project_ending_copy_overrides",
      "publish_scene_version",
      "revoke_publication",
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
  });

  /**
   * Phase 5's own primitives, and the shape of its one deliberate replacement.
   *
   * `commit_scene_version` is dropped and recreated with a `p_revision_diff`
   * parameter, because `scene_versions` refuses `UPDATE` and a diff can
   * therefore only be written by the insert that creates the row. Leaving the
   * nineteen-argument form in place would leave an overload that silently
   * stores no diff, so the old signature goes.
   */
  it("defines the phase 5 revision and publication primitives", () => {
    for (const fn of [
      "public.set_project_ending_copy_overrides",
      "public.publish_scene_version",
      "public.revoke_publication",
      "public.read_publication_by_token",
      "public.read_publications_for_owner",
    ]) {
      expect(sql).toContain(`create or replace function ${fn}(`);
    }
  });

  it("adds phase 5 without creating a table or rewriting a column", () => {
    const phase5 = readFileSync(
      join(migrationsDir, "20261004190000_phase5_revision_share.sql"),
      "utf8",
    );
    expect(/create\s+table/i.test(phase5)).toBe(false);
    expect(/alter\s+column/i.test(phase5)).toBe(false);
    expect(/drop\s+(table|column|trigger|index|policy)/i.test(phase5)).toBe(false);
    expect(/create\s+policy/i.test(phase5)).toBe(false);

    // Only additive column work, and only on the two tables phase 5 extends.
    const touched = [...phase5.matchAll(/alter table public\.([a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(touched)].sort()).toEqual(["operations", "projects"]);
    for (const statement of phase5.matchAll(/add column([^;]*);/g)) {
      expect(statement[0]).toContain("if not exists");
    }

    // Exactly two deliberate removals: the stage check constraint, swapped to
    // admit `revision`, and the superseded commit signature.
    expect(
      [...phase5.matchAll(/drop constraint ([a-z_]+)/g)].map((m) => m[1]),
    ).toEqual(["operations_stage_known"]);
    expect(phase5).toContain("'revision'");
    expect(
      [...phase5.matchAll(/drop function public\.([a-z_0-9]+)\(/g)].map((m) => m[1]),
    ).toEqual(["commit_scene_version"]);
  });

  /**
   * The public read is the one query in the whole schema with no owner
   * predicate, and it must stay the only one. It is keyed by a hashed token
   * that carries no owner authority, and it returns no project id and no
   * sibling publication, so a token cannot be turned into an owner capability.
   */
  it("keeps the public read owner-free, project-free, and revocation-aware", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.read_publication_by_token("),
    );
    const body = fn.slice(0, fn.indexOf("$func$;"));
    expect(body).toContain("where read_token_hash = p_read_token_hash");
    // No owner session parameter exists, so none can be forgotten.
    expect(body.includes("p_owner_session_id")).toBe(false);
    // A revoked link and an unknown one are the same answer.
    expect(body).toContain("v_publication.revoked_at is not null");
    expect(body).toContain("'unavailable'");
    // The result names the snapshot and the date, and nothing else.
    const returned = body.slice(body.lastIndexOf("jsonb_build_object"));
    expect(returned).toContain("public_snapshot");
    expect(returned).toContain("published_at");
    expect(returned.includes("project_id")).toBe(false);
    expect(returned.includes("owner_session_id")).toBe(false);
  });

  it("revokes a publication without deleting anything", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.revoke_publication("));
    const body = fn.slice(0, fn.indexOf("$func$;"));
    expect(body).toContain("set revoked_at = v_now");
    expect(/delete\s+from/i.test(body)).toBe(false);
    expect(body).toContain("already_revoked");
  });

  it("refuses to publish a version that is still awaiting review", () => {
    const fn = sql.slice(
      sql.indexOf("create or replace function public.publish_scene_version("),
    );
    const body = fn.slice(0, fn.indexOf("$func$;"));
    expect(body).toContain("v_project.pending_version_id is not distinct from p_version_id");
    expect(body).toContain("'not_reviewed'");
    // The version must belong to the project naming it.
    expect(body).toContain("where id = p_version_id and project_id = p_project_id");
  });

  it("introduces no phase 3 Qloo call and no model call in SQL", () => {
    expect(/qloo\.com|api\.openai\.com|http:\/\/|https:\/\//i.test(sql)).toBe(false);
  });
});
