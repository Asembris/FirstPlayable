/**
 * One bounded, opt-in refresh repro against real Qloo and the configured DB.
 * RUN_QLOO_PROVENANCE_SMOKE=1 npx tsx scripts/smoke-qloo-provenance.ts
 * Requires the committed migration to be applied first. Never applies DDL or
 * mutates historical captures. A successful run retains the new evidence row.
 * Refuses before spending Qloo quota when fingerprint uniqueness still exists.
 * Credentials and raw provider/management errors are never printed.
 */
import assert from "node:assert/strict";
import { ConfigError, qlooConfig, qlooEnv, supabaseEnv } from "../src/server/config";
import { QlooCaptureRowSchema, type QlooCaptureRow } from "../src/server/db/gateway";
import { supabaseGateway } from "../src/server/db/supabase-gateway";
import { ArtistSearchSnapshotSchema } from "../src/domain/qloo";
import { artistSearchFingerprint } from "../src/server/qloo/normalize";
import { resolveArtist, QlooError } from "../src/server/qloo/client";
import { CACHE_TTL_SECONDS, readArtistSearchCache, writeArtistSearchCapture } from "../src/server/qloo/cache";
import { assertQlooCallsGranted, databaseLaunchGuard, reserveQlooCalls, reconcileQlooCalls } from "../src/server/qloo/limiter";

let stage = "configuration";
async function run(): Promise<void> {
  assert.equal(process.env["RUN_QLOO_PROVENANCE_SMOKE"], "1", "opt-in guard required");
  for (const file of [".env.local", ".env"]) { try { process.loadEnvFile(file); } catch { /* exported config is sufficient */ } }
  const db = supabaseEnv();
  const env = qlooEnv();
  const config = qlooConfig();
  const token = process.env["SUPABASE_ACCESS_TOKEN"];
  assert.ok(token, "database management credential required for read-only migration preflight");
  const ref = new URL(db.url).hostname.split(".")[0]!;
  async function sql(query: string): Promise<unknown[]> {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 201, `database query status ${response.status}`);
    const data: unknown = await response.json();
    assert.ok(Array.isArray(data), "database query must return rows");
    return data;
  }
  stage = "read-only migration preflight";
  const indexes = await sql(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'qloo_captures'`);
  assert.equal(indexes.some((row) => {
    const definition = (row as { indexdef: string }).indexdef;
    return /create unique index/i.test(definition) && /\(request_fingerprint\)/.test(definition);
  }), false, "refresh migration is not applied; no Qloo request made");
  stage = "read-only expired-capture preflight";
  const candidates = await sql(`select * from public.qloo_captures where kind = 'search'
    and cache_expires_at <= now() and normalized_query is not null order by captured_at desc limit 100`);
  let old: QlooCaptureRow | undefined;
  let query: string | undefined;
  for (const value of candidates) {
    const row = QlooCaptureRowSchema.parse(value);
    const snapshot = ArtistSearchSnapshotSchema.omit({ capture_id: true, cache: true }).safeParse(row.results);
    if (snapshot.success && row.request_fingerprint === artistSearchFingerprint({ host: env.host, normalizedQuery: row.normalized_query! })) {
      old = row; query = snapshot.data.query; break;
    }
  }
  assert.ok(old && query, "no expired artist search with the current request fingerprint available");
  stage = "production cache-miss check";
  const gateway = supabaseGateway();
  const before = await gateway.findQlooCapturesByIds([old.id]);
  assert.equal(before.length, 1);
  assert.equal(await readArtistSearchCache(gateway, old.request_fingerprint, new Date()), null,
    "the selected request must be an expired cache miss");
  console.log(`Expired capture: ${old.id}; captured ${old.captured_at}; expiry ${old.cache_expires_at}`);
  stage = "Qloo quota reservation";
  const reservation = assertQlooCallsGranted(await reserveQlooCalls(gateway, config, { calls: 1 }));
  let calls = 0;
  let snapshot: Awaited<ReturnType<typeof resolveArtist>>["snapshot"];
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(calls, 0, "bounded repro permits exactly one Qloo HTTP request, with no retries");
    calls += 1;
    return fetch(input, init);
  }) as typeof fetch;
  try {
    stage = "bounded Qloo retrieval";
    snapshot = (await resolveArtist(query, { env, fetchImpl: upstream,
      launch: databaseLaunchGuard(gateway, config), sleep: async () => { throw new Error("retry disabled for bounded repro"); },
    })).snapshot;
  } catch (cause) {
    if (cause instanceof QlooError) console.log(`Qloo failed: ${cause.code}`);
    throw new Error("bounded Qloo retrieval failed");
  } finally { await reconcileQlooCalls(gateway, reservation.lease_id, calls); }
  assert.equal(snapshot.request_fingerprint, old.request_fingerprint);
  const expiry = new Date(Date.parse(snapshot.retrieved_at) + 1000 *
    (snapshot.candidates.length ? CACHE_TTL_SECONDS.artistSearch : CACHE_TTL_SECONDS.emptyArtistSearch)).toISOString();
  stage = "append-only persistence and verification";
  const written = await writeArtistSearchCapture(gateway, snapshot, null, new Date(snapshot.retrieved_at));
  assert.ok(written.capture_id);
  const [fresh] = await gateway.findQlooCapturesByIds([written.capture_id]);
  assert.ok(fresh);
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.request_fingerprint, old.request_fingerprint);
  assert.equal(Date.parse(fresh.captured_at), Date.parse(snapshot.retrieved_at));
  assert.equal(Date.parse(fresh.cache_expires_at), Date.parse(expiry));
  assert.deepEqual(fresh.results, snapshot);
  assert.equal((await readArtistSearchCache(gateway, old.request_fingerprint, new Date()))?.capture_id, fresh.id);
  assert.deepEqual(await gateway.findQlooCapturesByIds([old.id]), before);
  console.log(`Fresh capture: ${fresh.id}; captured ${fresh.captured_at}; expiry ${fresh.cache_expires_at}`);
  console.log(`PASS: new ID, exact fresh payload/time/expiry, newest fresh lookup, unchanged production history; Qloo calls ${calls}`);
}

run().catch((cause: unknown) => {
  // Only our own bounded assertion messages are safe; raw errors may contain credentials.
  if (cause instanceof Error && cause.cause && typeof cause.cause === "object" && "code" in cause.cause) console.error(`Transport error code: ${String(cause.cause.code)}`);
  if (cause instanceof ConfigError) console.error(`Missing/invalid configuration: ${cause.variables.join(", ")}`);
  console.error(cause instanceof assert.AssertionError ? `FAIL: ${cause.message.split("\n")[0]}` : `FAIL: repro could not complete at ${stage} (${cause instanceof Error ? cause.name : "unknown"}; provider diagnostics withheld)`);
  process.exitCode = 1;
});
