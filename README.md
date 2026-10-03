# FirstPlayable

> Choose the influences. Play the consequences.

A playable-pitch studio. The authoritative specification is
[`docs/FIRSTPLAYABLE_BUILD_SPEC.md`](docs/FIRSTPLAYABLE_BUILD_SPEC.md); the
build state and verification record is
[`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md), and the external-account
evidence is [`docs/DEPLOYMENT_PREFLIGHT.md`](docs/DEPLOYMENT_PREFLIGHT.md).

**Phases 1 and 2 are complete.** This repository contains the shared scene
contract, the pure deterministic scene engine, hand-authored design fixtures,
one offline vertical slice at `/example`, and a persistent owner-scoped
application shell on Supabase Postgres with a deployed build on Vercel.

**Not built yet, and not claimed:** Qloo retrieval, cultural proposal
generation, influence approval, scene compilation, revision, publication,
offline HTML export, and the model-selected comparator. The only model code is
a pinned `gpt-4o-mini-2024-07-18` Structured Outputs adapter behind one
opt-in smoke command; no deployed route calls a model.

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
| `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL` | `npm run smoke:openai` only |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local development server (`/example` plays with no configuration). |
| `npm run build` | Production build. Needs no database. |
| `npm start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit` over the whole repository. |
| `npm test` | Vitest: contracts, engine, sessions, ownership, route security, operations, budgets, model adapter, secrets. Offline. |
| `npm run test:e2e` | Playwright: play, reset, version switch, and the honest database-outage state. Offline. |
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
| `npm run verify:deployment` | `RUN_DEPLOY_VERIFY=1` and `DEPLOY_URL=https://…` |

## Layout

```text
src/domain/           Zod contracts for the brief, the scene, and the project
src/engine/           pure interpreter, composer, validator, diff, canonical hashing
src/components/player trusted React player for the offline slice
src/components/studio  minimal persistent studio shell
src/app/              Next.js App Router pages and the three Phase 2 API routes
src/server/db/        owner-scoped repositories and the one server-only Supabase client
src/server/security/  sessions, origin checks, body caps, error redaction
src/server/model/     the pinned OpenAI Structured Outputs adapter
src/server/api/       route handlers, testable as plain Request handlers
supabase/migrations/  the eight tables, their access posture, and the atomic functions
fixtures/             hand-authored "The Second Copy" design fixtures
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
account recovery are not part of Phase 2.

## Licence

MIT. See [`LICENSE`](LICENSE).
