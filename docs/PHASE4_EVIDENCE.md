# Phase 4 — live compilation acceptance

**Branch:** `feat/phase-4-compilation` · **Date:** 4 October 2026 ·
**Status:** **FAIL — Phase 4 is not complete**

> **Read §12 and §14 as well.** A later session on the same day changed the
> base compilation architecture in response to the measured failures recorded
> below, and then fixed a database integrity defect that change's probing
> uncovered. Both re-ran the whole offline gate. The live acceptance gate is
> still not met. Sections 1–11 are the original record and are preserved
> unchanged; §12–13 are the architectural amendment and the budget reason the
> live gate is still open, and §14–15 are the constraint hardening, applied and
> verified live with its migration history reconciled.

Every figure in this document was observed on this machine against the real
Supabase project and the real OpenAI account. Nothing here is a projection.
Where a gate was not reached, this document says so and says why, rather than
reporting the gates that did pass as if they were the whole.

No API key, access token, database password, or cookie secret appears anywhere
in this file.

**Cloud baseline HEAD:** `2fd70bc3dd6cc54925c34992d5dc3106b36446a0`
**Final local HEAD of this record:** `67a565a` (see §2); after the §12
amendment, `62aaca9`; after the §14 hardening, `fcac34a`
**Nothing was pushed. No pull request was opened.**

---

## 1. The verdict, in one table

| Phase 4 gate (handoff §Q) | Result |
|---|---|
| 1. Offline gate green locally | **PASS** (§3) |
| 2. `20261004160000` applied and verified live | **PASS** (§4) |
| 3. Fresh brief, **one** real approved influence, playable scene | **FAIL** (§6) |
| 4. Fresh brief, **two** real approved influences, playable scene | **NOT REACHED** (§6) |
| 5. No pending/rejected/other-slot evidence entered a module prompt | **PASS**, offline sentinels; not contradicted live (§7) |
| 6. Mechanical witness per active module, stored on the version | **NOT REACHED** — no version was created |
| 7. Every supported removal subset validates, stored on the version | **NOT REACHED** — no version was created |
| 8. A live stale result cannot activate; previous version survives failure | **PARTIAL** (§8) |
| 9. Repair never exceeded its ceiling — no stage with `attempts > 2` | **PASS** (§6, §7) |
| 10. Deployed application satisfies every box of handoff §O | **NOT RUN** (§9) |
| 11. Evidence records the real numbers, including every failure | **PASS** — this document |

**Phase 4 therefore fails, and Phase 5 is not authorized.**

The honest one-line summary: *every mechanism Phase 4 built is working
correctly, and the pinned model did not produce a scene that the Phase 1
validator accepts within the two attempts the specification allows.* Eight
real compilations were attempted. One reached a committed clean base; none
reached a `scene_versions` row. `public.scene_versions` still contains **0
rows**.

---

## 2. Local commits, in chronological order

All ten Cloud commits are preserved unchanged. Nothing was amended, squashed,
or force-pushed.

| Commit | Message |
|---|---|
| `eed650a` | `fix: build the application before the browser gate serves it` |
| `79b5f7d` | `test: add the real phase 4 compilation acceptance smoke` |
| `c7925ee` | `fix: state the core id namespace rule for every declared kind` |
| `961d304` | `test: verify the deployed phase 4 compilation and version persistence` |
| `ad13a2c` | `fix: show the base stage where a declared variable is read` |
| `d0d079f` | `fix: prescribe the base availability skeleton the validator requires` |
| `5466588` | `test: let the phase 4 smoke re-ask after a lost provider connection` |
| `114821a` | `fix: let the server own each module hook attachment point` |
| `c642ed0` | `fix: show each module how its own variable is wired` |
| `8e56150` | `fix: prescribe one always-branch per base action` |
| `67a565a` | `fix: say which field each base ending id belongs in` |

---

## 3. The offline gate, and a real defect in it

Run from the Cloud HEAD before any live work.

| Command | Result |
|---|---|
| `npm ci` | 193 packages, 0 vulnerabilities |
| `npm run typecheck` | passed, exit 0 |
| `npm test` | passed, exit 0 — 29 files, **562** tests |
| `npm run test:e2e` | **12 failed, 34 passed** — see below |
| `npm run check:fixtures` | passed, exit 0 |
| `npm run build` | passed, exit 0 |
| `npm run check:secrets` | passed, exit 0 — 162 tracked, 350 built files scanned |

### The browser gate was testing a stale build

`npm run test:e2e` reported 12 failures: `tests/browser/phase3.spec.ts:40` and
every studio test in `tests/browser/phase4.spec.ts`. The first assertion to
fail was always a Phase 4 test id, for example `compile-needs-approval` or
`active-playable`.

Root cause: `playwright.config.ts` started the server with `npm run start`,
which serves whatever `.next` already holds. The `.next` on this machine was
built at 11:17 — **before the Phase 4 commits** — and
`grep -rl "compile-needs-approval" .next/` returned nothing. The handoff's own
gate order runs `npm run build` *after* `test:e2e`, so the browser gate had
never served the code it was testing.

This is a real defect in the gate, not a defect in the Cloud implementation,
and it cuts both ways: a stale `.next` can equally report a **pass** for code
that has since been removed. `eed650a` makes the webServer command
`npm run build && npm run start`, so the gate builds the assets it serves
whatever order the surrounding steps run in, and
`tests/engine/fixtures.test.ts` now asserts that ordering.

After the fix, from a deleted `.next`:

| Run | Result |
|---|---|
| First | 45 passed, 1 failed — `phase3.spec.ts:354`, `page.goto: net::ERR_ABORTED; maybe frame was detached?` after 35.8 s |
| Second | **46 passed, 0 failed, exit 0** |

The single failure was a Playwright navigation flake on this Windows machine,
not an application defect: it moved between tests across runs
(`phase3.spec.ts:125` on one run, `:354` on another) and disappeared on
re-run. **All 13 Phase 4 browser tests pass.** Recorded as a known
environmental flake, not fixed by retries, since `retries: 0` is deliberate.

### The gate at the final local HEAD

See §10.

---

## 4. The Phase 4 migration, applied live

### How it was applied

`supabase db push` was attempted first, as the handoff asks. The documented
Phase 2 blocker persists exactly:

```
$ npx supabase migration list
{"_tag":"Error","error":{"code":"DbConfigIpv6Error",
 "message":"IPv6 is not supported on your current network",
 "suggestion":"Run supabase link --project-ref … to setup IPv4 connection."}}
```

The migration was therefore applied through the same already-authorised
Supabase management connection Phases 2 and 3 used, as a single statement, and
its history row was then set to the version its filename declares so the
committed files and the remote history agree.

**Before:** three migrations, 13 `public` functions, 8 tables, 0 policies, 21
projects, 7 decisions, 6 captures, 7 operations, **0 `scene_versions`**.

```
20261003222350  phase2_schema
20261003222456  phase2_atomic_functions
20261004085412  phase3_qloo
20261004160000  phase4_compilation      ← added
```

### The live catalog, verified

**The seven new columns**, with their intended defaults:

| Column | Type | Nullable | Default |
|---|---|---|---|
| `projects.compiled_modules` | jsonb | NO | `'{}'::jsonb` |
| `projects.pending_version_id` | uuid | YES | — |
| `scene_versions.approval_snapshot` | jsonb | NO | `'[]'::jsonb` |
| `scene_versions.compiler_identifier` | text | YES | — |
| `scene_versions.input_snapshot` | jsonb | NO | `'{}'::jsonb` |
| `scene_versions.operation_id` | uuid | YES | — |
| `scene_versions.validator_identifier` | text | YES | — |

**The constraints**, read back from `pg_constraint`:

```
operations_stage_known
  CHECK (stage = ANY (ARRAY['artist_search','references','proposals','compile',
    'base','module_discovery','module_commitment','ending_copy','validate','smoke']))

scene_versions_validation_passed
  CHECK (((validation_summary ->> 'ok')::boolean IS TRUE)
     AND (validation_summary ? 'subsets')
     AND (validation_summary ? 'witnesses'))

scene_versions_approval_snapshot_is_array
  CHECK (jsonb_typeof(approval_snapshot) = 'array')
projects_compiled_modules_is_object
  CHECK (jsonb_typeof(compiled_modules) = 'object')
projects_compiled_modules_bounded
  CHECK (length(compiled_modules::text) <= 65536)
projects_pending_version_fk
  FOREIGN KEY (pending_version_id) REFERENCES scene_versions(id) ON DELETE SET NULL
```

`compile` is admitted, and the unvalidated-version guard exists.

**The seven functions.** Every one is `SECURITY INVOKER` (`prosecdef = false`),
every one pins `search_path=""`, and every one is executable by `service_role`
and the owner only — revoked from `public`, `anon`, and `authenticated`:

| Function | `prosecdef` | `proconfig` | ACL |
|---|---|---|---|
| `activate_scene_version` | false | `search_path=""` | `postgres=X/postgres`, `service_role=X/postgres` |
| `commit_scene_version` | false | `search_path=""` | same |
| `decline_scene_version` | false | `search_path=""` | same |
| `lease_compile_operation` | false | `search_path=""` | same |
| `park_operation` | false | `search_path=""` | same |
| `read_scene_versions` | false | `search_path=""` | same |
| `set_project_compilation_state` | false | `search_path=""` | same |

**Posture and data, after application:**

| Fact | Before | After |
|---|---|---|
| Tables in `public` | 8 | **8** — no ninth table |
| Tables with RLS enabled | 8 | **8** |
| Rows in `pg_policies` | 0 | **0** — deny-by-default unchanged |
| `public` functions | 13 | **20** — exactly the seven added |
| `projects` | 21 | 21 (29 later, from the live runs) |
| `influence_decisions` | 7 | 7 intact |
| `qloo_captures` | 6 | 6 intact |
| `scene_versions` | 0 | **0** |

`npm test` still passes, so `tests/server/migrations.test.ts` — a static check
on the committed SQL — agrees with what was applied.

**Not verified:** the row-level immutability trigger and the
`scene_versions_validation_passed` constraint were **not** exercised with a
real `update` or a deliberately invalid `insert`, because the handoff's §K
probes are written against a project that owns a version row and no version
row was ever created. Both are asserted statically by
`tests/server/migrations.test.ts` and dynamically against the in-memory
gateway. They remain unproven against live Postgres.

---

## 5. The OpenAI boundary

`RUN_OPENAI_SMOKE=1 npm run smoke:openai`, before any compilation:

| Fact | Observed |
|---|---|
| Configured model | `gpt-4o-mini-2024-07-18` |
| Model the provider reported | `gpt-4o-mini-2024-07-18` |
| Structured Outputs | accepted; Zod validated the result |
| Input / output / total tokens | 72 / 10 / 82 |
| Elapsed | 2,642 ms |
| Cost **ESTIMATE** | $0.00001680 — list-price arithmetic on the tokens above, **not** a billed amount |

The account, the pinned snapshot, and Structured Outputs all work. No model
fallback, provider fallback, or routing exists or was used.

---

## 6. The real compilations — what actually happened

A new opt-in command drives them:

```
RUN_PHASE4_SMOKE=1 npm run smoke:compile
```

It is not part of `npm test`, `npm run build`, `npm run test:e2e`, or CI, and
`tests/engine/fixtures.test.ts` asserts that. It calls the model **only**
through `POST /api/projects/:id/compile` and
`POST /api/operations/:id/advance` — the same handlers the deployed runtime
calls — and the same test asserts it reaches no stage function, payload
builder, or adapter directly.

Each run created a genuinely fresh project through the real Phase 3 path: a
new brief ("The Last Collection", not the saved example's), a real Radiohead
search, an explicit anchor confirmation, real first-hop references, one real
bounded proposal call, and one explicit approval of a real proposal
("Children of Men" into `discovery`).

### Every base and module attempt, from `public.operations`

| # | Stage | Attempts | Deterministic finding codes | Outcome |
|---|---|---|---|---|
| 1 | `base` | 2 / 2 | `NAMESPACE_INVALID`, `VARIABLE_NEVER_READ` | failed |
| 2 | `base` | 2 / 2 | `VARIABLE_NEVER_READ` | failed |
| 3 | `base` | 2 / 2 | `VARIABLE_NEVER_READ` | failed |
| 4 | `base` | 2 / 2 | — | **succeeded** (repaired) |
| 4 | `module_discovery` | 2 / 2 | `HOOK_PORT_INVALID`, `VARIABLE_NEVER_READ`, `VARIABLE_NEVER_WRITTEN` | failed |
| 5 | `base` | 2 / 2 | `AMBIGUOUS_BRANCH`, `DEAD_BRANCH`, `ENDING_UNREACHABLE`, `SOFTLOCK`, `NO_ENDING_CLOSING_CHOICE`, `NO_CONSEQUENTIAL_CHOICE` | failed |
| 6 | `base` | 2 / 2 | `NAMESPACE_INVALID`, `ENDING_IDS_INVALID`, `TERMINAL_MAPPING_INVALID` | failed |
| 7 | `base` | 2 / 2 | `NO_PROGRESS` | failed |

One further run spent **zero** model calls: it failed at
`POST /api/session` with `PERSISTENCE_UNAVAILABLE` / `fetch failed`, a
transient network fault. `RUN_SUPABASE_SMOKE=1 npm run smoke:supabase` passed
20 checks immediately afterwards, so it was a blip, not a configuration fault.
An earlier run also lost its connection during the Phase 3 proposal stage
(`MODEL_TRANSPORT`, one spent attempt, `attempts 1`), which is why `5466588`
lets the smoke re-ask — the creator's own button — bounded at three requests.

### What this proves about the Phase 4 machinery

Every one of these is a mechanism working correctly, observed live:

- **The attempt ceiling held, every time.** No stage row anywhere shows
  `attempts > 2`. The one permitted repair ran on every failing stage, and the
  third advance always got `attempts_exhausted` from `reserve_operation`
  rather than a third provider call.
- **One advance, at most one provider attempt.** Every advance response
  reported `model_calls` of 0 or 1, and the counted provider requests always
  equalled the controller's own count.
- **Creating a compilation performs no provider call.** Observed on every run.
- **Compilation made zero Qloo calls.** Measured by counting every upstream
  request between `POST .../compile` and the pending version: **0** on every
  run. `qloo_calls.used_calls` stayed at **5** across the whole session.
- **A failed compilation is a finished state.** Every `compile` controller row
  settled as `failed` with `VALIDATION_FAILED` and the failing stage named.
- **Nothing invalid was persisted.** `public.scene_versions` has **0** rows.
  Every rejected candidate lives only in a bounded operation artifact, exactly
  as specified.
- **The database refused what it was supposed to refuse**, and the validator
  caught every defect the model produced.

### Why it still failed, and the five defects fixed along the way

Each failure was diagnosed from the stored deterministic findings and the
stored rejected candidate, and each fix is the narrowest change that removes
its cause, with regression coverage. None of them loosens a validator
invariant, widens an attempt budget, adds a model or provider fallback, adds a
Qloo call, flattens module isolation, or bypasses the compare-and-swap, the
version constraint, or creator activation.

1. **`c7925ee` — the `core.` namespace rule had no worked example for two of
   the three declared kinds.** Every example in the block was an action, so
   the model namespaced dialogue nodes after the schema field they sit in:
   `dialogue.inspect_watch`. Fixed by naming the wrong forms as wrong.
   *Result:* `NAMESPACE_INVALID` disappeared from the next two runs.
2. **`ad13a2c` — the block never said where a variable is *read*.** The rule
   "every variable must be read by some condition" was stated; the two idioms
   the authoritative fixture uses were not. One repair, shown the finding,
   "fixed" it by setting `core.ask_context`'s condition to `{kind: never}` —
   disabling a required action. Fixed by naming both idioms and forbidding a
   never-available action.
3. **`d0d079f` — the availability conditions were left to the model.** The
   block fixed the six action ids and verbs but not when each is available,
   which is what determines whether variables are read, whether endings are
   reachable, and whether any ending is three actions away. Fixed by
   prescribing the skeleton, and by a test that reads
   `fixtures/second_copy.base.json` and asserts the block and the fixture
   agree. *Result:* run 4's base **committed**, on its repair.
4. **`114821a` — a module could name the port it attaches to, and there was
   never a choice to make.** A Discovery module attached its hook to
   `core.ask_context`, which is Commitment's port. Each slot has exactly one
   effect port, so `ModelOnActionSchema` no longer has an `action_id` field at
   all and `moduleFromModelOutput` writes `FIXED_PORTS[slot]` itself — the
   same principle that already stops a module naming its own slot or approval.
   Gates keep their `action_id`, because Commitment really does have two gate
   ports, and `GATE_PORT_INVALID` still checks it.
5. **`8e56150` and `67a565a` — branch structure.** The block said nothing
   about how many branches an action should have, and a base gave
   `core.inspect` two branches that both applied. Fixed by prescribing the
   fixture's one `{kind: always}` branch per action. The first wording of that
   rule said `core.give` "names" `end.give`, which the next attempt read as
   licence to declare *dialogue nodes* called `end.give`, `end.keep`, and
   `end.leave` — a regression caused by this document's own ambiguity, fixed
   in `67a565a` by saying which field each id belongs in.

`c642ed0` applied fix 2's treatment to the module block for the same reason.

**The remaining failure (`NO_PROGRESS`) is the same shape as 3:** the skeleton
prescribes that `core.inspect` is available only while `core.inspected` is
false, and the model gave it a condition that does not exclude the
already-inspected state. The instruction is correct and explicit; the model
did not follow it.

### Provider usage for the whole session

Read from `public.budget_buckets`, which is where the controller reconciles
each stage's reported usage. **Per-stage token usage is not persisted** — the
bucket is per window — so this is the honest granularity available.

| Fact | Observed |
|---|---|
| `model_calls.used_calls` | **31** of a configured limit of **40** |
| `model_calls.used_tokens` | **129,089** |
| Window | 2026-10-04 00:00 UTC → 2026-10-05 00:00 UTC |
| `qloo_calls.used_calls` | **5**, unchanged by any compilation |

Cost **ESTIMATE** for the whole session, from the pinned model's list prices
encoded in `PINNED_MODEL_PRICING_USD_PER_MTOK` and the token total above:
roughly **$0.03**. This is arithmetic on observed tokens, **not** a billed
amount, and it covers nine attempted runs including the eight that failed —
not the cost of one successful compilation, which was never measured.

**One-influence compile:** no successful figure exists.
**Two-influence compile:** never attempted (§below).
**Repairs:** eight stages took their one repair; none took a second.

---

## 7. What was not reached, and why

The smoke runs sections A→F in order and stops at the first hard failure, so
every section after the one-influence compilation is unreached:

- **Two-influence compilation (gate 4).** Never attempted. It needs a
  one-influence base and module to commit first.
- **Subset reports and mechanical witnesses (gates 6, 7).** Both live on a
  `scene_versions` row. No row was created.
- **Structural acceptance through the real engine**, the three-endings
  playthrough, module isolation on a live two-module scene, and the fourth
  provenance layer in the live UI: all unreached for the same reason.
- **Base reuse keyed to the brief.** Unreached. Run 4 did commit a base, so
  the artifact-reuse path exists in live data, but no second compilation ran
  against it.

**Module payload isolation (gate 5)** is proven by the offline sentinel tests
and was not contradicted live: the one real module stage that ran produced
`discovery.*` identifiers only, and its failure was a port and a variable, not
foreign evidence.

---

## 8. Stale-result protection — partial

The live stale-result test lives in the smoke's section F, which was never
reached, so **the live compare-and-swap was not exercised end to end.**

What *is* established:

- The compare-and-swap is proven offline against the in-memory gateway, which
  re-implements the committed SQL, and by the delayed-provider test for the
  exact in-flight race.
- The SQL that enforces it — `commit_scene_version` and
  `activate_scene_version`, both comparing revision, base hash, and approval
  pointers, the latter read from the version row itself — is **applied and
  verified live** (§4).
- Live, every one of the eight failed compilations left
  `projects.active_version_id` and `pending_version_id` untouched and
  `scene_versions` empty, which is the "a failure preserves the previous
  version" half of the gate, on real Postgres.

**Not established live:** that a stale result is refused by the SQL
compare-and-swap, because reaching that checkpoint requires a successful
compilation. This is a genuine gap, and it is the distinction the handoff asks
to be documented honestly rather than blurred.

---

## 9. Deployment and deployed verification — not run

**Not deployed, and the deployed Phase 4 checklist was not run.**

The environment is ready. `vercel env ls` for both targets shows all six
runtime variables, each stored encrypted and shown as `Hidden`:

| Variable | Production | Preview |
|---|---|---|
| `SUPABASE_URL` | yes | yes |
| `SUPABASE_SECRET_KEY` | yes | yes |
| `QLOO_API_KEY` | yes | yes |
| `QLOO_API_BASE_URL` | yes | yes |
| `OPENAI_API_KEY` | yes | yes |
| `OPENAI_CHAT_MODEL` | yes | yes |

There is **no `NEXT_PUBLIC_` variable of any kind**, and neither
`SUPABASE_ACCESS_TOKEN` nor any database password is present. No value was
read or printed.

Two reasons it was not deployed, both of which are the instruction being
followed rather than an obstacle:

1. **Local live acceptance is not green.** The handoff and the task both say
   to deploy only after it is. Deploying a build whose compilation path has
   never produced a scene would prove nothing and would replace a working
   Phase 3 production deployment with an unverified one.
2. **The configured model-call budget for this window is nearly spent.** 31 of
   40 calls are used. The deployed browser flow costs three more, and a
   successful local run costs about eleven; both do not fit. The cap is a
   deliberate safety setting that may be lowered but never raised, so it was
   left alone.

`scripts/verify-deployment.ts` was extended for Phase 4 anyway (`961d304`), so
the work is ready to run in the next budget window: a `phase4BrowserFlow` that
drives the deployed build, stage list, pending review, local playthrough with
request counting, explicit activation, reload persistence, Phase 5-control
absence, and second-browser refusal; and a `freshServerPersistence` that
re-reads a named version through a later deployment and compares its id,
`created_at`, and a hash of the scene itself.

---

## 10. The gate at the final local HEAD

Run from a clean tree at `67a565a`:

| Command | Result |
|---|---|
| `npm run typecheck` | passed, exit 0 |
| `npm test` | passed, exit 0 — 29 files, **578** tests, 0 failures |
| `npm run test:e2e` | passed, exit 0 — **46** Playwright tests, 0 failures |
| `npm run check:fixtures` | passed, exit 0 |
| `npm run build` | passed, exit 0 |
| `npm run check:secrets` | passed, exit 0 |

Phase 4's Cloud session recorded 562 unit tests; the live-acceptance work adds
16 for the defects above, all of them regression coverage rather than new
feature tests.

---

## 11. Known limitations

1. **No fresh scene has ever been compiled.** This is the Phase 4 gate, and it
   is not met. Everything downstream of it is unproven live.
2. **The base stage's reliability is the open question.** After five fixes the
   base's mechanical skeleton is fully prescribed in the instruction block —
   the three variables, each action's availability condition, one
   `{kind: always}` branch per action, and which field each ending id belongs
   in — and the model still fails to follow some part of it on most attempts,
   with a different part failing each time. The compilation gets two attempts
   by specification, and `validateScene` skips graph analysis when layer A
   fails, so a candidate with a fault in each layer cannot pass within the
   ceiling: the repair fixes what it was shown and only then discovers the
   next layer. That interaction is worth recording, and widening the ceiling
   is not the permitted response to it.
3. **An unresolved design question, which is not this session's to decide.**
   Every mechanical element of the base is now determined by the brief and
   identical for every brief; the model's only genuine contribution is the
   title, the action labels, the dialogue, and the three endings' text.
   Whether the server should therefore construct the base's mechanics
   deterministically and ask the model only for prose is an architectural
   change to the Phase 4 contract, so it was **not** made. It would remove
   this entire failure class without weakening the validator — the assembled
   base would still go through `verifyBase` unchanged — but it changes what
   "the model writes the encounter" means, and specification §4/§7 and the
   Cloud design should decide it, not an acceptance run.
4. **Live immutability and the validated-version constraint are unexercised**
   against real Postgres, because both probes need a version row (§4).
5. **The live stale-result compare-and-swap is unexercised** (§8).
6. **Per-stage token usage is not persisted**, only the per-window bucket, so
   no per-stage cost figure can be given honestly (§6).
7. **One Playwright navigation flake** on this machine, moving between tests
   and clearing on re-run (§3). Not an application defect; not papered over
   with retries.
8. **29 projects now exist** in the live database from these runs, each with a
   real brief, a real anchor, real stored references, and a real approval.
   None has a scene version. They are owner-scoped to throwaway anonymous
   sessions and are harmless, but they are real rows.

---

## 12. The recovery amendment — architecture changed, live gate still open

**Date:** 4 October 2026, same day, same branch, later session.
**Status:** **offline recovery complete; the live acceptance gate is still
blocked, now by the model-call budget rather than by the architecture.**

Everything above this line is preserved exactly as it was written. The
nine-run diagnostic record is the reason this section exists, and deleting it
would delete the evidence that justifies the change.

### 12.1 What changed, and why

The design question recorded as limitation §11.3 — *should the server
construct the clean base's mechanics deterministically and ask the model only
for prose?* — has been answered **yes**, and implemented.

The amendment is one sentence: **the server owns the clean base's mechanics;
the model authors only the clean base's narrative copy.**

This was not a preference. It is what §6 measured. Seven live base
compilations produced six distinct deterministic finding codes
(`NAMESPACE_INVALID`, `VARIABLE_NEVER_READ`, `AMBIGUOUS_BRANCH`,
`ENDING_IDS_INVALID`, `TERMINAL_MAPPING_INVALID`, `NO_PROGRESS`) and one clean
commit. After five successive instruction fixes the mechanical skeleton was
fully prescribed in prose, and the model still failed a different part of it on
most attempts. Every value it was failing on had **exactly one legal answer**,
fixed by the product contract and identical for every brief. A field with one
legal answer is the server's to write — the same principle that had already
removed the module slot, the approval authority, the hook attachment port, and
the effect operator from model output.

Prose a model may ignore is not a mechanism. A field it cannot reach is.

### 12.2 What the server now owns

`src/server/compile/base.ts` constructs, from the frozen brief alone:

- the three variable ids, their labels, `initial: false`, and `visible: false`;
- the six core action ids and verbs, read from the validator's own
  `REQUIRED_CORE_ACTIONS` table so the two cannot disagree;
- every action's target, from the shared `VERB_TARGET_KIND` derivation;
- every action's availability condition;
- exactly one `{kind: always}` branch per action;
- every effect, with `set_true` written by the server;
- the three dialogue node ids and each node's speaker;
- the three ending ids and each terminal action's ending binding;
- the fixed port table, as before.

### 12.3 What the model still writes

`BaseNarrativeCopySchema` is a flat strict object of **sixteen bounded plain
strings**, keyed semantically rather than by executable identifier:

```
title
inspect_label  ask_context_label  ask_terms_label
give_label     withhold_label     leave_label
inspect_dialogue  context_dialogue  commitment_dialogue
give_ending_title  give_ending_text
keep_ending_title  keep_ending_text
leave_ending_title leave_ending_text
```

There is no field in which to put an id, a namespace, a variable, a condition,
a clause, an atom, a branch, an effect, an ending id, a port, an extra action,
or a fourth ending. Those are not rejected values; they are unrepresentable
ones, which is why the whole observed failure class cannot recur. The labels
are purely presentational: nothing reads one programmatically, because the
engine, the validator, the port table, the witness search, and the provenance
binding all address an action by its server-assigned id.

### 12.4 What was explicitly *not* changed

| Not changed | Evidence |
|---|---|
| The validator | `VALIDATOR_IDENTIFIER` is still `fp-engine-validator-1.0`, while the compiler, prompt, and schema identifiers all moved to `4.1`. A stored version records all four, so the claim is checkable from a row. |
| The retry ceiling | still one attempt plus at most one repair; `OPERATION_MAX_ATTEMPTS` untouched |
| The model | still the pinned `gpt-4o-mini-2024-07-18`; no fallback model, provider, or routing exists |
| Module architecture | Discovery and Commitment remain independently model-compiled. A module's mechanic is a genuine creative choice, so it was left alone. |
| Module isolation | unchanged; the sentinel suite is unchanged and still passes |
| Qloo | no new call anywhere; the base payload is still the brief alone |
| Base reuse keying | still the brief-only payload hash; no artist, Qloo evidence, approval, proposal, reference, or cultural context enters it |
| CI | still credential-free; the real smoke is still opt-in and still asserted out of `npm test`, `build`, `test:e2e`, and CI |

The assembled base goes through the **same** `verifyBase` → `validateScene`
path it always did. Nothing special-cases a server-authored core, and nothing
skips graph validation because the mechanics are now trusted. If a
deterministic base ever failed the validator, that would be a defect in this
application's own skeleton code, and it is meant to read that way.

### 12.5 The commits

| Commit | Message |
|---|---|
| `6809145` | `refactor: make clean base mechanics deterministic` |
| `62aaca9` | `test: cover deterministic base compilation invariants` |

All 22 earlier Phase 4 commits are preserved unchanged. Nothing was amended,
squashed, or force-pushed.

### 12.6 Offline regression coverage

`tests/server/compile-base.test.ts` is new: **29 tests**, written against the
assembled structure rather than against instruction wording, which is the
specific weakness of the architecture it replaces.

The strongest single assertion: **`baseCoreFromCopy(SECOND_COPY_BRIEF,
validBaseCopy())` reproduces the hand-authored Phase 1 fixture
`fixtures/second_copy.base.json` exactly** — every action id, verb, target,
availability condition, branch, effect and ending binding, every dialogue node
and speaker, and every string a player reads. The one permitted difference is
the three variable *labels*, which are `visible: false` and therefore never
read by a creator or a player. The deterministic skeleton is not a new state
machine; it is the one Phase 1 froze.

Each live failure class, now checked as a property of the assembled value:

| Live failure (§6) | Now |
|---|---|
| `NAMESPACE_INVALID` | every declared id of all three kinds is `core.`-prefixed by construction; an ending id is asserted never to be an action, variable, or dialogue id |
| `VARIABLE_NEVER_READ` / `VARIABLE_NEVER_WRITTEN` | all three variables are asserted both written by an effect and read by a condition |
| required action disabled by `{kind: never}` | no code path can produce it; asserted for all six |
| `AMBIGUOUS_BRANCH` | exactly one branch per action, asserted |
| ending ids used as dialogue ids | asserted impossible |
| `NO_PROGRESS` | every nonterminal action is asserted to write a previously-false variable, and the real graph layer agrees |

Plus: the contract rejects twelve named mechanical fields and every extra,
missing, or empty copy field; a brief with a different room, character, object,
role, and tone produces a structurally identical skeleton with different
targets, speaker, and copy, and validates through the unchanged validator; the
base input hash does not move when approvals change while the module keys do;
and copy failures that *can* still happen — a control character, a forbidden
phrase — are rejected and repaired with a payload that carries no mechanic.

### 12.7 The offline gate at `62aaca9`

Run from a clean tree, with `.next` deleted first.

| Command | Result |
|---|---|
| `npm run typecheck` | passed, exit 0 |
| `npm test` | passed, exit 0 — **30 files, 605 tests**, 0 failures |
| `npm run test:e2e` | passed, exit 0 — **46** Playwright tests, 0 failures |
| `npm run check:fixtures` | passed, exit 0 |
| `npm run build` | passed, exit 0 |
| `npm run check:secrets` | passed, exit 0 — 165 tracked, 332 built files scanned |

605 tests against 578 at `67a565a`: 29 new in `compile-base.test.ts`, and two
net removals where a base rejection test was replaced by an
unrepresentability assertion that is strictly stronger.

### 12.8 Why the live gate is still open: the model-call budget

Read live from `public.budget_buckets` before any compile was started, at
**2026-10-04 13:20 UTC**:

| Fact | Observed |
|---|---|
| `model_calls.used_calls` | **31** of **40** |
| `model_calls.used_tokens` | 129,089 |
| Window | 2026-10-04 00:00 UTC → **2026-10-05 00:00 UTC** |
| Calls remaining in the window | **9** |
| `qloo_calls.used_calls` | 5, unchanged |

**The window had not reset.** What the remaining live gate needs, at its
*zero-repair* minimum, under the amended architecture:

| Gate | Minimum calls |
|---|---|
| One-influence acceptance (fresh project: proposal + base + Discovery) | 3 |
| Two-influence acceptance (fresh project: proposal + base + Discovery + Commitment) | 4 |
| Base-reuse check (one slot recompiles) | 1 |
| Live stale/CAS check (disposable project: proposal + base, then rebuild) | 2–3 |
| Deployed verification (fresh project through the production build) | 3–4 |
| **Total** | **13–15**, and roughly double in the worst case with one repair per model stage |

Nine does not fit, and does not nearly fit. Starting section A alone would
spend three calls and still leave the gate unreachable, so no live compilation
was started. The cap was **not** raised, the accounting was **not** bypassed,
no other key, provider, or model was used, and no speculative compile was run.

**Offline recovery complete; waiting for model budget reset.** The window
resets at 2026-10-05 00:00 UTC.

### 12.9 One live probe that cost no model call, and a real finding

§4 recorded that the `scene_versions_validation_passed` constraint was unproven
against live Postgres because the §K probes need a version row. The *negative*
probe does not: a deliberately invalid insert needs only a project id. It was
run against the live database inside a `DO` block whose final `raise` aborted
the whole statement, so **nothing was committed** — `scene_versions` is still
**0 rows**, and `pending_version_id` and `active_version_id` are null on all 29
projects, confirmed afterwards.

| Probe `validation_summary` | Result |
|---|---|
| `{"ok": false, "subsets": [], "witnesses": []}` | **refused**, `23514`, `scene_versions_validation_passed` |
| `{"ok": true, "witnesses": []}` (no `subsets`) | **refused**, `23514`, same constraint |
| `{"ok": true, "subsets": []}` (no `witnesses`) | **refused**, `23514`, same constraint |
| `{"subsets": [], "witnesses": []}` (no `ok`) | **refused**, `23514`, same constraint |
| `{"ok": "true", "subsets": [], "witnesses": []}` | **ACCEPTED** |
| `approval_snapshot` as a JSON object | **refused**, `23514`, `scene_versions_approval_snapshot_is_array` |

**The constraint is live and it works, with one narrow gap.** It is written
`((validation_summary ->> 'ok')::boolean IS TRUE)`. `->>` yields *text*, so the
JSON **string** `"true"` casts to boolean true and passes, as would `"t"`,
`"yes"`, `"on"`, and `"1"`. A comparison on the JSON value itself —
`validation_summary -> 'ok' = 'true'::jsonb` — would not admit them.

How much this matters, stated honestly:

- **It is not reachable from this application.** Every insert goes through
  `commit_scene_version` with a `ValidationSummaryView`, whose `ok` is a Zod
  `boolean` and therefore always a JSON boolean. There is no code path that
  could produce the string form.
- **It is still a weaker database guarantee than the migration intends**, and
  the migration's stated intent is that "only validated versions are inserted"
  is a database guarantee rather than a convention.
- **It was not fixed here.** Fixing it means a second forward migration applied
  to live DDL, which is outside this narrowly-scoped amendment, and
  `docs/PHASE4_LOCAL_HANDOFF.md` §E forbids editing the existing migration
  file. It is recorded as limitation §13.4 for an explicit decision.

The row-level immutability trigger remains unexercised live, because that probe
genuinely needs a committed version row and none exists. No valid-looking row
was inserted to create one: fabricating a `scene_versions` row would corrupt
the evidence table this document reports on.

### 12.10 Gate status after the amendment

| Phase 4 gate (handoff §Q) | Result |
|---|---|
| 1. Offline gate green locally | **PASS** (§12.7) |
| 2. `20261004160000` applied and verified live | **PASS** (§4) |
| 3. Fresh brief, **one** real approved influence, playable scene | **NOT RUN** — budget (§12.8) |
| 4. Fresh brief, **two** real approved influences, playable scene | **NOT RUN** — budget (§12.8) |
| 5. No pending/rejected/other-slot evidence entered a module prompt | **PASS**, offline sentinels; not contradicted live |
| 6. Mechanical witness per active module, stored on the version | **NOT RUN** — needs gate 3 |
| 7. Every supported removal subset validates, stored on the version | **NOT RUN** — needs gate 3 |
| 8. A live stale result cannot activate; previous version survives failure | **PARTIAL** (§8), unchanged |
| 9. Repair never exceeded its ceiling — no stage with `attempts > 2` | **PASS** (§6), unchanged |
| 10. Deployed application satisfies every box of handoff §O | **NOT RUN** (§9) |
| 11. Evidence records the real numbers, including every failure | **PASS** — this document |

**Phase 4 therefore still fails its gate, and Phase 5 is not authorized.**

The honest one-line summary of this session: *the architecture was changed in
response to measured live reliability evidence, the change is complete and
fully covered offline, and not one live compilation was run against it, because
the configured budget for the window could not hold the gate.* The first
architecture did not succeed, and nothing here should be read as saying it did.

---

## 13. Known limitations, after the amendment

Limitations 1, 2, 4, 5, 6, 7, and 8 of §11 stand as written, with these
changes.

1. **§11.1 stands.** No fresh scene has ever been compiled. This is still the
   Phase 4 gate and it is still not met. The reason has changed: it is no
   longer the architecture, it is the budget window.
2. **§11.2 is addressed, but not yet proven live.** The base stage's
   reliability was the open question, and the deterministic skeleton removes
   the whole measured failure class *by construction* — proven offline against
   the real validator and the real Phase 1 fixture, and **not yet observed
   against the real provider.** The remaining base-stage risk is now copy-only:
   a forbidden phrase, a text bound, a refusal, or truncation. That is a
   smaller and better-understood surface, and it is an expectation until a live
   run confirms it.
3. **§11.3 is resolved.** The design question is decided and implemented
   (§12.1). The `validateScene`-skips-graph-analysis interaction noted
   alongside it is unchanged and still true; it simply no longer has base
   mechanics to interact with.
4. ~~**New: `scene_versions_validation_passed` admits a JSON string
   `"true"`**~~ — **resolved by §14.** The forward migration
   `20261004173000_phase4_validation_boolean.sql` replaces the constraint with
   a jsonb value comparison, and it is applied and live-proven in both
   directions (§14.3).
5. **The deterministic skeleton is now a single point of failure for the base,
   in exchange for removing a probabilistic one.** If it is wrong, it is wrong
   for every brief, every time, rather than occasionally. That is the trade
   being made deliberately, and it is why the amendment is covered by 29
   structural tests and by an exact comparison against the authoritative
   Phase 1 fixture rather than by a smoke run.
6. **The three base variable labels are server constants**, so they no longer
   echo the brief's own object the way the hand-authored fixture's did
   ("Object inspected", not "Letter inspected"). All three are
   `visible: false`, so no creator and no player ever reads one.

---

## 14. Database constraint hardening — the §12.9 defect, fixed and live-proven

**Date:** 4 October 2026, same day, same branch, immediately after §12.
**Status:** **fixed and verified live. Zero model calls spent.** Phase 4 is
still incomplete.

This section closes limitation §13.4. Sections 1–13 are preserved unchanged.

### 14.1 The defect

`20261004160000_phase4_compilation.sql` wrote the validated-version guard as:

```sql
(validation_summary ->> 'ok')::boolean is true
```

`->>` extracts the value as **text**, and `text::boolean` accepts every
spelling PostgreSQL's boolean input function accepts. A row whose
`validation_summary.ok` was the JSON *string* `"true"` — or `"t"`, `"yes"`,
`"on"`, `"1"` — therefore satisfied a constraint whose whole purpose is to make
"only validated versions are inserted" a **database** guarantee rather than a
convention. §12.9 found it by probing the live database.

Two honest qualifications, unchanged from §12.9:

- **It was never reachable from this application.** Every insert goes through
  `commit_scene_version` with a `ValidationSummaryView`, whose `ok` is a Zod
  boolean and therefore always a JSON boolean.
- **`scene_versions` was empty**, so no stored row ever relied on the weak
  form, and the replacement could not fail on existing data.

Why the offline suite did not catch it: `tests/server/support/memory-gateway.ts`
— the offline stand-in for the committed SQL — used `summary.ok !== true`, a
strict identity check, and was therefore **stricter than the database it
re-implements**. The divergence was the defect, not the strictness. Both sides
are now pinned to the same matrix (§14.4).

### 14.2 The forward migration

One new file. `20261004160000_phase4_compilation.sql` was **not** edited and
still carries its original text, so the history says what was applied and when
it was corrected; `tests/server/migrations.test.ts` asserts that too.

**`supabase/migrations/20261004173000_phase4_validation_boolean.sql`**

```sql
alter table public.scene_versions
  drop constraint scene_versions_validation_passed;

alter table public.scene_versions
  add constraint scene_versions_validation_passed
  check (
    validation_summary ? 'ok'
    and jsonb_typeof(validation_summary -> 'ok') = 'boolean'
    and (validation_summary -> 'ok') = 'true'::jsonb
    and validation_summary ? 'subsets'
    and validation_summary ? 'witnesses'
  );
```

Three deliberate choices:

1. **`validation_summary ? 'ok'` comes first, and it is load-bearing.** A check
   constraint **accepts** a NULL expression. Without this conjunct, a summary
   with no `ok` key would make `jsonb_typeof(...)` return NULL, the conjunction
   would be NULL, and the row would pass. The old constraint avoided that by
   accident, because `IS TRUE` is false for NULL rather than NULL.
   `validation_summary` is `not null`, so with this conjunct the expression is
   total.
2. **`jsonb_typeof(...) = 'boolean'`** states the type requirement explicitly,
   so a reader of the live catalog sees that it is part of the contract.
3. **`(validation_summary -> 'ok') = 'true'::jsonb`** is the decision. It is a
   jsonb equality against a folded literal, so **no text parsing happens at any
   point**. `'"true"'::jsonb` is a different value and does not match. No
   `->>` and no `::boolean` survives anywhere in the final form.

It replaces one constraint and does nothing else: no column altered, no
function created or redefined, no table created or dropped, no policy added, no
grant moved.

### 14.3 Applied live, and proven live

Applied through the same already-authorised Supabase management connection that
Phases 2, 3, and 4 used. `supabase db push` was not attempted: the documented
`DbConfigIpv6Error` blocker (§4) still applies, and no token permission was
broadened, no database password was used or requested.

**The constraint, read back from `pg_constraint`:**

```
scene_versions_validation_passed
  CHECK (((validation_summary ? 'ok'::text)
     AND (jsonb_typeof((validation_summary -> 'ok'::text)) = 'boolean'::text)
     AND ((validation_summary -> 'ok'::text) = 'true'::jsonb)
     AND (validation_summary ? 'subsets'::text)
     AND (validation_summary ? 'witnesses'::text)))
```

**The probe matrix, re-run against real Postgres** inside a `DO` block whose
final `raise` aborted the whole statement, so nothing was committed:

| `validation_summary.ok` | Before | After |
|---|---|---|
| `true` (JSON boolean) | accepted | **accepted** |
| `"true"` (JSON string) | **ACCEPTED** | **refused**, `23514` |
| `"t"` | — | **refused**, `23514` |
| `"yes"` | — | **refused**, `23514` |
| `"on"` | — | **refused**, `23514` |
| `"1"` | — | **refused**, `23514` |
| `1` (JSON number) | — | **refused**, `23514` |
| `false` | refused | **refused**, `23514` |
| key absent | refused | **refused**, `23514` |
| `null` | — | **refused**, `23514` |
| `true` but no `subsets` | refused | **refused**, `23514` |
| `true` but no `witnesses` | refused | **refused**, `23514` |
| a realistic full `ValidationSummaryView` | — | **accepted** |

The one row that used to get through no longer does, and the shape this
application really produces still does.

**Catalog and data posture, after application:**

| Fact | Observed |
|---|---|
| Tables in `public` | **8** — no ninth |
| Tables with RLS enabled | **8** |
| Rows in `pg_policies` | **0** — deny-by-default unchanged |
| `public` functions | **20** — unchanged, none added or redefined |
| Table grants to `anon`, `authenticated`, or `PUBLIC` | **0** |
| Non-internal triggers on `scene_versions` | **1** — the immutability trigger, intact |
| `projects` / `influence_decisions` / `qloo_captures` | 29 / 14 / 6 — intact |
| `operations` / `sessions` / `publications` | 30 / 42 / **0** |
| `scene_versions` | **0** rows |
| `20261004160000` still recorded | **yes** |

**`model_calls.used_calls` is still 31 of 40, and `qloo_calls.used_calls` is
still 5** — identical to the §12.8 reading taken before this work began. That
is the direct evidence that **no OpenAI call and no Qloo call was spent on this
hardening.** The budget is preserved intact for the reset window, as instructed.

### 14.4 Offline regression coverage

`tests/server/migrations.test.ts` (static, on the committed SQL):

- the migration list now expects both Phase 4 files, in order;
- the validated-version guard test reads the **last** definition in migration
  order — `lastIndexOf`, not `indexOf` — so it cannot pass on a superseded
  form, and asserts all five conjuncts plus the **absence** of `->> 'ok'` and
  `::boolean` anywhere in the final form;
- a new test asserts the hardening migration changes nothing else: one table,
  one constraint dropped, one re-added, no column/function/table/policy/grant
  work, and the earlier migration still carrying its original text.

`tests/server/compile-versions.test.ts` gains a focused describe driving
`commitSceneVersion` once per shape, mirroring the live matrix exactly:

- a real boolean `true` with both reports is **accepted**;
- the JSON string `"true"` is **refused** — the exact value the live database
  used to admit;
- `"t"`, `"T"`, `"yes"`, `"y"`, `"on"`, `"1"`, `"TRUE"`, `"True"`, `1`, `1.0`
  are each **refused**;
- boolean `false`, and `"false"`, `"f"`, `"no"`, `"off"`, `"0"`, `0`, `null`
  are each **refused**;
- a summary with no `ok` key, and one with `ok: undefined`, are **refused** —
  the NULL-expression case §14.2 explains;
- `ok: true` missing either report is still **refused**;
- a non-object summary (`null`, a string, a boolean, a number, an array) is
  **refused**;
- and the `validation_summary` taken off a version a **real two-module
  compilation committed** — the genuine `ValidationSummaryView` with its subset
  reports and mechanical witness — is **accepted**, so the hardening rejects
  nothing this application produces.

### 14.5 The offline gate at `fcac34a`

Run from a clean tree with `.next` deleted first.

| Command | Result |
|---|---|
| `npm run typecheck` | passed, exit 0 |
| `npm test` | passed, exit 0 — **30 files, 614 tests**, 0 failures |
| `npm run test:e2e` | passed, exit 0 — **46** Playwright tests, 0 failures |
| `npm run check:fixtures` | passed, exit 0 |
| `npm run build` | passed, exit 0 |
| `npm run check:secrets` | passed, exit 0 |

614 against 605 at `62aaca9`: nine new, eight in `compile-versions.test.ts` and
one in `migrations.test.ts`.

### 14.6 The commits

| Commit | Message |
|---|---|
| `9e88b1f` | `fix: enforce boolean validation status in scene versions` |
| `fcac34a` | `test: cover scene version validation constraint types` |

### 14.7 Migration-history bookkeeping — reconciled and verified

**Resolved.** The committed files and the remote migration history now agree.

The management connection records its own timestamp for an applied migration
and had stamped this one `20261004135243`, which both disagreed with the
committed filename and sorted *before* `20261004160000`. Phase 4's own
application hit the same thing and resolved it the same way (§4): the history
row was set to the version its filename declares. The committed filename was
deliberately **not** renamed to match the temporary stamp, because a fresh
database replaying the files in `20261004135243` order would have tried to drop
a constraint that did not exist yet.

The correction was applied outside this session and then verified here against
the live history table:

| Check | Observed |
|---|---|
| `20261004160000` / `phase4_compilation` present | **yes**, exactly 1 row |
| `20261004173000` / `phase4_validation_boolean` present | **yes**, exactly 1 row |
| Rows at the temporary `20261004135243` | **0** — no longer present |
| Rows named `phase4_validation_boolean` | **1** — no duplicate was left behind |
| Total migration rows | **5**, matching the five committed files |

```
20261003222350  phase2_schema
20261003222456  phase2_atomic_functions
20261004085412  phase3_qloo
20261004160000  phase4_compilation
20261004173000  phase4_validation_boolean
```

The order is now the committed order, so a replay from the files and the
applied history describe the same database.

**Re-verified at the same time, all unchanged:** the hardened constraint is
still live, read back from `pg_constraint` as

```
CHECK (((validation_summary ? 'ok'::text)
   AND (jsonb_typeof((validation_summary -> 'ok'::text)) = 'boolean'::text)
   AND ((validation_summary -> 'ok'::text) = 'true'::jsonb)
   AND (validation_summary ? 'subsets'::text)
   AND (validation_summary ? 'witnesses'::text)))
```

and the posture and data are exactly as §14.3 recorded them: **8** tables, **8**
with RLS, **0** policies, **20** functions, **0** table grants to `anon`,
`authenticated`, or `PUBLIC`, **1** non-internal trigger on `scene_versions`,
**0** `scene_versions` rows, **0** publications, and 29 projects / 14 decisions
/ 6 captures / 30 operations / 42 sessions intact.

`model_calls.used_calls` is **31 of 40** and `used_tokens` is **129,089**, and
`qloo_calls.used_calls` is **5** — byte-identical to the §12.8 reading taken
before any of this work began. **No OpenAI call and no Qloo call has been spent
since.** The budget remains intact for the reset window.

### 14.8 Phase 4 is still incomplete

Nothing in this section moves the live acceptance gate. It closes a database
integrity gap that §12.9 discovered; it compiles nothing.

The gate table of §12.10 stands unchanged: gates 3, 4, 6, 7, and 10 are **NOT
RUN**, blocked on the model-call budget window, which resets at **2026-10-05
00:00 UTC**. `scene_versions` still has **0 rows**. **Phase 5 remains
unauthorized.**

What §14 does change is gate coverage that was previously honest-but-unproven:
the `scene_versions_validation_passed` half of the handoff's §K probes is now
**exercised against live Postgres**, in both directions. The row-level
immutability trigger remains unexercised, because that probe genuinely needs a
committed version row and creating a fake one would corrupt the evidence table
this document reports on.

---

## 15. Known limitations, after the constraint hardening

Section 13 stands, with §13.4 now **resolved** by §14. The migration-history
bookkeeping item raised when §14 was written is **also resolved and verified**
(§14.7), so it is no longer a limitation. Nothing new was added.

The open items that still block Phase 4 are therefore unchanged from §13: no
fresh scene has ever been compiled (§13.1), the deterministic base's
reliability is proven offline but not yet observed against the real provider
(§13.2), the row-level immutability trigger is still unexercised because that
probe needs a committed version row, and the live stale-result compare-and-swap
is still unexercised for the same reason.
