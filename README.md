# FirstPlayable

> Choose the influences. Play the consequences.

A playable-pitch studio. The authoritative specification is
[`docs/FIRSTPLAYABLE_BUILD_SPEC.md`](docs/FIRSTPLAYABLE_BUILD_SPEC.md); the
current build state and verification record is
[`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md).

**Phase 1 only.** This repository currently contains the shared scene
contract, the pure deterministic scene engine, hand-authored design fixtures,
and one offline vertical slice at `/example`. There is no Qloo, OpenAI,
Supabase, authentication, or deployment integration in this phase, and no API
key or account is required to run anything here.

## Requirements

Node `22.22.0` (see `.nvmrc`; `engines` requires `>=22.12.0`). Dependencies are
pinned exactly in `package.json` and locked by `package-lock.json`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local development server (`/example` is the playable). |
| `npm run build` | Production build. |
| `npm start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit` over the whole repository. |
| `npm test` | Vitest: contracts, interpreter, validator, diff, fixtures. |
| `npm run test:e2e` | Playwright: play, reset, and version switch in a browser. |
| `npx playwright install chromium` | One-time browser download needed before the first `test:e2e` run. |
| `npm run check:fixtures` | Validate every fixture and print the canonical Phase 1 evidence. |

## Layout

```text
src/domain/       Zod contracts for the brief and the scene (types derived from Zod)
src/engine/       pure interpreter, composer, validator, diff, canonical hashing
src/components/   React player for the offline slice
src/app/          Next.js App Router pages (no API routes in Phase 1)
fixtures/         hand-authored "The Second Copy" design fixtures
scripts/          fixture verification
tests/engine/     Vitest suites
tests/browser/    Playwright suite
docs/             specification and build status
```

The engine under `src/engine/` has no React, Next.js, or server dependency.
The browser player, the tests, the validator, and the fixture script all
execute that same implementation.
