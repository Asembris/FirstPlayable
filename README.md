# FirstPlayable

> Choose the influences. Play the consequences.

A playable-pitch studio. The authoritative specification is
[`docs/FIRSTPLAYABLE_BUILD_SPEC.md`](docs/FIRSTPLAYABLE_BUILD_SPEC.md); the
build state and verification record is
[`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md), the external-account evidence
is [`docs/DEPLOYMENT_PREFLIGHT.md`](docs/DEPLOYMENT_PREFLIGHT.md), and the Qloo
and influence-approval evidence is
[`docs/PHASE3_QLOO_EVIDENCE.md`](docs/PHASE3_QLOO_EVIDENCE.md).

**Phases 1, 2 and 3 are complete.** This repository contains the shared scene
contract, the pure deterministic scene engine, hand-authored design fixtures,
one offline vertical slice at `/example`, a persistent owner-scoped application
shell on Supabase Postgres deployed on Vercel, and the real cultural-influence
workflow: a creator searches for an artist, confirms the identity explicitly,
retrieves real Qloo movie and videogame references, reads bounded
model-proposed interactions, and approves, edits, dismisses, or replaces them.

The chain a creator can inspect is **Qloo retrieved → FirstPlayable proposed →
Creator approved**. The fourth step, *Scene changed*, belongs to Phase 4; the
provenance type has no field for it, so nothing can claim a mechanical
consequence that no compiler produced.

**Not built yet, and not claimed:** scene compilation, module generation, scene
activation, revision, publication, offline HTML export, and the model-selected
comparator. There are no compiled scene versions and no publications in the
database.

**Not claimed about Qloo:** that it recommended a mechanic, rated a reference,
or knows a creator's taste. Returned affinity is kept private and is never
shown as creative confidence. The influence isolation guarantee is dataflow and
ownership isolation, not a claim about what a language model could
independently invent.

Running the engine, `/example`, the unit tests, the browser tests, and the
production build requires **no account, no credential, and no network access**.
Only the persistent studio and the opt-in live commands need configuration.

## Requirements

Node `22.22.0` (see `.nvmrc`; `engines` requires `>=22.12.0`). Dependencies are
pinned exactly in `package.json` and locked by `package-lock.json`.

Copy [`.env.example`](.env.example) to `.env` for the persistent studio. Every
variable there is **server only**: there is no `NEXT_PUBLIC_` variable in this
repository and the browser never connects to Supabase directly.

| Variable | Needed for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | the persistent studio and `npm run smoke:supabase` |
| `SUPABASE_ACCESS_TOKEN` | the Supabase CLI only; never read by the application |
| `QLOO_API_KEY`, `QLOO_API_BASE_URL` | artist search and the two first-hop reference requests |
| `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL` | the bounded proposal stage |
| `QLOO_*` safety knobs (optional) | tighten the launch gap, the lease ceiling, or the local allowance |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local development server (`/example` plays with no configuration). |
| `npm run build` | Production build. Needs no database. |
| `npm start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit` over the whole repository. |
| `npm test` | Vitest: contracts, engine, sessions, ownership, route security, operations, budgets, model adapter, Qloo normalization and transport, cache and launch policy, the proposal boundary, creator decisions, influence isolation, secrets. Offline. |
| `npm run test:e2e` | Playwright: play, reset, version switch, the honest database-outage state, and the whole influence-approval workflow. Offline. |
| `npx playwright install chromium` | One-time browser download needed before the first `test:e2e` run. |
| `npm run check:fixtures` | Validate every fixture and print the canonical Phase 1 evidence. |
| `npm run check:secrets` | Scan tracked files and built assets for credential shapes. Run after `npm run build`. |

### Opt-in commands that contact real services

Each refuses to run without its guard, and none is a dependency of `npm test`
or `npm run build`.

| Command | Guard |
|---|---|
| `npm run smoke:supabase` | `RUN_SUPABASE_SMOKE=1` |
| `npm run smoke:openai` | `RUN_OPENAI_SMOKE=1` — spends real tokens on one tiny call |
| `npm run smoke:qloo` | `RUN_QLOO_SMOKE=1` — three real Qloo calls when uncached, zero when cached. `QLOO_SMOKE_ARTIST` picks the artist. |
| `npm run smoke:proposal` | `RUN_PROPOSAL_SMOKE=1` — one real model call, and one real approval through the application path |
| `npm run verify:deployment` | `RUN_DEPLOY_VERIFY=1` and `DEPLOY_URL=https://…` |

A normal uncached creation costs **three** Qloo calls: one search and two first
hops. Repeating a supported retrieval costs **zero**. Neither smoke is looped,
and the proposal smoke is never re-rolled because its prose reads weakly.

## Layout

```text
src/domain/           Zod contracts for the brief, the scene, and the project
src/engine/           pure interpreter, composer, validator, diff, canonical hashing
src/components/player trusted React player for the offline slice
src/components/studio  the studio: brief, artist confirmation, reference rows, provenance
src/app/              Next.js App Router pages and the eight API routes
src/server/db/        owner-scoped repositories and the one server-only Supabase client
src/server/security/  sessions, origin checks, body caps, error redaction
src/server/model/     the pinned OpenAI Structured Outputs adapter
src/server/qloo/      the three-operation adapter, normalization, cache, launch limiter
src/server/influence/ the context firewall, the proposal stage, approvals, provenance
src/server/api/       route handlers, testable as plain Request handlers
supabase/migrations/  the eight tables, their access posture, and the atomic functions
fixtures/             hand-authored design fixtures, and redacted real Qloo captures
scripts/              fixture verification, secret scan, opt-in live smoke commands
tests/                Vitest suites and the Playwright suite
docs/                 specification, build status, deployment preflight
```

The engine under `src/engine/` and the contracts under `src/domain/` have no
React, Next.js, or server dependency, and read no configuration. The browser
player, the tests, the validator, and the fixture script all execute that same
implementation.

## Ownership, and what it does not promise

A project is owned by one anonymous session held in an `HttpOnly` cookie. There
is no account, no password, and no recovery: **losing that cookie loses editing
access.** Only a hash of the cookie's secret is stored. Published links and
account recovery are not part of Phase 3.

The browser never calls Qloo, OpenAI, or Supabase. Every external request is
made server-side, behind this application's own owner-scoped routes, and no
`NEXT_PUBLIC_` variant of any credential exists.

## Licence

MIT. See [`LICENSE`](LICENSE).
