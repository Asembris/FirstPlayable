<div align="center">

<img src="docs/readme/mark.svg" alt="" width="72" height="72" />

# FirstPlayable

*Choose the influences. Play the consequences.*

<a href="https://firstplayable.vercel.app/difference"><img src="docs/readme/hero.svg" width="100%" alt="A saved comparison from a real FirstPlayable build. Qloo returned the film Moon; FirstPlayable proposed an interpretation; the creator edited and approved it. After the same two choices, in the same room with the same Nia and the same letter, Return the letter is open without the influence and locked with it, and Moon adds two choices: Ask Nia who the other name belongs to, and Examine the envelope closely. 3 changed, 3 unchanged." /></a>

[![Live product](https://img.shields.io/badge/Live_product-141518?style=for-the-badge)](https://firstplayable.vercel.app)
[![Play the difference](https://img.shields.io/badge/%E2%96%B6_Play_the_difference-B0154C?style=for-the-badge)](https://firstplayable.vercel.app/difference)
[![Create your scene](https://img.shields.io/badge/Create_your_scene-3A3D43?style=for-the-badge)](https://firstplayable.vercel.app/studio)
[![Qloo Agentic Hackathon](https://img.shields.io/badge/Qloo_Agentic_Hackathon-6B6E75?style=for-the-badge)](https://qloo.devpost.com/)

[![Production](https://img.shields.io/badge/production-firstplayable.vercel.app-141518?logo=vercel&logoColor=white)](https://firstplayable.vercel.app)
[![Unit tests](https://img.shields.io/badge/unit_tests-761_passing-2F6F44)](#commands)
[![Browser tests](https://img.shields.io/badge/browser_tests-133_passing-2F6F44)](#commands)
[![CI](https://github.com/Asembris/FirstPlayable/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Asembris/FirstPlayable/actions/workflows/ci.yml)
[![Node 22.22](https://img.shields.io/badge/node-22.22-3A3D43?logo=nodedotjs&logoColor=white)](.nvmrc)
[![License: MIT](https://img.shields.io/badge/license-MIT-6B6E75)](LICENSE)

</div>

**FirstPlayable turns one cultural influence you approve into a playable
scene, then lets you play it with and without that influence and see exactly
which choices it changed.**

Every influence is traced in one order: **Qloo returned** a reference →
**FirstPlayable proposed** an interpretation → **the creator approved** it, as
proposed or after editing → **the build changed**. Qloo supplies the
reference, never the mechanic, and the last step is drawn only from what the
scene engine observed on the stored version.

## At a glance

| | |
|---|---|
| **Live product** | [firstplayable.vercel.app](https://firstplayable.vercel.app) — no sign-in |
| **Fastest proof** | [`/difference`](https://firstplayable.vercel.app/difference): a saved, real build played with and without one approved Qloo influence |
| **Frozen production commit** | [`f15ed67`](https://github.com/Asembris/FirstPlayable/commit/f15ed67dc7557ff5c2a4dc9e64776c5b310aa14c) |
| **Deployed verifier against production** | **118 / 118** checks pass |
| **Offline gates** | **761** unit tests and **133** browser tests pass; CI runs with no secrets |
| **Status** | Feature-complete through Phase 6; production is frozen for submission |

## What FirstPlayable is

A small creative tool for pitching interactive scenes. A creator writes a
one-room brief, names an artist, and picks which of the artist's cultural
neighbours — real films and videogames returned by Qloo — should shape the
scene. FirstPlayable compiles only the approved influences into a validated,
deterministic, playable scene.

The product's one claim is narrow and checkable: **this approved influence
changed these choices in this scene.** The engine proves it by playing the
same choices with and without the influence and reporting what differs.

## Why Qloo is load-bearing

**Qloo does not generate mechanics.** The division of labour is fixed:

| Step | Who | What they contribute |
|---|---|---|
| **Retrieve** | Qloo | The confirmed artist, and real movie and videogame references with their descriptive evidence |
| **Interpret** | FirstPlayable (model, bounded) | One proposed idea per reference, citing only evidence Qloo returned |
| **Decide** | The creator | Approve, edit, dismiss, or replace. Nothing is approved by default |
| **Compile** | FirstPlayable (model-selected, server-wired) | One module in the approved influence's own slot |
| **Verify** | Deterministic engine | A mechanical witness: what the influence changed, observed by replay |
| **Activate** | The creator | Nothing becomes current until they confirm it |

Removing Qloo would not leave a smaller version of the same product. It would
remove the part a creator can check:

- **The references stop being real.** A model asked for "films like this
  artist" returns recall that nobody retrieved and nobody can audit. Qloo's
  references are stored captures with entity ids and timestamps.
- **The evidence chain breaks.** An approval must cite evidence ids that
  resolve inside the stored Qloo capture; the compiler payload refuses to
  build otherwise. Without a capture there is nothing to cite.
- **The cross-domain step disappears.** The creator starts from music and
  receives film and game references. That adjacency is Qloo's, not the
  model's.
- **Provenance loses its first layer.** "Qloo returned" is the root of every
  chain the creator and the judge can inspect.

What is **not** claimed: that Qloo recommended a mechanic, rated a reference,
knows a creator's taste, or produced an idea a language model could not
otherwise invent. Qloo's returned affinity is kept private and is never shown
as creative confidence.

## Judge demo path

About a minute, no account, nothing generated live.

| # | Do this | What it shows |
|---|---|---|
| 1 | Open [the landing page](https://firstplayable.vercel.app) and press **Play the difference** | A saved example, labelled as generated from a real build |
| 2 | Watch the scene open at the recorded point, then split into **Compare** by itself | The same room, Nia, and letter after the same two choices: **3 changed, 3 unchanged** |
| 3 | Read the changed rows | Without Moon, *Return the letter* is open. With Moon, it is locked, and two new choices exist |
| 4 | Open a mark to read the causal note | The four stored layers: Qloo returned → proposed → creator approved → scene changed |
| 5 | Press **Continue without**, or play on with Moon | Both sides are fully playable; with Moon, both requirements unlock Return, which ends the scene |
| 6 | Go back and press **Create your scene** | The real path: brief → artist → influences → build → review. It makes live Qloo and model calls |

Keyboard: <kbd>P</kbd> / <kbd>C</kbd> switch Play and Compare, <kbd>W</kbd> /
<kbd>O</kbd> switch versions; single-key shortcuts can be turned off.

The saved example is bundled from the three stored rows in
[`docs/phase6-canonical-pair/`](docs/phase6-canonical-pair/), so it plays with
no database, model, or Qloo call. Its full record, including the two rejected
candidates, is [`docs/PHASE6_CANONICAL_PAIR.md`](docs/PHASE6_CANONICAL_PAIR.md).

## How it works

1. **Brief.** A one-room premise: a character, an object, and a fixed set of
   choices. It is frozen before anything is generated.
2. **Artist.** The creator searches Qloo and explicitly confirms one identity.
   The first search result is never assumed.
3. **References.** Two Qloo requests return movie and videogame neighbours of
   the confirmed artist. Each is normalized into evidence items and stored.
4. **Proposals.** One bounded model call proposes interpretations for up to
   six usable references. Each must cite only its own reference's evidence, or
   the whole set is rejected.
5. **Approval.** The creator approves, edits, dismisses, or replaces. At most
   one influence per slot: *Discovery* and *Commitment*.
6. **Build.** The server compiles a clean base and one module per approved
   influence, validates every candidate, and stores a version as *pending*.
7. **Review and activate.** The creator plays the pending version, sees what
   each influence was intended to do beside what the engine observed, and
   activates it — or does not.
8. **Revise, share, export.** Targeted revisions, read-only share links, and a
   one-file offline export, all described below.

A normal uncached creation costs **three** Qloo calls: one search and two
first-hop requests. Compilation, activation, and playthrough cost **zero**.

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
| `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL` | the bounded proposal stage and the base and module compilation stages |
| `QLOO_*` safety knobs (optional) | tighten the launch gap, the lease ceiling, or the local allowance |
| `MODEL_COST_CAP_MICROS` (optional) | lower the cumulative OpenAI spend cap below its compiled-in $0.60 |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local development server (`/example` plays with no configuration). |
| `npm run build` | Production build. Needs no database. |
| `npm start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit` over the whole repository. |
| `npm test` | Vitest: contracts, engine, sessions, ownership, route security, operations, the spend budget, model adapter, Qloo normalization and transport, cache and launch policy, the proposal boundary, creator decisions, influence isolation, the base and module compilers, the bounded controller, scene versions, the committed SQL surface, secrets. Offline. |
| `npm run test:e2e` | Playwright: play, reset, version switch, the honest database-outage state, the whole influence-approval workflow, and the build, review and activation flow. Offline. |
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
| `npm run smoke:compile` | `RUN_PHASE4_SMOKE=1` — the whole compilation acceptance through the real route handlers: around twelve real model calls, and real scene versions written |
| `npm run verify:deployment` | `RUN_DEPLOY_VERIFY=1` and `DEPLOY_URL=https://…` |

A normal uncached creation costs **three** Qloo calls: one search and two first
hops. Repeating a supported retrieval costs **zero**, and compilation,
activation and playthrough cost **zero** — measured, not assumed. No smoke is
looped, and neither the proposal nor the compile smoke is ever re-rolled
because its prose reads weakly.

Model spend is bounded by a hard **cumulative $0.60** cap held in one Postgres
row, enforced against an estimate computed from the usage the provider reports.
It does not reset: reaching it is an honest exhausted-budget state, never a
paid fallback, a second provider, or a different model.

## Layout

```text
src/domain/           Zod contracts for the brief, the scene, and the project
src/engine/           pure interpreter, composer, validator, diff, canonical hashing
src/components/player trusted React player for the offline slice
src/components/studio  the studio: brief, artist confirmation, reference rows, provenance, build and review
src/app/              Next.js App Router pages and the seventeen API routes
src/server/db/        owner-scoped repositories and the one server-only Supabase client
src/server/security/  sessions, origin checks, body caps, error redaction
src/server/model/     the pinned OpenAI Structured Outputs adapter
src/server/qloo/      the three-operation adapter, normalization, cache, launch limiter
src/server/influence/ the context firewall, the proposal stage, approvals, provenance
src/server/compile/   the isolated payload builders, both compilers, and the bounded controller
src/server/api/       route handlers, testable as plain Request handlers
supabase/migrations/  the eight tables, their access posture, and the atomic functions
fixtures/             hand-authored design fixtures, and redacted real Qloo captures
scripts/              fixture verification, secret scan, opt-in live smoke commands
tests/                Vitest suites and the Playwright suite
docs/                 specification, build status, deployment preflight, phase evidence
```

The engine under `src/engine/` and the contracts under `src/domain/` have no
React, Next.js, or server dependency, and read no configuration. The browser
player, the tests, the validator, and the fixture script all execute that same
implementation.

## Ownership, and what it does not promise

A project is owned by one anonymous session held in an `HttpOnly` cookie. There
is no account, no password, and no recovery: **losing that cookie loses editing
access.** Only a hash of the cookie's secret is stored. A compiled scene is
visible only to the browser that owns the project unless its owner publishes a
version: a share link reads that one version, read-only, and nothing else of
the project. There is no account recovery.

The browser never calls Qloo, OpenAI, or Supabase. Every external request is
made server-side, behind this application's own owner-scoped routes, and no
`NEXT_PUBLIC_` variant of any credential exists.

## Licence

MIT. See [`LICENSE`](LICENSE).
