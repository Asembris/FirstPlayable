# Phase 4 — local acceptance handoff

**Status:** Phase 4 **cloud implementation complete**; overall Phase 4 is **not
complete**.
**Branch:** `feat/phase-4-compilation`
**Written by:** the Claude Cloud implementation session, 4 October 2026.
**Read by:** the next **local** Claude Code session on the same branch.

This document is the contract between the two halves of Phase 4. The cloud
session implemented everything that can be completed correctly without a
production credential; this document states exactly what remains, in the order
it has to happen, and what the final gate is.

Nothing in this file contains a secret, a key, a token, a password, or a
connection string, and no step below asks you to put one in a file that is
tracked by git.

---

## A. Branch and expected HEAD

```
git fetch origin
git switch feat/phase-4-compilation
git pull --ff-only
git log --oneline -1
```

The branch is based on the Phase 3 merge commit
`0c9820685c6ea72779cab20fea6535e645d06951` on `main`. The cloud session's
commits are listed in section B; the last of them is the expected HEAD when you
start. Continue committing the live-acceptance work to this **same** branch.

Before anything else, confirm the offline gate is green on your machine:

```
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run check:fixtures
npm run build
npm run check:secrets
```

All seven passed in the cloud session. If one fails locally, that is a real
finding — record it and fix it before any live work.

---

## B. Atomic cloud commits

In chronological order, oldest first:

| Commit | Message |
|---|---|
| `bfb64aa` | `feat: add phase 4 compilation contracts isolated payloads and scene assembly` |
| `03ff457` | `feat: add the phase 4 migration and compilation persistence primitives` |
| `e51b701` | `feat: add bounded base and influence module compilers with one repair` |
| `7be4700` | `feat: add the resumable persisted compilation controller` |
| `e4be799` | `feat: add the compile advance status and activation routes` |
| `c2ade89` | `feat: add the phase 4 review panel and local playable` |
| *(see `git log`)* | the browser gate and this documentation |

`git log --oneline main..HEAD` on the branch is authoritative; the table above
is a convenience.

---

## C. Migrations created and **NOT applied live**

One migration file. It has **not** been applied to the Supabase project, and no
Supabase management API call of any kind was made from the cloud session.

| Version | File | Applied live |
|---|---|---|
| `20261004160000` | `supabase/migrations/20261004160000_phase4_compilation.sql` | **NO** |

### What it changes

It is additive. It creates no table, drops no column, and rewrites no earlier
function's behaviour. The eight tables of specification section 11 remain the
whole schema.

1. **`operations.stage`** — the check constraint is swapped to admit one more
   value, `'compile'`, which is the persisted controller row that
   `POST /api/operations/:id/advance` addresses. This is the only `drop
   constraint` in the file, and `tests/server/migrations.test.ts` asserts that
   it is the only one.
2. **`projects`** gains:
   - `pending_version_id uuid` with a foreign key to `scene_versions(id)` and
     an index — a validated version awaiting the creator's explicit review,
     deliberately separate from `active_version_id`;
   - `compiled_modules jsonb not null default '{}'` with an object-type check
     and a 64 KiB bound — committed module artifacts keyed by slot, each
     carrying the stage input hash that authorised it.
3. **`scene_versions`** gains `input_snapshot jsonb`, `approval_snapshot
   jsonb`, `validator_identifier text`, `compiler_identifier text`, and
   `operation_id uuid`, plus two check constraints. The important one is
   `scene_versions_validation_passed`: a row is refused unless its
   `validation_summary` says `ok` **and** carries its `subsets` and
   `witnesses` reports. "Only validated versions are inserted" is therefore a
   database guarantee, not a convention.
4. **Seven new functions**, all `SECURITY INVOKER`, all with `set search_path =
   ''`, all granted to `service_role` only, all revoked from `public`, `anon`,
   and `authenticated`, and each one that names a project re-checking ownership
   itself:
   - `lease_compile_operation(uuid, uuid, integer)` — the controller row's
     row-locked mutex for one advance request. It spends no attempt and
     authorises no provider call, and it refuses any stage other than
     `'compile'`.
   - `park_operation(uuid, uuid, jsonb)` — releases a stage lease **without**
     settling it and stores a bounded artifact, which is how the one permitted
     repair stays inside the same `max_attempts = 2` ceiling.
   - `set_project_compilation_state(uuid, uuid, integer, jsonb, text, jsonb,
     text)` — writes the clean base, the compiled modules, and the workflow
     state under a revision compare-and-swap. It deliberately does **not**
     advance the revision.
   - `commit_scene_version(...)` — inserts one validated version and makes it
     the pending review, under a compare-and-swap on revision, base hash, and
     approval pointers. A stale result inserts nothing.
   - `activate_scene_version(uuid, uuid, integer, uuid)` — the creator's
     explicit activation, comparing the project against the snapshot stored on
     the version row itself.
   - `decline_scene_version(uuid, uuid, integer, uuid)` — clears the pending
     review and preserves the previously active version.
   - `read_scene_versions(uuid, uuid, uuid, integer)` — the owner-checked
     version read.

### How to apply and verify it locally

`supabase db push` did not work from the Phase 2 machine for two documented
reasons (IPv6-only direct host, and a scoped `SUPABASE_ACCESS_TOKEN` that
cannot read the pooler configuration) — see
`docs/DEPLOYMENT_PREFLIGHT.md` §2. Try it first; if those blockers persist,
apply the file verbatim through the already-authorised Supabase management
connection, exactly as Phases 2 and 3 were applied.

```
supabase link --project-ref <ref>          # already linked in earlier phases
supabase migration list                    # confirm 20261004160000 is NOT applied
supabase db push                           # or apply the file verbatim
```

Then verify against the live catalog, and record the output:

```sql
-- the new columns exist with the intended defaults
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('projects','pending_version_id'), ('projects','compiled_modules'),
    ('scene_versions','input_snapshot'), ('scene_versions','approval_snapshot'),
    ('scene_versions','validator_identifier'), ('scene_versions','compiler_identifier'),
    ('scene_versions','operation_id'))
order by table_name, column_name;

-- the compile stage is admitted
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'operations_stage_known';

-- the unvalidated-version guard exists
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'scene_versions_validation_passed';

-- the seven functions exist, and only service_role may execute them
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       array(select unnest(p.proacl)::text) as acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('lease_compile_operation','park_operation',
                    'set_project_compilation_state','commit_scene_version',
                    'activate_scene_version','decline_scene_version',
                    'read_scene_versions')
order by p.proname;

-- still exactly eight tables, still deny-by-default
select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;
select count(*) from pg_policies where schemaname='public';   -- must be 0
```

Also re-confirm the negative: `select count(*) from public.scene_versions;`
should be `0` before any live compilation, and the row count after should match
the number of validated versions you created.

Record all of this in `docs/PHASE4_EVIDENCE.md` (section P).

---

## D. Environment prerequisites already known

From `docs/DEPLOYMENT_PREFLIGHT.md` and `docs/PHASE3_QLOO_EVIDENCE.md`. Nothing
new is needed for Phase 4 except deploying the OpenAI key, which Phase 2
deliberately withheld.

| Variable | Where it must exist | Status entering Phase 4 |
|---|---|---|
| `SUPABASE_URL` | local `.env`, Vercel production + preview | configured |
| `SUPABASE_SECRET_KEY` | local `.env`, Vercel production + preview | configured |
| `SUPABASE_ACCESS_TOKEN` | local only, CLI and migrations | configured, scoped |
| `QLOO_API_KEY` | local `.env`, Vercel production + preview | configured |
| `QLOO_API_BASE_URL` | local `.env`, Vercel production + preview | configured |
| `OPENAI_API_KEY` | local `.env`, **and now Vercel production + preview** | local only |
| `OPENAI_CHAT_MODEL` | optional; must equal `gpt-4o-mini-2024-07-18` if set | — |

**Phase 4 is the phase that deploys `OPENAI_API_KEY`.** Phase 2 recorded that
it was deliberately not uploaded because no deployed route made a model call.
`POST /api/projects/:id/compile` and `POST /api/operations/:id/advance` now do,
so the key has to reach the Vercel runtime. Add it to Production and Preview as
an encrypted environment variable. Do **not** add any `NEXT_PUBLIC_` variant,
and re-run `npm run check:secrets` after the next build.

Budget settings that apply (all lowerable by configuration, never raisable):
`MODEL_DAILY_CALL_CAP` default 40, `MODEL_LEASE_SECONDS` default 120.

---

## E. Live migration application — the exact task

1. Confirm the offline gate is green (section A).
2. `supabase migration list` and record whether `20261004160000` is applied.
3. Apply it (section C).
4. Run the verification queries in section C and paste their real output into
   `docs/PHASE4_EVIDENCE.md`.
5. Confirm `npm test` still passes — `tests/server/migrations.test.ts` is a
   static check on the committed SQL and must stay green.

**Do not** edit the migration file to make an application attempt succeed. If
the file is wrong, add a second forward migration and say so.

---

## F. Real OpenAI compile smoke — the exact task

There is no new smoke script, and none is needed: the existing
`npm run smoke:openai` already proves the account, the pinned snapshot, and
Structured Outputs. What Phase 4 needs proven is that the **compilation
schemas** are accepted by the real provider, which the first real compilation
(section G) establishes directly.

Run the existing smoke first, so a failure in section G can be attributed:

```
RUN_OPENAI_SMOKE=1 npm run smoke:openai
```

Record: the model the provider reported, the observed input/output token
counts, and the labelled cost estimate. The command must report
`gpt-4o-mini-2024-07-18` and nothing else; a different model is a failure, not
a fallback.

If you want a compilation-schema-specific smoke, the honest way is to run
section G and record its stage-by-stage token usage from the budget bucket —
not to add a new script that bypasses the controller.

---

## G. Real single-approval fresh compilation — the exact task

Against the **local** dev server with real credentials, through the UI.

```
npm run dev
```

1. Create a fresh project with a brief that is **not** the saved example's.
   Write your own premise, room, character, and object.
2. Search for an artist (Radiohead, Taylor Swift, or Metallica), confirm one
   result explicitly, and retrieve both first hops.
3. Run the proposal stage and approve **exactly one** interaction.
4. Click **Build the playable scene** and let the panel drive the advances.
5. Record, for each advance: the stage, `model_calls`, whether `repaired` is
   true, and the stage status.
6. When the pending review appears, play it to each of the three endings, and
   record the "Where this appears" sentence verbatim.
7. Click **Yes — make this the active version**.
8. Reload the page and confirm the active version still plays.

**Expected:** three advances (base, `module_discovery` *or*
`module_commitment`, validate), two provider calls, one `scene_versions` row,
`workflow_state` `READY` after activation.

If a stage needs its one repair, that is a normal outcome: record it, with the
finding codes the repair was shown. Three attempts on one stage is a **bug** —
the database should have refused it.

---

## H. Real two-approval fresh compilation — the exact task

Same procedure, on a second fresh brief, approving **one Discovery and one
Commitment** interaction before building.

**Expected:** four advances (base, Discovery, Commitment, validate), three
provider calls, one `scene_versions` row with two entries in `module_hashes`,
two "Where this appears" sentences, and four subset reports in the stored
validation summary (`[]`, `["commitment"]`, `["discovery"]`,
`["discovery","commitment"]`), all `ok`.

Then, on this project, verify module reuse: approve a *replacement* for one
slot and build again. Only the replaced slot's module should be compiled — one
provider call, not three — because the brief-only base input hash and the other
slot's module input hash did not move. Record the observed call count.

---

## I. Expected provider-call counts

| Scenario | Expected OpenAI calls | Worst case with one repair per stage |
|---|---|---|
| Proposal stage (Phase 3) | 1 | 2 |
| One approval: base + one module | 2 | 4 |
| Two approvals: base + two modules | 3 | 6 |
| Validation stage | **0** | 0 |
| Activation | **0** | 0 |
| Declining a review | **0** | 0 |
| Reload / resume of a committed build | **0** | 0 |
| Rebuild after only one slot's approval changed | 1 | 2 |
| Complete playthrough, reset, replay | **0** | 0 |

Qloo calls during any compilation, activation, or playthrough: **0**, in every
row. If you observe one, that is a Phase 4 failure, not an optimisation
opportunity.

Read the real numbers out of the budget bucket rather than counting by hand:

```sql
select scope, bucket_key, call_limit, used_calls, used_tokens,
       reserved_calls, window_start, window_end
from public.budget_buckets order by updated_at desc limit 5;
```

---

## J. The actual compilation stages

The persisted controller row has `stage = 'compile'`; its `result` column holds
the checkpoint. The model stages each get their **own** `operations` row with
`max_attempts = 2`.

```
AWAITING_APPROVAL  →  BASE_READY  →  MODULES_READY  →  REVIEW_PLAYABLE  →  READY
                                   ↘ FAILED (previous READY preserved)
```

| Controller state | Next stage the controller will run | Provider calls |
|---|---|---|
| `AWAITING_APPROVAL` | `base` — "Writing encounter" | 1 |
| `BASE_READY` | `module_discovery` — "Building Discovery" | 1 |
| `BASE_READY` / after Discovery | `module_commitment` — "Building Commitment" | 1 |
| `MODULES_READY` | `validate` — "Checking choices" | **0** |
| `REVIEW_PLAYABLE` | none; awaits explicit activation | 0 |
| `FAILED` | none | 0 |

To see it live:

```sql
select id, stage, status, attempts, max_attempts, input_revision,
       lease_expires_at, jsonb_pretty(result) as checkpoint
from public.operations
where project_id = '<project id>'
order by created_at;
```

The `compile` row's checkpoint carries `snapshot`, `state`, `stages`,
`version_id`, `failure`, and `model_calls`. It contains **no** approved
wording, no evidence text, no owner session id, and no provider diagnostic,
because it is returned to the browser by `GET /api/operations/:id`. Confirm
that by eye.

---

## K. How to verify the SceneVersion rows

```sql
select id, project_id, parent_version_id, base_hash,
       jsonb_pretty(module_hashes)   as module_hashes,
       model_identifier, prompt_identifier, schema_identifier,
       compiler_identifier, validator_identifier,
       operation_id, created_at
from public.scene_versions
where project_id = '<project id>'
order by created_at desc;
```

Check every one of these:

- `model_identifier` is `gpt-4o-mini-2024-07-18`.
- `compiler_identifier` is `fp-compiler-4.0`, `prompt_identifier` is
  `fp-prompts-4.0`, `schema_identifier` is `fp-model-schema-4.0`,
  `validator_identifier` is `fp-engine-validator-1.0`.
- `module_hashes` has one 64-character hex entry per active slot.
- `operation_id` names the `compile` operation row that produced it.
- `input_snapshot -> 'project_revision'` equals the project revision the build
  was frozen at, and `input_snapshot -> 'approvals'` lists the approval ids.
- `approval_snapshot` carries the frozen approved wording **per version**, so a
  historical view does not change with today's approvals.

**Immutability:** confirm the row cannot be rewritten.

```sql
update public.scene_versions set base_hash = 'x' where id = '<version id>';
-- must raise: contents of public.scene_versions are immutable
```

**Only validated versions:** confirm the guard.

```sql
insert into public.scene_versions
  (project_id, input_hash, base_hash, scene, validation_summary)
values ('<project id>', 'x', 'y', '{}'::jsonb, '{"ok": false}'::jsonb);
-- must violate scene_versions_validation_passed
```

---

## L. How to verify the witnesses and subset reports

Both live inside `validation_summary` on the version row.

```sql
select jsonb_pretty(validation_summary -> 'subsets')  as subsets,
       jsonb_pretty(validation_summary -> 'witnesses') as witnesses,
       validation_summary -> 'reachable_endings'       as endings,
       validation_summary -> 'ok'                      as ok
from public.scene_versions where id = '<version id>';
```

Check:

- `ok` is `true`.
- `subsets` has 2 entries for a one-module version (`[]`, `[slot]`) and 4 for a
  two-module version, and **every** entry has `"ok": true`.
- `witnesses` has exactly one entry per active module, each with
  `"mechanical": true`, a non-empty `prefix`, and a `sentence`.
- `reachable_endings` is exactly `["end.give", "end.keep", "end.leave"]`.
- Each witness `sentence` reads as an observation — "`core.give` is locked with
  the discovery influence and enabled without it" — and claims nothing about
  quality, originality, or what produced the idea. Paste the real sentences
  into the evidence document; do not paraphrase them.

Then confirm the same thing from outside the database: the review screen's
"Where this appears" block renders those exact sentences.

---

## M. Live stale-result test

Safe to run, and worth running, because it exercises the compare-and-swap
against real Postgres rather than the in-memory gateway.

1. Start a build on a two-approval project and let the base commit.
2. Before advancing again, go back up the page and **remove** one approval.
3. Advance.

**Expected:** the panel shows a finished failed state with code `STALE_INPUT`
and the sentence "Your choices changed while this was being written, so this
older result was not applied." `scene_versions` gains **no** row, and
`projects.active_version_id` is unchanged.

A second variant, if you have an active version already: build, let it reach
the pending review, remove an approval, then press **Yes — make this the active
version**. The activation must be refused and the previous active version must
stay active. Record both outcomes.

---

## N. Vercel deployment

```
vercel env add OPENAI_API_KEY production      # encrypted; paste at the prompt
vercel env add OPENAI_API_KEY preview
vercel env ls                                  # confirm it reads "Hidden"
npm run build                                  # local build must pass first
npm run check:secrets                          # must pass after the build
vercel --prod
```

Confirm, and record:

- the production URL still serves `/` and `/example` anonymously;
- `vercel env ls` shows no `NEXT_PUBLIC_` variable of any kind;
- the deployed `/example` still plays with the database unreachable.

---

## O. Deployed Phase 4 verification checklist

Against the **production URL**, with real services. Every item is binary.

- [ ] A fresh brief can be created, an artist confirmed, references retrieved,
      proposals generated, and one interaction approved.
- [ ] **Build the playable scene** starts a compilation; the stage list
      advances through "Writing encounter", "Building Discovery" or "Building
      Commitment", and "Checking choices".
- [ ] One advance request performs at most one provider attempt. Confirm from
      `operations.attempts` and the budget bucket, not by inspection.
- [ ] Closing the tab mid-build does **not** continue the work; reopening the
      project offers **Resume the build** and resumes from the committed stage
      without repeating it.
- [ ] A pending validated scene appears and is playable in the browser.
- [ ] Nothing is active until **Yes — make this the active version** is
      clicked.
- [ ] After activation the fresh scene still plays, and survives a reload.
- [ ] A complete playthrough, an ending, and a reset make **zero** requests to
      `api.openai.com`, to the Qloo host, and to Supabase. Check the browser's
      network panel with the filter cleared.
- [ ] Both the two-approval and the one-approval paths produce a version whose
      every supported subset validates.
- [ ] Each active module has a mechanical witness, and the "Where this appears"
      sentence matches the stored witness.
- [ ] A declined review preserves the previous active version.
- [ ] A failed build preserves the previous active version and shows a finished
      recovery state naming it.
- [ ] A second browser (a private window) gets the same "not available here"
      screen and cannot compile, advance, or activate.
- [ ] No revision, share, publish, export, or compare control appears anywhere.
- [ ] `npm run check:secrets` passes against the built assets, and the
      deployed responses carry no key.

`npm run verify:deployment` already covers the Phase 2 and Phase 3 deployed
items. Extend it only if doing so needs no new credential; otherwise record the
Phase 4 items as the manual checklist they are.

---

## P. Documents to update after live evidence

1. **`docs/PHASE4_EVIDENCE.md`** — new. The live record: migration application
   output, the two fresh compilations with their real stage-by-stage call
   counts and token usage, the verbatim witness sentences, the SceneVersion row
   contents, the subset reports, the stale-result results, the deployment, and
   the deployed checklist with every box resolved. Include every failure you
   hit and what you did about it — not only the successes.
2. **`docs/BUILD_STATUS.md`** — replace the "Phase 4 cloud implementation"
   section's *Remaining local gates* list with the real results, and write the
   Phase 4 exit gate. Do not rewrite the Phase 1–3 history.
3. **`docs/DEPLOYMENT_PREFLIGHT.md`** — append the `OPENAI_API_KEY` deployment
   and the `20261004160000` migration to the environment and migration tables.
4. **`README.md`** — update the description and the layout section to say the
   studio compiles and activates a playable scene.
5. **`package.json`** — the `description` field still says "Phase 3".

---

## Q. The final Phase 4 binary gate

Phase 4 is complete when, and only when, **all** of these hold:

1. The offline gate is green locally: `typecheck`, `test`, `test:e2e`,
   `check:fixtures`, `build`, `check:secrets`.
2. `20261004160000_phase4_compilation.sql` is applied to the real Supabase
   project and verified against the live catalog.
3. A fresh brief with **one** real approved influence produces a playable scene
   through real Qloo and real OpenAI calls.
4. A fresh brief with **two** real approved influences also produces one.
5. No pending, rejected, or other-slot evidence entered a module prompt. The
   offline sentinel tests prove the dataflow; the live run must not contradict
   them.
6. Each active module has a computed mechanical witness, stored on the version.
7. Every supported removal subset validates, stored on the version.
8. A live stale result cannot activate, and the previous active version
   survives a failure.
9. Repair never exceeded its declared ceiling: no stage shows `attempts > 2`.
10. The deployed application satisfies every box in section O.
11. `docs/PHASE4_EVIDENCE.md` and `docs/BUILD_STATUS.md` record the real
    numbers, including every failure.

If any one of these fails, Phase 4 **fails**. Record it honestly, fix it, and
re-run the gate. Do not relax a validation rule, skip a subset, widen an
attempt budget, or substitute the saved example to make an item pass.

---

## R. Do not begin Phase 5

Phase 5 — targeted revision, immutable sharing, and offline export — is **not
authorized** and must not be started, not even partially, until Phase 4's gate
has passed and `docs/BUILD_STATUS.md` records it.

Specifically, do not add in this session: a `POST /api/projects/:id/revisions`
route, a remove/edit/replace revision command, an ending-copy override, a
version comparison beyond what reviewing one pending scene needs, a
common-choice replay between historical revisions, a publication, a read
token, a revocation, a public player route, an offline HTML export, or a
model-selected comparator. `tests/engine/fixtures.test.ts` asserts the route
surface and `tests/server/migrations.test.ts` asserts the function surface;
both will fail if a Phase 5 capability appears, and that failure is correct.
