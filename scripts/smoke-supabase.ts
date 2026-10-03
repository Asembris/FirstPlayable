/**
 * The explicit, opt-in live Supabase smoke run.
 *
 *   RUN_SUPABASE_SMOKE=1 npm run smoke:supabase
 *
 * It is never part of `npm test` or `npm run build`: the offline unit suite
 * exercises the same repositories against an in-memory gateway, and this
 * command is what proves the real database agrees — including the parts a
 * single-threaded fake cannot prove, namely that `select ... for update`
 * really serialises concurrent reservations across connections.
 *
 * It goes through the application's own repository boundary, not through raw
 * SQL, so what it verifies is the code paths the deployed routes use. Every
 * row it creates is deleted at the end.
 *
 * It never prints a credential, a session secret, or a stored hash.
 */

import { budgetConfig, ConfigError, supabaseEnv } from "../src/server/config";
import {
  assertGranted,
  MODEL_BUDGET_SCOPE,
  reconcileModelCall,
  releaseModelCall,
  reserveModelCall,
} from "../src/server/db/budgets";
import type { DataGateway, SessionRow } from "../src/server/db/gateway";
import {
  reserveStage,
  settleStage,
  type StageIdentity,
} from "../src/server/db/operations";
import { createProject, readProjectForOwner, toProjectView } from "../src/server/db/projects";
import {
  deleteOwnerSession,
  establishOwnerSession,
  resolveOwnerSession,
} from "../src/server/db/sessions";
import { supabaseGateway } from "../src/server/db/supabase-gateway";
import { SECOND_COPY_BRIEF } from "../fixtures/second-copy";

const GUARD = "RUN_SUPABASE_SMOKE";
/** A scope used by nothing else, so cleanup cannot touch real counters. */
const SMOKE_BUDGET_KEY = "smoke-live";

type Check = { label: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(label: string, ok: boolean, detail: string): void {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Already-exported variables are fine; a missing one is reported below.
  }
}

async function run(): Promise<number> {
  loadEnvFile();

  try {
    const env = supabaseEnv();
    console.log("smoke:supabase");
    console.log(`  project host      ${new URL(env.url).hostname}`);
    console.log("  credential        server secret key (never printed)");
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`smoke:supabase FAILED — ${error.message}`);
      return 1;
    }
    throw error;
  }

  const limits = budgetConfig();
  console.log(`  configured cap    ${limits.modelDailyCallCap} model calls per UTC day`);
  console.log("");

  const gateway = supabaseGateway();
  let ownerA: SessionRow | null = null;
  let ownerB: SessionRow | null = null;
  const leases: string[] = [];

  try {
    // ---------------------------------------------------------------------
    // Sessions.
    // ---------------------------------------------------------------------
    const established = await establishOwnerSession(gateway);
    ownerA = established.session;
    record(
      "owner session created",
      true,
      `expires ${established.session.expires_at.slice(0, 10)}, stored as a sha256 hash`,
    );

    const resumed = await resolveOwnerSession(gateway, established.secret);
    record(
      "owner session resumes from its secret",
      resumed?.id === established.session.id,
      resumed === null ? "did not resolve" : "same session id",
    );

    const forgedSecret = `${"z".repeat(43)}`;
    const forged = await resolveOwnerSession(gateway, forgedSecret);
    record("a forged cookie resolves to nothing", forged === null, "null");

    const secondOwner = await establishOwnerSession(gateway);
    ownerB = secondOwner.session;
    record("a second independent owner session exists", ownerB.id !== ownerA.id, "distinct ids");

    // ---------------------------------------------------------------------
    // Projects.
    // ---------------------------------------------------------------------
    const project = await createProject(
      gateway,
      ownerA,
      { brief: SECOND_COPY_BRIEF },
      { projectsPerDay: limits.projectsPerSessionPerDay },
    );
    record("project created", true, `revision ${project.revision}, state ${project.workflow_state}`);

    const readBack = await readProjectForOwner(gateway, ownerA, project.id);
    const view = readBack === null ? null : toProjectView(readBack);
    record(
      "owner reads its own project back",
      view !== null && view.brief.premise === SECOND_COPY_BRIEF.premise,
      view === null ? "not found" : `brief premise matches, title "${view.title}"`,
    );

    const foreign = await readProjectForOwner(gateway, ownerB, project.id);
    record("a second owner cannot read it", foreign === null, "null, same as a nonexistent id");

    const absent = await readProjectForOwner(
      gateway,
      ownerB,
      "00000000-0000-4000-8000-000000000000",
    );
    record(
      "foreign and nonexistent are indistinguishable",
      foreign === absent,
      "both null",
    );

    // A genuinely fresh client and connection over the same database. This is
    // what a new serverless instance or a redeployment does.
    const freshGateway: DataGateway = supabaseGateway();
    const fromFresh = await readProjectForOwner(freshGateway, ownerA, project.id);
    record(
      "persistence survives a fresh client instance",
      fromFresh?.id === project.id,
      fromFresh === null ? "not found" : "same row from a new connection",
    );

    // ---------------------------------------------------------------------
    // Operation idempotency.
    // ---------------------------------------------------------------------
    const identity: StageIdentity = {
      projectId: project.id,
      stage: "smoke",
      inputRevision: project.revision,
      inputHash: "0".repeat(64),
    };

    const sessionA = ownerA;
    const parallel = await Promise.all(
      Array.from({ length: 8 }, () => reserveStage(gateway, sessionA, identity)),
    );
    const reserved = parallel.filter((outcome) => outcome.outcome === "reserved");
    const distinctOperations = new Set(
      parallel.flatMap((outcome) =>
        outcome.outcome === "not_found" ? [] : [outcome.operation.id],
      ),
    );
    record(
      "eight parallel reservations of one stage",
      reserved.length === 1 && distinctOperations.size === 1,
      `${reserved.length} reserved, ${distinctOperations.size} operation row(s), outcomes: ${parallel
        .map((outcome) => outcome.outcome)
        .join("/")}`,
    );

    const first = reserved[0];
    if (first !== undefined && first.outcome === "reserved") {
      const settled = await settleStage(gateway, ownerA, first.operation.id, {
        status: "succeeded",
        result: { smoke: true },
      });
      record(
        "the stage settles once",
        settled.outcome === "settled",
        `outcome ${settled.outcome}`,
      );

      const replay = await reserveStage(gateway, ownerA, identity);
      record(
        "a replay returns the committed result with no new attempt",
        replay.outcome === "settled" &&
          replay.operation.attempts === 1 &&
          JSON.stringify(replay.operation.result) === JSON.stringify({ smoke: true }),
        replay.outcome === "settled"
          ? `attempts ${replay.operation.attempts}, result replayed`
          : `outcome ${replay.outcome}`,
      );

      const intruder = await reserveStage(gateway, ownerB, identity);
      record(
        "a second owner cannot reserve on that project",
        intruder.outcome === "not_found",
        `outcome ${intruder.outcome}`,
      );
    }

    // ---------------------------------------------------------------------
    // Atomic budget reservation, including genuine concurrency.
    // ---------------------------------------------------------------------
    const smokeCap = { ...limits, modelDailyCallCap: 3, modelLeaseSeconds: 30 };

    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveModelCall(gateway, smokeCap, { bucketKey: SMOKE_BUDGET_KEY }),
      ),
    );
    const granted = burst.filter((outcome) => outcome.granted);
    for (const outcome of granted) {
      if (outcome.granted) leases.push(outcome.lease_id);
    }
    record(
      "twelve concurrent reservations against a cap of three",
      granted.length === 3,
      `${granted.length} granted, ${burst.length - granted.length} refused with budget_exhausted`,
    );

    const refused = burst.find((outcome) => !outcome.granted);
    record(
      "exhaustion is explicit, not silent",
      refused !== undefined && !refused.granted && refused.reason === "budget_exhausted",
      refused === undefined || refused.granted ? "no refusal seen" : refused.reason,
    );

    const reconciled =
      leases[0] === undefined
        ? null
        : await reconcileModelCall(gateway, leases[0], { tokens: 52 });
    record(
      "reconciliation records the reported usage",
      reconciled !== null && reconciled.applied && reconciled.used_calls === 1,
      reconciled === null || !reconciled.applied
        ? "not applied"
        : `used ${reconciled.used_calls} call(s), ${reconciled.used_tokens} token(s)`,
    );

    const doubleReconcile =
      leases[0] === undefined
        ? null
        : await reconcileModelCall(gateway, leases[0], { tokens: 52 });
    record(
      "reconciling the same lease twice is a no-op",
      doubleReconcile !== null && !doubleReconcile.applied,
      doubleReconcile === null ? "skipped" : `applied ${String(doubleReconcile.applied)}`,
    );

    const released = leases[1] === undefined ? null : await releaseModelCall(gateway, leases[1]);
    record(
      "releasing an unsent call returns the capacity",
      released !== null && released.applied && released.used_calls === 1,
      released === null || !released.applied
        ? "not applied"
        : `used stays ${released.used_calls}, reserved ${released.reserved_calls}`,
    );

    const afterRelease = await reserveModelCall(gateway, smokeCap, {
      bucketKey: SMOKE_BUDGET_KEY,
    });
    if (afterRelease.granted) leases.push(afterRelease.lease_id);
    record(
      "the released capacity is genuinely reusable",
      afterRelease.granted,
      afterRelease.granted
        ? `granted, ${afterRelease.remaining_calls} remaining`
        : "still refused",
    );

    let assertGrantedThrew = false;
    try {
      assertGranted(
        await reserveModelCall(gateway, { ...smokeCap, modelDailyCallCap: 0 }, {
          bucketKey: SMOKE_BUDGET_KEY,
        }),
      );
    } catch {
      assertGrantedThrew = true;
    }
    record(
      "a zero cap refuses every call",
      assertGrantedThrew,
      "exhausted-budget error raised",
    );
  } catch (error) {
    record(
      "smoke run completed without an unexpected error",
      false,
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    );
  } finally {
    // ---------------------------------------------------------------------
    // Cleanup. Deleting the sessions cascades to their projects and operations.
    // ---------------------------------------------------------------------
    for (const lease of leases) {
      try {
        await releaseModelCall(gateway, lease);
      } catch {
        // Already reconciled or swept.
      }
    }
    try {
      await gateway.deleteBudgetBucket(MODEL_BUDGET_SCOPE, SMOKE_BUDGET_KEY);
    } catch {
      console.log("  note  the smoke budget bucket could not be removed");
    }
    for (const session of [ownerA, ownerB]) {
      if (session === null) continue;
      try {
        await deleteOwnerSession(gateway, session);
      } catch {
        console.log("  note  a smoke session could not be removed");
      }
    }
    console.log("  cleanup           smoke sessions, projects, operations, and bucket removed");
  }

  const failed = checks.filter((check) => !check.ok).length;
  console.log("");
  console.log(
    failed === 0
      ? `smoke:supabase OK — ${checks.length} checks passed`
      : `smoke:supabase FAILED — ${failed} of ${checks.length} checks failed`,
  );
  return failed === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.env[GUARD] !== "1") {
    console.log(
      [
        "smoke:supabase did not run, and contacted nothing.",
        "",
        "This command writes to the real Supabase project, so it is opt-in:",
        "",
        `  ${GUARD}=1 npm run smoke:supabase`,
        "",
        "It creates two throwaway owner sessions and deletes them at the end.",
      ].join("\n"),
    );
    process.exitCode = 0;
    return;
  }
  // `process.exitCode` rather than `process.exit`, so the client's sockets
  // close before the process does.
  process.exitCode = await run();
}

void main();
