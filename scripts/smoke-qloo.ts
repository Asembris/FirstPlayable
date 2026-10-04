/**
 * The one explicit, opt-in real Qloo retrieval smoke run.
 *
 *   RUN_QLOO_SMOKE=1 npm run smoke:qloo
 *
 * It is never part of `npm test`, never part of `npm run build`, never part of
 * CI, and never runs during deployment. Without the guard it exits with
 * instructions and makes no request at all.
 *
 * What it establishes, against the real API and the real database:
 *
 *   * the three frozen request shapes work;
 *   * the artist must be confirmed by name, not taken from position 1;
 *   * both first hops normalize into usable evidence with real field paths;
 *   * the returned subtype matches the requested domain;
 *   * the global launch policy spaced the launches;
 *   * repeating the identical retrieval makes **zero** upstream calls;
 *   * the exact call count, and the quota the API reported.
 *
 * It prints the key never, the request URLs without their headers, and the
 * evidence excerpts truncated. Every number below is observed, not assumed.
 */

import {
  DISPLAYED_USABLE_PER_DOMAIN,
  QLOO_DOMAIN_FILTER_TYPE,
  QLOO_DOMAINS,
  QLOO_NORMALIZER_VERSION,
  type QuotaDiagnostics,
} from "../src/domain/qloo";
import { ConfigError, qlooConfig, qlooEnv } from "../src/server/config";
import { supabaseGateway } from "../src/server/db/supabase-gateway";
import {
  frozenRequestShapes,
  MAX_ATTEMPTS_PER_CALL,
  QlooError,
  resolveArtist,
} from "../src/server/qloo/client";
import { readArtistSearchCache, writeArtistSearchCapture } from "../src/server/qloo/cache";
import {
  assertQlooCallsGranted,
  databaseLaunchGuard,
  qlooCallLimit,
  reconcileQlooCalls,
  reserveQlooCalls,
} from "../src/server/qloo/limiter";
import { artistSearchFingerprint, normalizeQuery } from "../src/server/qloo/normalize";
import {
  EXPECTED_FRESH_CALL_COUNT,
  retrieveReferences,
  type DomainOutcome,
} from "../src/server/qloo/references";
import { selectEligibleReferences } from "../src/server/influence/payload";

const GUARD = "RUN_QLOO_SMOKE";

/**
 * The canonical artist. Confirmed by exact name, never by position.
 *
 * `QLOO_SMOKE_ARTIST` overrides it, so the same script can check a second
 * artist without a second script. The historical-observation comparison below
 * is reported only for the canonical one, because it is only about Radiohead.
 */
const CANONICAL_QUERY = (process.env["QLOO_SMOKE_ARTIST"] ?? "Radiohead").trim();
const IS_CANONICAL = CANONICAL_QUERY.toLowerCase() === "radiohead";

/** Historically observed in the supplied reports. Reported, never required. */
const HISTORICAL = {
  movie: ["Children of Men", "Being John Malkovich", "Moon"],
  videogame: ["Mass Effect 2", "Dragon Age: Origins", "Mass Effect"],
} as const;

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

function note(line: string): void {
  console.log(`      ${line}`);
}

function excerpt(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Already-exported variables are fine; a missing .env is reported below.
  }
}

/** Counts every outbound request, so the call count is measured, not assumed. */
function countingFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return globalThis.fetch(input as RequestInfo, init);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function describeQuota(quota: QuotaDiagnostics | null): void {
  if (quota === null) {
    note("quota headers: none returned on this call");
    return;
  }
  note(
    `quota headers: month limit ${quota.month_limit ?? "—"}, remaining ${
      quota.month_remaining ?? "—"
    }, per-second limit ${quota.second_limit ?? "—"}`,
  );
  if (quota.month_reset_seconds !== null) {
    const days = (quota.month_reset_seconds / 86_400).toFixed(1);
    note(`window reset reported in ${quota.month_reset_seconds} s (~${days} days)`);
  }
}

async function main(): Promise<number> {
  if (process.env[GUARD] !== "1") {
    console.log(
      [
        "smoke:qloo did not run, and made no request.",
        "",
        "This command spends real Qloo calls against the hackathon allowance,",
        "so it is opt-in:",
        "",
        `  ${GUARD}=1 npm run smoke:qloo`,
        "",
        "A normal uncached run costs three calls: one search and two first hops.",
        "Do not loop it.",
      ].join("\n"),
    );
    return 0;
  }

  loadEnvFile();

  let env;
  let config;
  try {
    env = qlooEnv();
    config = qlooConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`smoke:qloo FAILED — ${error.message}`);
      console.error("Set QLOO_API_KEY and QLOO_API_BASE_URL in .env. No value is printed.");
      return 1;
    }
    throw error;
  }

  console.log("smoke:qloo");
  console.log(`  host              ${env.host}`);
  console.log(`  artist query      ${CANONICAL_QUERY}${IS_CANONICAL ? " (canonical)" : ""}`);
  console.log(`  normalizer        ${QLOO_NORMALIZER_VERSION}`);
  console.log(`  launch policy     >= ${config.launchSpacingMs} ms apart, <= ${config.maxActiveLeases} in flight`);
  console.log(`  retry ceiling     ${MAX_ATTEMPTS_PER_CALL} attempts per operation`);
  console.log(`  local allowance   ${qlooCallLimit(config)} calls per window, ${config.judgingReserveCalls} held for judging`);
  console.log("");
  console.log("  frozen request shapes:");
  for (const [name, shape] of Object.entries(frozenRequestShapes(env.baseUrl))) {
    console.log(`    ${name}: ${shape}`);
  }
  console.log("");

  const gateway = supabaseGateway();
  const now = new Date();

  // -------------------------------------------------------------------------
  // 1. Artist search, and an explicit confirmation by name
  // -------------------------------------------------------------------------

  const normalizedQuery = normalizeQuery(CANONICAL_QUERY);
  const searchKey = artistSearchFingerprint({ host: env.host, normalizedQuery });

  const searchCounter = countingFetch();
  let snapshot = await readArtistSearchCache(gateway, searchKey, now);
  if (snapshot === null) {
    // Reserved and reconciled exactly as the route does, so the quota counter
    // this run leaves behind matches what the application would have recorded.
    const reservation = assertQlooCallsGranted(
      await reserveQlooCalls(gateway, config, { calls: MAX_ATTEMPTS_PER_CALL, now }),
    );
    let spent = 0;
    try {
      const result = await resolveArtist(CANONICAL_QUERY, {
        env,
        fetchImpl: searchCounter.fetchImpl,
        launch: databaseLaunchGuard(gateway, config),
      });
      spent = result.diagnostics.attempts;
      describeQuota(result.diagnostics.quota);
      note(`search attempts: ${result.diagnostics.attempts}, ${result.diagnostics.elapsed_ms} ms`);
      snapshot = await writeArtistSearchCapture(
        gateway,
        result.snapshot,
        result.diagnostics.quota,
        now,
      );
    } catch (cause) {
      if (cause instanceof QlooError) spent = cause.attempts;
      throw cause;
    } finally {
      await reconcileQlooCalls(gateway, reservation.lease_id, spent);
    }
  } else {
    note("artist search answered from an existing capture");
  }

  check(
    `artist search for "${CANONICAL_QUERY}" returned candidates`,
    snapshot.candidates.length > 0,
    `${snapshot.candidates.length} candidates, cache ${snapshot.cache}`,
  );
  for (const candidate of snapshot.candidates) {
    note(
      `rank ${candidate.original_rank}: ${candidate.name} (${candidate.entity_id})` +
        (candidate.identity_hints.length > 0
          ? ` · listed on ${candidate.identity_hints.join(", ")}`
          : ""),
    );
  }

  // Confirmed by an exact name match. This script does not take position 1,
  // and it fails rather than substituting a near match.
  const confirmed = snapshot.candidates.find(
    (candidate) => candidate.name.toLowerCase() === CANONICAL_QUERY.toLowerCase(),
  );
  check(
    "the canonical artist is confirmable by exact name, not by position",
    confirmed !== undefined,
    confirmed === undefined
      ? "no returned candidate matched the name exactly"
      : `${confirmed.name} at rank ${confirmed.original_rank}`,
  );
  if (confirmed === undefined) return finish();

  console.log("");
  console.log(`  confirmed artist  ${confirmed.name}`);
  console.log(`  confirmed uuid    ${confirmed.entity_id}`);
  console.log("");

  // -------------------------------------------------------------------------
  // 2. The two first hops
  // -------------------------------------------------------------------------

  const firstCounter = countingFetch();
  const launches: string[] = [];
  const first = await retrieveReferences({
    gateway,
    config,
    env,
    artistEntityId: confirmed.entity_id,
    acceptStale: false,
    now: new Date(),
    fetchImpl: firstCounter.fetchImpl,
    launch: wrapGuard(databaseLaunchGuard(gateway, config), launches),
  });

  note(`first-hop upstream attempts: ${first.upstream_calls}`);
  note(`launch leases taken: ${launches.join(", ") || "none"}`);
  describeQuota(first.quota);
  check(
    "the judging reserve was not reached",
    !first.reserve_reached,
    first.reserve_reached ? "the returned allowance is down to the reserve" : "",
  );

  for (const domain of QLOO_DOMAINS) {
    reportDomain(domain, first.outcomes[domain]);
  }

  const eligible = selectEligibleReferences(
    QLOO_DOMAINS.map((domain) => first.outcomes[domain])
      .filter((outcome): outcome is Extract<DomainOutcome, { status: "ready" }> =>
        outcome.status === "ready",
      )
      .map((outcome) => outcome.capture),
  );
  check(
    "at least one usable reference is eligible for interpretation",
    eligible.length > 0,
    `${eligible.length} eligible`,
  );

  const totalCalls = searchCounter.urls.length + firstCounter.urls.length;
  console.log("");
  note(`upstream calls this run: ${totalCalls}`);
  note(
    `a fully uncached run costs ${EXPECTED_FRESH_CALL_COUNT}: one search and two first hops`,
  );
  for (const url of [...searchCounter.urls, ...firstCounter.urls]) {
    // The URL only. The X-Api-Key header is never printed.
    note(`  → ${url.replace(env.baseUrl, "{base}")}`);
  }
  console.log("");

  // -------------------------------------------------------------------------
  // 3. Cache reuse: the identical retrieval must cost nothing
  // -------------------------------------------------------------------------

  const repeatCounter = countingFetch();
  const repeatLaunches: string[] = [];
  const repeat = await retrieveReferences({
    gateway,
    config,
    env,
    artistEntityId: confirmed.entity_id,
    acceptStale: false,
    now: new Date(),
    fetchImpl: repeatCounter.fetchImpl,
    launch: wrapGuard(databaseLaunchGuard(gateway, config), repeatLaunches),
  });

  check(
    "repeating the identical retrieval made zero upstream calls",
    repeatCounter.urls.length === 0 && repeat.upstream_calls === 0,
    `${repeatCounter.urls.length} requests, ${repeat.upstream_calls} attempts`,
  );
  check(
    "and took no launch lease, because nothing was launched",
    repeatLaunches.length === 0,
    repeatLaunches.join(", "),
  );
  for (const domain of QLOO_DOMAINS) {
    const outcome = repeat.outcomes[domain];
    check(
      `the repeated ${domain} row came from a stored capture`,
      outcome.status === "ready" && outcome.capture.cache === "cached",
      outcome.status === "ready" ? outcome.capture.cache : outcome.code,
    );
  }
  for (const domain of QLOO_DOMAINS) {
    const before = first.outcomes[domain];
    const after = repeat.outcomes[domain];
    if (before.status !== "ready" || after.status !== "ready") continue;
    check(
      `the repeated ${domain} capture is the same immutable row`,
      before.capture.capture_id === after.capture.capture_id,
      `${before.capture.capture_id} vs ${after.capture.capture_id}`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Nothing secret was printed
  // -------------------------------------------------------------------------

  check(
    "the API key never appeared in this output",
    !capturedOutput.includes(env.apiKey),
    "",
  );

  return finish();
}

/**
 * Records every line this script prints, so "the key never appeared in this
 * output" is a measured claim about the actual bytes rather than a promise.
 */
const printedLines: string[] = [];
const printOriginal = console.log.bind(console);
console.log = (...args: unknown[]): void => {
  printedLines.push(args.map((value) => String(value)).join(" "));
  printOriginal(...args);
};

const capturedOutput = {
  includes: (value: string): boolean =>
    printedLines.some((line) => line.includes(value)),
};

function wrapGuard(
  guard: ReturnType<typeof databaseLaunchGuard>,
  labels: string[],
): ReturnType<typeof databaseLaunchGuard> {
  return {
    acquire: async (label: string) => {
      const lease = await guard.acquire(label);
      labels.push(label);
      return lease;
    },
  };
}

function reportDomain(domain: "movie" | "videogame", outcome: DomainOutcome): void {
  console.log("");
  console.log(`  ${domain} (${QLOO_DOMAIN_FILTER_TYPE[domain]})`);
  if (outcome.status !== "ready") {
    check(`${domain} first hop succeeded`, false, outcome.code);
    return;
  }

  const capture = outcome.capture;
  check(`${domain} first hop succeeded`, true, `cache ${capture.cache}`);
  check(
    `${domain} capture is keyed to the confirmed artist`,
    capture.artist_entity_id === capture.artist_entity_id.toUpperCase(),
    capture.artist_entity_id,
  );
  check(
    `${domain} normalized to the requested domain`,
    capture.candidates.every((candidate) => candidate.domain === domain),
    `${capture.candidates.length} rows`,
  );
  note(
    `returned ${capture.candidates.length}, usable ${
      capture.candidates.filter((candidate) => candidate.usable).length
    }, duplicates dropped ${capture.duplicates_dropped}, malformed rows ${capture.malformed_rows}`,
  );
  note(`parameter echo available: ${capture.echo_available ? "yes" : "no (recorded as absent)"}`);

  const usable = capture.candidates.filter((candidate) => candidate.usable);
  const displayed = usable.slice(0, DISPLAYED_USABLE_PER_DOMAIN);
  check(
    `${domain} has at least one usable reference`,
    usable.length > 0,
    `${usable.length} of ${capture.candidates.length}`,
  );

  for (const candidate of displayed) {
    note(
      `rank ${candidate.original_rank}: ${candidate.name}` +
        ` (${candidate.year ?? "year not returned"}) ${candidate.entity_id}`,
    );
    note(`  application id: ${candidate.reference_id}`);
    for (const item of candidate.evidence) {
      note(`  ${item.id} ← ${item.field_path} [${item.kind}] ${item.text.length} chars`);
      note(`     ${excerpt(item.text)}`);
    }
    if (candidate.missing_fields.length > 0) {
      note(`  fields not returned: ${candidate.missing_fields.join(", ")}`);
    }
  }

  const unusable = capture.candidates.filter((candidate) => !candidate.usable);
  for (const candidate of unusable) {
    note(
      `rank ${candidate.original_rank}: ${candidate.name} — unusable (${candidate.unusable_reason})`,
    );
  }

  if (!IS_CANONICAL) return;
  const observed = displayed.map((candidate) => candidate.name);
  const historical = HISTORICAL[domain];
  const matches = observed.filter((name) => (historical as readonly string[]).includes(name));
  note(
    `historically observed first three: ${historical.join(", ")} — ${matches.length} of ${
      historical.length
    } still present`,
  );
}

function finish(): number {
  console.log("");
  console.log(failures === 0 ? "smoke:qloo OK" : `smoke:qloo FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof QlooError) {
      console.error(`smoke:qloo FAILED — ${error.code}`);
      console.error(`  attempts spent: ${error.attempts}`);
    } else {
      console.error(`smoke:qloo FAILED — ${error instanceof Error ? error.name : "unknown"}`);
      if (error instanceof Error) console.error(`  ${error.message}`);
    }
    process.exitCode = 1;
  },
);
