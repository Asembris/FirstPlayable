# FirstPlayable — deployment preflight record

**Date:** 3 October 2026 (UTC)
**Branch:** `feat/phase-2-persistence`
**Commit the deployed production build was made from:** `86aaf69`
**Commit at which the final gate and the deployed verification were re-run:** `86aaf69`
**Runtime used:** Node `v24.11.0`, npm `11.6.1`

The header above belongs to the original Phase 2 record, which is sections 1
to 11. This file is append-only across phases: section 12 was added by the
Phase 4 migration and environment work, and section 13 by the Phase 4
deployment, each dated in its own opening line. Nothing in sections 1 to 11
has been rewritten.

This file records **only what was actually executed against real accounts**.
Nothing below is inferred from the specification, from provider documentation,
or from a mocked test. Where something was not verified, it says so.

No credential appears in this file: no API key, no access token, no database
password, no cookie value, and no secret-key suffix. The Supabase project
reference and the public deployment URL are not credentials and are recorded.

---

## 1. External accounts and what was confirmed

| Service | Confirmed | How |
|---|---|---|
| Supabase project `vggqtyxtdqvdawwpyzea` | exists, healthy, reachable | migrations applied and read back; live smoke run |
| Supabase Data API | enabled; `service_role` reaches the eight tables | `npm run smoke:supabase` performs real reads and writes through it |
| Supabase automatic table exposure | disabled, as the user configured | the migration's explicit `grant … to service_role` is what makes access work; `supabase/config.toml` pins `auto_expose_new_tables = false` |
| Vercel account `asembris`, team `mohamed-aziz-ayaris-projects` | authenticated | `vercel whoami` |
| Vercel project `firstplayable` | created and linked | `vercel link --yes --project firstplayable` |
| OpenAI account | has credit and access to the pinned snapshot | one real Structured Outputs call succeeded |

**Not confirmed, and not claimed:** the Qloo key's validity or terms (phase 3),
the OpenAI account's own rate-limit tier, the remaining prepaid balance, and
any promise of permanent uptime for the free Supabase plan (it may pause after
a week of inactivity, which is exactly why `/example` is static).

---

## 2. Supabase link and migrations

**Linked:** yes.

```
vercel/supabase CLI 2.119.0
supabase link --project-ref vggqtyxtdqvdawwpyzea   →  linked
```

**Migrations applied to the real project:** yes.

| Version | File | Applied |
|---|---|---|
| `20261003222350` | `supabase/migrations/20261003222350_phase2_schema.sql` | yes |
| `20261003222456` | `supabase/migrations/20261003222456_phase2_atomic_functions.sql` | yes |

Both rows are present in `supabase_migrations.schema_migrations`, and the local
filenames were renamed to match the recorded versions so the committed
migrations and the remote history agree. A future `supabase db push` therefore
sees them as already applied.

### How they were applied, and why not with `supabase db push`

`supabase db push` could **not** be used from this machine. Two independent
blockers, both diagnosed rather than worked around:

1. The direct database host `db.<ref>.supabase.co` resolves to IPv6 only, and
   this network has no IPv6 route. The CLI reports
   `DbConfigIpv6Error: IPv6 is not supported on your current network` and
   suggests re-linking to obtain an IPv4 connection.
2. Re-linking cannot obtain one, because the scoped `SUPABASE_ACCESS_TOKEN`
   lacks the permission needed to read the pooler configuration. The management
   API returns, verbatim:

   ```
   GET /v1/projects/vggqtyxtdqvdawwpyzea/config/database/pooler  →  403
   {"message":"Missing required permission(s): database_pooling_config_read",
    "error":{"missing_permissions":["database_pooling_config_read"]}}
   ```

   `GET /v1/projects` is also refused, with `missing_permissions: ["projects_read"]`.
   `supabase link` itself succeeded, so the token is sufficient to link but not
   to discover an IPv4 pooler endpoint.

**No permission was broadened and no Full Access token was requested.** The
database password was never requested, never entered, and never stored. The two
committed migration files were instead applied verbatim through the
already-authorised Supabase management connection available in this session,
which needs neither the database password nor the pooler. The applied schema was
then verified by querying the live catalog (section 3).

**Consequence for a future session:** to use `supabase db push` from this
machine, either the access token needs `database_pooling_config_read` (and
`projects_read` for `migration list`), or the network needs IPv6. Neither is
required for the application to run.

---

## 3. Applied schema, verified against the live catalog

All eight tables of specification section 11 exist, each with row-level
security enabled, **zero policies**, and grants to `service_role` only.

| Table | RLS enabled | Policies | Table grantees |
|---|---|---|---|
| `sessions` | yes | 0 | `postgres`, `service_role` |
| `projects` | yes | 0 | `postgres`, `service_role` |
| `qloo_captures` | yes | 0 | `postgres`, `service_role` |
| `influence_decisions` | yes | 0 | `postgres`, `service_role` |
| `scene_versions` | yes | 0 | `postgres`, `service_role` |
| `publications` | yes | 0 | `postgres`, `service_role` |
| `operations` | yes | 0 | `postgres`, `service_role` |
| `budget_buckets` | yes | 0 | `postgres`, `service_role` |

`anon` and `authenticated` hold **no** grant on any of them, and no policy
exists that could give them one. There is no ninth application table.

Functions, verified the same way:

| Function | `security definer` | `search_path` | Executable by |
|---|---|---|---|
| `reserve_operation` | no | pinned to `''` | `service_role` |
| `complete_operation` | no | pinned to `''` | `service_role` |
| `operation_summary` | no | pinned to `''` | `service_role` |
| `append_influence_decision` | no | pinned to `''` | `service_role` |
| `reserve_model_budget` | no | pinned to `''` | `service_role` |
| `reconcile_model_budget` | no | pinned to `''` | `service_role` |
| `reject_content_mutation` (trigger) | no | pinned to `''` | `postgres` only |

`rls_auto_enable` also appears in the catalog. It is **Supabase's own** event
trigger from the project's "automatic RLS" setting, not an application object,
and it was not modified.

**RLS is not the ownership boundary.** The secret key's role bypasses it. Every
project read in `src/server/db/` therefore carries an owner session id, and the
`DataGateway` interface offers no project read without one — asserted by
`tests/server/ownership.test.ts`.

---

## 4. Live Supabase smoke

```
RUN_SUPABASE_SMOKE=1 npm run smoke:supabase   →  exit 0, 20 of 20 checks passed
```

Every check ran against the real project through the application's own
repository boundary, not through raw SQL.

| Check | Observed |
|---|---|
| owner session created | expiry 60 days out, stored as a SHA-256 hash |
| session resumes from its secret | same session id |
| a forged cookie resolves to nothing | `null` |
| project created | revision 1, state `DRAFT` |
| owner reads its own project back | brief premise matches, title derived server-side |
| a second owner cannot read it | `null` |
| foreign and nonexistent are indistinguishable | both `null` |
| persistence survives a fresh client instance | same row through a new connection |
| **eight parallel reservations of one stage** | **1 reserved, 1 operation row**, the other seven `lease_held` |
| the stage settles once | `settled` |
| a replay of a settled stage | returns the committed result, `attempts` stays 1 |
| a second owner reserving on that project | `not_found` |
| **twelve concurrent reservations against a cap of three** | **exactly 3 granted**, 9 refused `budget_exhausted` |
| exhaustion is explicit | `budget_exhausted`, no fallback |
| reconciliation | 1 call, 52 tokens recorded |
| reconciling the same lease twice | no-op, counters unchanged |
| releasing an unsent call | capacity returned, `used` unchanged |
| the released capacity is reusable | granted |
| a zero cap | refuses every call |

The two concurrency results are the ones a single-threaded fake cannot
establish: they come from `select … for update` inside the committed RPCs,
exercised by genuinely parallel connections. All smoke rows were deleted
afterwards (verified: every table back to zero rows).

---

## 5. Application budget configuration — the narrow phase 2 interpretation

The specification asks for "private admin budget configuration". **Chosen
interpretation: server-only environment configuration, with no admin UI.**
Adding a private write surface would require a second authentication system,
which specification section 18 forbids and which phase 2 is explicitly told not
to build. Nothing about the budget is writable from the browser, and no public
dashboard exists.

| Setting | Default | Where | Lowerable |
|---|---|---|---|
| global model calls per UTC day | **40** | `MODEL_DAILY_CALL_CAP` | yes, never raisable above 40 |
| reservation lease | 120 s | `MODEL_LEASE_SECONDS` | 5–600 s |
| projects per anonymous session per rolling day | 5 | `PROJECTS_PER_SESSION_PER_DAY` | yes, never raisable above 5 |
| provider call timeout | 60 s | `src/server/model/openai.ts` | — |
| operation stage lease | 90 s | `src/server/db/operations.ts` | — |
| attempts per operation stage | 2 | `src/server/db/operations.ts` | — |
| creator command body cap | 16 KiB | `src/server/security/request.ts` | — |

**40/day is this application's own cap, not the OpenAI account's limit.** The
account's verified allowance was not measured, so the specification's rule to
take the *lower* of the two cannot be completed in phase 2; this is recorded as
a limitation in section 11 below. No cap is raised anywhere, there is no
automatic top-up, and there is no paid fallback to another model or provider.

None of these values is deployed to Vercel: no phase 2 deployed route makes a
model call, so the defaults apply and the cap is enforced the moment phase 4
first calls a provider.

---

## 6. OpenAI: pinned model and the real Structured Outputs smoke

**Pinned model:** `gpt-4o-mini-2024-07-18`, enforced in three places — the
configured value must equal it, the request sends it, and a response that
reports a different model is rejected with `MODEL_MISMATCH`. There is no
fallback model and no second provider.

**SDK:** official `openai` 7.27.0, `responses.parse` with
`zodTextFormat(schema, name)` from `openai/helpers/zod`, verified against the
installed package rather than from memory. Constructed with `maxRetries: 0`, so
the application owns the whole retry budget.

```
RUN_OPENAI_SMOKE=1 npm run smoke:openai   →  exit 0
```

| Observation | Value |
|---|---|
| calls made | **2** (see note) |
| model reported by the API | `gpt-4o-mini-2024-07-18` |
| validated output | `{"colour":"red","letters":3}` |
| Zod validated | yes, after the provider's own schema pass |
| input tokens | **72** |
| output tokens | **10** |
| total tokens | **82** |
| elapsed | 2,640 ms on the first call, 1,747 ms on the second |
| cost **estimate** | **$0.0000168 per call**, so **$0.0000336 for both** |

The cost figure is an **estimate**: list-price arithmetic
(`72/1e6 × $0.15 + 10/1e6 × $0.60`) on the token counts the API returned. It is
not a billed amount read back from the account.

**Why two calls.** The first established the result above. The second re-ran the
identical command after a one-line change to how the script exits (it used
`process.exit`, which tripped a libuv teardown assertion on Windows); the usage
was identical. No model was benchmarked, no prompt was tuned, and the call was
not repeated for nicer output.

**Rate limits and remaining balance:** not observed. No rate-limit header was
read and no billing endpoint was queried, so no claim is made about the
account's tier or its remaining credit. One call at this size is not evidence
about either.

**No public arbitrary-prompt endpoint exists.** `generateStructured` is server
only and is reachable from exactly two places: this repository's own code and
the opt-in smoke command. No deployed route calls it.

---

## 7. Vercel link, environment, and deployments

**Project linked:** yes — `mohamed-aziz-ayaris-projects/firstplayable`.
`.vercel/` is gitignored and untracked.

**Runtime environment variables configured** (both stored encrypted, shown as
`Hidden` by the CLI):

| Variable | Production | Preview | Development |
|---|---|---|---|
| `SUPABASE_URL` | yes | yes | no |
| `SUPABASE_SECRET_KEY` | yes | yes | no |

**Deliberately not uploaded:** `SUPABASE_ACCESS_TOKEN` (CLI and migration
tooling only), the database password (never held), `QLOO_API_KEY` (phase 3), and
`OPENAI_API_KEY` — no deployed phase 2 route makes a model call, so deploying
the key would widen exposure for no behaviour. Phase 4 adds it when a deployed
route genuinely needs it. There is no `NEXT_PUBLIC_` variable of any kind.

**Deployments**

| Target | URL | Anonymous access |
|---|---|---|
| Production | **https://firstplayable.vercel.app** | public, HTTP 200 |
| Production, second build (used for the redeployment test) | same URL, deployment `firstplayable-ajm0qc1mk` | public, HTTP 200 |
| Production, third build (from commit `86aaf69`, the final tree) | same URL, deployment `firstplayable-hrlibp8ln` | public, HTTP 200 |
| Preview | `https://firstplayable-26kc4sjt0-mohamed-aziz-ayaris-projects.vercel.app` | **HTTP 302 to a login wall** |

The preview deployment is behind the project's default Vercel Authentication
protection. Through an authenticated CLI request it serves the application
correctly (`/example` returns the saved example, `/studio` returns the shell),
so the preview build and its environment variables are confirmed working. The
protection setting was **not** changed: it is an account security setting, it is
outside "configure only the runtime environment variables phase 2 needs", and
production already satisfies every deployed acceptance item publicly.

GitHub integration was **not** connected. The CLI attempted it automatically
during `vercel link` and failed; the failure was left alone because no phase 2
item needs it and nothing was pushed.

---

## 8. Deployed verification — the application, not the build log

```
RUN_DEPLOY_VERIFY=1 DEPLOY_URL=https://firstplayable.vercel.app \
  npm run verify:deployment      →  exit 0, 24 of 24 checks passed
```

| Check | Observed |
|---|---|
| landing page loads | 200 |
| `/example` loads | 200 |
| `/studio` loads | 200 |
| `POST /api/session` | 200, cookie is `HttpOnly` **and** `Secure` |
| `POST /api/projects` | 201, revision 1 |
| `GET /api/projects/:id` as the owner | 200, premise matches what was sent |
| the same id with a second owner session | **404** |
| foreign versus nonexistent | **byte-identical envelopes** apart from the request id |
| the same id with no session | 401 |
| mutation with no `Origin` | **403** |
| mutation from `https://attacker.example` | **403** |
| mutation with `text/plain` | 415 |
| 32 KiB body against the 16 KiB cap | 413 |
| malformed JSON | 400 |
| body failing the brief contract | 422 |
| every refusal body | no credential, no host, no SQL, no stack trace |

**Two genuinely isolated browser contexts** (separate cookie jars, Chromium):

| Check | Observed |
|---|---|
| the studio establishes a session and persists a project through the form | project `41b93bb5…` created from the landing page in one pass |
| requests the browser made | **same-origin only** — no request to any `*.supabase.co` or `api.openai.com` |
| rendered page content | no credential shape, no Supabase host, no OpenAI host |
| full page reload in the same context | same project id, premise identical (166 characters) |
| **a second clean context opening the same URL** | the premise is absent; the page says the project is not available here |
| the deployed saved example | a complete play to an ending with **zero `/api` requests** |
| the 8 client chunks `/studio` loads | no credential shape and no provider host in any of them |

### Persistence across a brand-new deployment

Done explicitly, not inferred:

1. Project `aa8c9c4f-088e-4363-a400-9c2769b0e813` was created on the deployment
   that was live at `2026-10-03T23:00:21Z`, keeping its owner cookie.
2. `vercel deploy --prod` produced a **new** deployment
   (`firstplayable-ajm0qc1mk`), so new server instances.
3. Reading the same project through the new deployment with the same cookie
   returned **200**, the same project id, the **same `created_at`**, revision 1,
   and the same brief. A freshly established owner session on the new
   deployment got **404** for that id.
4. The same read was repeated once more against a **third** production
   deployment (`firstplayable-hrlibp8ln`, built from the final commit) with the
   same result: 200, same id, same `created_at`, and 404 for a fresh session.
   The full 24-check deployed verification was also re-run against that third
   deployment and passed.

### Database-outage path

Verified locally rather than by breaking production, which would be the wrong
thing to do to a live deployment. `npm run test:e2e` starts the production
server with `SUPABASE_URL` and `SUPABASE_SECRET_KEY` deliberately set to
invalid sentinels, and asserts in a real browser that `/studio` shows a finished
`PERSISTENCE_UNAVAILABLE` error with a request id and a working link to the
saved example, that no spinner is left running, that the page body contains no
credential, host, or stack trace, and that `/example` then plays a complete run
with no database at all.

---

## 9. Secret scan

```
npm run build && npm run check:secrets   →  exit 0
```

| Check | Result |
|---|---|
| `.env` tracked | no |
| `.vercel` tracked | no |
| both ignored by `.gitignore` | yes, asserted in `tests/server/secrets.test.ts` |
| credential shape in any of the 84 tracked files | none |
| credential shape in the 227 built client and server assets | none |
| `NEXT_PUBLIC_` variable carrying a server secret | none exists |
| Supabase or OpenAI host in a client chunk | none, checked locally and on the deployment |
| browser Supabase client, `@supabase/ssr`, or publishable-key architecture | none; exactly one module constructs a client, `src/server/db/supabase-gateway.ts` |

Error envelopes carry only `code`, `message`, `retryable`,
`last_good_version_id`, and `request_id`. Server-side diagnostics pass through
`redactDiagnostic`, which strips secret-key shapes, access tokens, JWTs,
64-hex session hashes, and URLs before anything is logged.

---

## 10. Phase 2 commands and their results

Run from a clean working tree at commit `86aaf69`, with `.next/` deleted first:

| Command | Result |
|---|---|
| `npm run typecheck` | passed, exit 0 |
| `npm test` | passed, exit 0 — 14 files, 222 tests |
| `npm run test:e2e` | passed, exit 0 — 13 Playwright tests |
| `npm run check:fixtures` | passed, exit 0 — 29 checks PASS, 0 FAIL |
| `npm run build` | passed, exit 0 — 8 routes: 4 static, 4 server-rendered on demand |
| `npm run check:secrets` | passed, exit 0 — 84 tracked and 227 built files scanned |
| `RUN_SUPABASE_SMOKE=1 npm run smoke:supabase` | passed, 20 of 20 |
| `RUN_OPENAI_SMOKE=1 npm run smoke:openai` | passed, 1 real call |
| `RUN_DEPLOY_VERIFY=1 … npm run verify:deployment` | passed, 24 of 24 |

Every live command is opt-in. `npm test`, `npm run test:e2e`, and
`npm run build` require no Internet access and no credential.

---

## 11. Known limitations of this preflight

1. **The OpenAI account's own rate limit was not measured.** The specification
   says to set the global model rate to the *lower* of the account's verified
   allowance with a 20% reserve and the application's intended cap. Only the
   second half is in place (40/day). Determining the first half needs
   rate-limit headers or a dashboard reading, neither of which one tiny call
   provides. Phase 4 must complete this before it depends on throughput.
2. **Remaining prepaid balance is unknown.** No billing endpoint was queried,
   so no claim is made about how much budget remains.
3. **`supabase db push` does not work from this machine.** The migrations are
   committed and applied, but reproducing them with the CLI needs either
   `database_pooling_config_read` on the access token or IPv6. See section 2.
4. **Preview deployments are not publicly reachable.** They sit behind Vercel
   Authentication. Production is public, and the protection setting was left as
   the account had it.
5. **The database-outage path was verified locally, not against production.**
   Production was never deliberately broken.
6. **Offline unit tests use an in-memory gateway.** It re-implements the SQL's
   semantics, so it can catch accounting mistakes but cannot prove atomicity.
   The atomicity claims in section 4 come from the live run against Postgres.
7. **The studio shell is minimal.** It proves session, persistence, reload,
   cross-session denial, and the honest failure state. It is not the phase 6
   creative tool, and it uses three fixed world identifiers (`room`, `npc`,
   `object`) rather than deriving them from creator wording.
8. **Thirteen sessions and eight projects remain in the database** from the
   three deployed verification runs and the redeployment probe. They are real
   persistence evidence rather than leftovers, and they are inspectable. The
   live Supabase smoke cleans up after itself; the deployed verification
   deliberately does not, so the redeployment test had something to read. The
   four later-phase tables hold zero rows.
9. **Qloo was not used anywhere.** No phase 2 code path reads `QLOO_API_KEY`,
   no Qloo host appears in any source file, and `qloo_captures` holds zero rows.
10. **Phase 3 is not implemented.** The route list is asserted to be exactly
    `POST /api/session`, `POST /api/projects`, and `GET /api/projects/:id`.

---

## 12. Phase 4 additions — migration and environment

Appended by the Phase 4 local live-acceptance session, 4 October 2026. The
full record is `docs/PHASE4_EVIDENCE.md`.

### Migration

| Version | File | Applied live | How |
|---|---|---|---|
| `20261004160000` | `supabase/migrations/20261004160000_phase4_compilation.sql` | **yes** | the already-authorised Supabase management connection, as one statement |

`supabase db push` was attempted first and failed with the same
`DbConfigIpv6Error` recorded in section 2, so the blocker documented there
persists unchanged. The migration's history row was then set to the version its
filename declares, so `supabase migration list` and the committed files agree:

```
20261003222350  phase2_schema
20261003222456  phase2_atomic_functions
20261004085412  phase3_qloo
20261004160000  phase4_compilation
```

Verified against the live catalog: seven new columns with their intended
defaults, the `compile` stage value admitted, the
`scene_versions_validation_passed` guard present, and seven new functions all
`SECURITY INVOKER` with `search_path=""` and `execute` granted to
`service_role` only. Still eight tables, RLS enabled on all eight, and **zero**
rows in `pg_policies`. Phase 1–3 data intact.

### Environment

`OPENAI_API_KEY` — which section 7 recorded as deliberately withheld because
no deployed Phase 2 route made a model call — is now present in **Production
and Preview**, stored encrypted and shown as `Hidden`. So are
`OPENAI_CHAT_MODEL`, `QLOO_API_KEY`, and `QLOO_API_BASE_URL`.

| Variable | Production | Preview | Development |
|---|---|---|---|
| `SUPABASE_URL` | yes | yes | no |
| `SUPABASE_SECRET_KEY` | yes | yes | no |
| `QLOO_API_KEY` | yes | yes | no |
| `QLOO_API_BASE_URL` | yes | yes | no |
| `OPENAI_API_KEY` | yes | yes | no |
| `OPENAI_CHAT_MODEL` | yes | yes | no |

Still **deliberately not uploaded:** `SUPABASE_ACCESS_TOKEN` and the database
password. There is still no `NEXT_PUBLIC_` variable of any kind. No value was
read or printed while confirming this.

### Deployment

**No Phase 4 deployment was made.** Local live acceptance did not go green,
and the handoff requires deploying only after it does; the production URL
therefore still serves the verified Phase 3 build. The Phase 4 sections of
`scripts/verify-deployment.ts` are written and committed, ready to run once a
compilation succeeds locally.

> That changed later the same day: local acceptance went green and the
> deployment was made and verified. Section 13 records it. The paragraph above
> is left exactly as it was written, because it was true when it was written.

---

## 13. Phase 4 deployment — made, and verified against the deployment

Appended 4 October 2026, after the Phase 4 live acceptance passed its gate.
The full record is `docs/PHASE4_EVIDENCE.md` §16. Every fact below was observed
by a command run in this repository, not inferred from a build log.

### Migrations applied live

Both Phase 4 migrations are applied to the real Supabase project and verified
against the live catalog. Neither was edited after application; the second is a
forward migration that replaces one constraint the first added.

| Version | File | Applied live | Verified |
|---|---|---|---|
| `20261004160000` | `20261004160000_phase4_compilation.sql` | **yes** | section 12, and `PHASE4_EVIDENCE.md` §4 |
| `20261004173000` | `20261004173000_phase4_validation_boolean.sql` | **yes** | `PHASE4_EVIDENCE.md` §14.3 and §14.7 |

`supabase migration list` and the committed files agree:

```
20261003222350  phase2_schema
20261003222456  phase2_atomic_functions
20261004085412  phase3_qloo
20261004160000  phase4_compilation
20261004173000  phase4_validation_boolean
```

The validated-version guard and the row-level immutability trigger were both
probed against live Postgres with deliberately invalid writes, every one of
which was refused — six negative insert shapes with `23514`, and an update to
a committed version with `23001`. Those probes are `PHASE4_EVIDENCE.md` §16.8.

### OpenAI runtime environment present

`vercel env ls production`, read without printing any value:

| Variable | Production | Type |
|---|---|---|
| `OPENAI_API_KEY` | yes | Secret, shown as `Hidden` |
| `OPENAI_CHAT_MODEL` | yes | Secret, shown as `Hidden` |
| `QLOO_API_KEY` | yes | Secret, shown as `Hidden` |
| `QLOO_API_BASE_URL` | yes | Secret, shown as `Hidden` |
| `SUPABASE_URL` | yes | Secret, shown as `Hidden` |
| `SUPABASE_SECRET_KEY` | yes | Secret, shown as `Hidden` |

Six variables, and only those six. Still **deliberately absent**:
`SUPABASE_ACCESS_TOKEN`, the database password, and any `NEXT_PUBLIC_`
variable of any kind. `MODEL_COST_CAP_MICROS` is also absent, so the
compiled-in cumulative **$0.60** cap applies in production unmodified.

### Production deployment verified

```
vercel --prod --yes
```

| Fact | Observed |
|---|---|
| Target | `production`, status `ok` |
| Immutable deployment URL | `firstplayable-74c7bthei-mohamed-aziz-ayaris-projects.vercel.app` |
| Production URL | **`https://firstplayable.vercel.app`** — unchanged from Phase 2 and Phase 3 |
| `/` anonymously | `200` |
| `/example` anonymously | `200` |

The production URL is the same alias the Phase 2 and Phase 3 records verified.
No new domain, project, or alias was created.

### Deployed verifier — 78 of 78

```
RUN_DEPLOY_VERIFY=1 DEPLOY_URL=https://firstplayable.vercel.app npm run verify:deployment
```

**78 checks, 78 passed.** It drives the deployed application itself — an HTTP
matrix over the real routes, then two genuinely isolated browser contexts —
not the build log. What the Phase 4 half established on the deployment:

| Deployed check | Result |
|---|---|
| A build is refused until an interaction is approved | PASS |
| The stage list advances in the locked wording, every stage committed | PASS |
| Any stage reaching a third attempt | **none** |
| A pending validated scene appears, and nothing is active yet | PASS |
| The fourth provenance layer, matching the stored witness verbatim | PASS |
| The pending scene plays to an ending in the browser | PASS |
| Requests caused by a complete playthrough, the ending, and a reset | **0** |
| Nothing current until confirmed, then exactly the reviewed version | PASS |
| The active version survives a full page reload and still plays | PASS |
| Any revision, share, publish, export, or compare control | **none**, 30 actionable elements checked |
| The browser reaching `api.openai.com`, the Qloo host, or Supabase | **never**; all requests same-origin |
| A second browser with its own empty cookie jar | refused; cannot build, advance, or activate |
| Fresh-deployment persistence: same version, same scene byte for byte | PASS |
| No owner session / a fresh non-owning session | `401` / `404`, learning nothing |

One earlier run of the same command reported 77 checks with one failure. The
defect was in the verifier, not the application: a check sent no cookie while
asserting the `404` that an *established* non-owning session gets, rather than
the `401` that no session gets. Both behaviours were already asserted correctly
elsewhere in the same script. It is recorded in `PHASE4_EVIDENCE.md` §16.9 and
was fixed before the run above.

### No secrets exposed

| Scan | Result |
|---|---|
| `npm run check:secrets` — tracked files | **PASS**, 166 files, no credential shape |
| `npm run check:secrets` — built client and server assets | **PASS**, 350 files |
| `.vercel` tracked by git | **no**, confirmed untracked |
| Client chunks fetched from the deployment and scanned | **clean**, 8 chunks |
| Rendered deployed pages scanned for credential shapes and provider hosts | **clean** |
| Credential, host, SQL, or stack trace in any refusal response | **none** |

No key, token, database password, or cookie value appears in this file, and
none was printed while confirming any of the above.

### What this section does not claim

It does not re-verify the Preview environment, which section 12 recorded and
this session did not read again. It does not claim a reliability measurement:
the deployment was verified by one full verifier run, following two local live
compilations. And the spend figures in `PHASE4_EVIDENCE.md` §16.12 are labelled
list-price estimates computed from provider-reported usage, not amounts read
back from the OpenAI account.
