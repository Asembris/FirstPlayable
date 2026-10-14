# Recorded Qloo evidence — audience comp audition

`recorded-2026-10-07.json` is **real Qloo evidence**. It is the one bounded
retrieval run behind the default `/audition` experience, captured on
7 October 2026 through the production client in `src/server/qloo/` and
normalized by the production normalizers in `src/server/qloo/audition.ts`.

This directory is deliberately separate from `fixtures/`. Everything under
`fixtures/qloo/` is **synthetic** — invented values written in Qloo's response
shapes, gated by `tests/engine/fixtures.test.ts` so that no real response can
land there unnoticed. Everything here is the opposite claim: it is Qloo's, and
`tests/presentation/recorded-audition.test.ts` gates it as such.

## What the run was

| | |
|---|---|
| Host | `hackathon.api.qloo.com` |
| Upstream HTTP calls | 12 (six comp searches, two artist searches, four candidate-filtered insights requests) |
| Retrieved | 2026-10-07T12:15:37.997Z … 2026-10-07T12:15:43.366Z |
| Normalizer | `qloo-audition-1` |
| Movie comps | Moon (2009), Arrival (2016), Interstellar (2014) |
| Game comps | Outer Wilds (2019), Death Stranding (2019), Mass Effect (2007) |
| Audiences | Radiohead, Kendrick Lamar |

Each comp was confirmed by exact name and release year out of its own
`/search` response, and each audience by exact artist name, before anything
was scored. The four insights requests each name one audience, one domain and
exactly the confirmed candidate ids.

## What is stored, and what is not

Stored: the confirmed identities (entity id, Qloo's name, year,
disambiguation, the rank the search returned them at), the four normalized
`comp_scores` captures with the affinity Qloo returned for each confirmed
entity, the request fingerprints the production fingerprint functions
produced, the original retrieval timestamps, and the SHA-256 of each original
wire body.

**Not stored:** the raw Qloo response bodies, the full search candidate lists,
and every field the product does not display — images, marketing links,
external ratings, tags, descriptive and demographic metadata. The record holds
only the normalized identity and affinity evidence this product shows a user
anyway, which keeps the repository from republishing Qloo responses. The wire
bodies stay private; their hashes are provenance only.

## Integrity

`content_digest` is a SHA-256 over the canonical form of every other field of
the record, with each affinity pinned to twelve decimals.
`src/presentation/recorded-audition.ts` recomputes it at load and refuses to
serve a record whose digest does not match, so no edit to a name, an id, an
affinity or a timestamp can reach a browser surface.

The twelve decimals are there because a bundler may re-emit a sixteen-digit
double as the neighbouring one, and Turbopack does — `0.9277100856231865`
reaches the built application as `0.9277100856231864`. That window is twelve
orders of magnitude below the 0.03 display threshold and below the three
decimals the page shows, so it cannot hide a change to any ordering, close
call or displayed value. The exact returned values stay in this file, and
`tests/presentation/recorded-audition.test.ts` pins them to full precision
there, where it reads the file rather than a bundle.

Each capture is
additionally re-checked against the confirmed identities, and the ordering,
close calls, reversals and decision are derived at render time by the same
`compareAudiences` and `decideForeground` the live path uses. No ranking,
verdict or winner is stored anywhere in this directory.

## Re-capture

This evidence is not resampled. `scripts/capture-audition-example.ts` is the
one-shot capture command, guarded by `RUN_AUDITION_CAPTURE=1`, and it refuses
to run when a selection already exists. A genuinely new example means a new
dated file beside this one and a new digest, never an edit to this one.
