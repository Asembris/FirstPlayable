# Phase 6 — the canonical judge-demo comparison pair

**Recorded:** 5 October 2026, 22:15–22:30 UTC · **Code:** `main` at `3106cdb`,
unchanged · **Phase 6 UI:** not started.

> **Current status:** this pair was recorded before the Phase 6 UI was built,
> and the header above is kept as recorded. Phase 6 is now complete; see
> [`BUILD_STATUS.md`](BUILD_STATUS.md).

> **Synthetic deterministic demonstration (7 October 2026).** The committed
> pair no longer carries any real Qloo data. In `provenance.json` the artist,
> the reference, their entity ids, the evidence text and hashes, the capture
> id, the request fingerprint and the capture timestamp were replaced with
> invented stand-ins in the same shape: the artist *Lanternfold* and the film
> *Halcyon Relay* (2009, Maren Oduya), taken from the synthetic fixtures in
> `fixtures/qloo/`. Inside the two version rows only the reference name and
> the derived reference/evidence ids changed, and the files were renamed to
> `with-influence.version.json` and `without-influence.version.json`. The
> scenes, the creator's decision, the diff, the witness and every engine
> result recorded below are unchanged; the version rows' `input_hash` still
> identifies the compile input as originally recorded. The Qloo-layer facts in
> this record are the synthetic values, and none of them is a Qloo response.
> The original Qloo identifiers and quoted text have been redacted.

This is the saved "with this influence / without this influence" pair that the
Phase 6 judge experience is built on, now presented as a synthetic
deterministic demonstration (see the note above). It was produced entirely through
the product's own route handlers (`scripts/smoke-compile.ts`'s in-process
harness pattern) against the live Supabase project, the real Qloo adapter, and
the pinned `gpt-4o-mini-2024-07-18`. No scene, diff, witness, or label below
was written by hand: each one is copied from a stored row and was re-verified
independently through the Phase 1 engine.

The stored rows themselves are in [`phase6-canonical-pair/`](phase6-canonical-pair/):
`with-influence.version.json`, `without-influence.version.json` (it carries the stored
`revision_diff`), and `provenance.json`.

## Verdict: **PASS**, with the caveats listed below

## What changed, in one sentence

> With the approved Halcyon Relay influence, **"Return the letter" stays locked** until
> you ask Nia who the other name on the letter belongs to and examine the
> envelope closely; with that influence removed, the same choices leave
> **"Return the letter" open**, and the two added actions are gone.

## Identifiers

| Item | Value |
|---|---|
| Project | `2568d1b1-fd82-47a2-82be-e601097a17b8` |
| **With influence** (v1, compiled) | `80bbc61c-13b9-4067-85a9-09dc1b8f8ede`, now `superseded`, still listed and playable |
| **Without influence** (v2, removal) | `1725dd05-4638-4484-b298-5b3b3d9ded23`, `active`, parent = v1 |
| Approval (creator `edit` decision) | `8f213c1e-6683-48d9-8bb6-9c86d8ce76c1`, scene approval id `approval.8f213c1e-6683-48d9-8bb6-9c86d8ce76c1` |
| Removal decision | `5c40c7ac-e0a4-45ae-9bfc-0585c96f5e80` |
| Brief | `fixtures/second_copy.brief.json`, "The Second Copy", verbatim |
| Identifiers on v1 | model `gpt-4o-mini-2024-07-18`, prompt `fp-prompts-4.2`, compiler `fp-compiler-4.2`, validator `fp-engine-validator-1.0` |
| Base hash (both) | `43e336086f9f1a7c9279c854b8a0f053a8a67b11729d1d9071a4a1ab68c0bafa` |
| Module hash | v1 `discovery = fa065ae7fef9…`; v2 none |
| Scene hash | v1 `d466febc3298ee54…` → v2 `a98145f62212aeac…` |

The project is owned by an anonymous session whose cookie exists only in the
git-ignored `probes/out/phase6/state.json` on the machine that ran this. It is
not in the repository.

## Provenance: Qloo → proposed → approved → scene changed

| Layer | Stored fact |
|---|---|
| **Artist** *(synthetic stand-in)* | Lanternfold, entity `5A000000-0000-4000-8000-000000000001`, rank 1, explicitly confirmed as the anchor; the original search capture id is *[redacted]* |
| **Qloo reference** *(synthetic stand-in)* | **Halcyon Relay** (2009, Maren Oduya), entity `5B000000-0000-4000-8000-000000000003`, reference `ref.mv.cefae39f4a9c2dcb`, original rank 3, from synthetic movies capture `5e000000-0000-4000-8000-000000000601` (synthetic capture time 2026-10-01 09:00:00 UTC) |
| **Cited evidence** *(synthetic stand-in)* | `#ev2` theme (`properties.plot_themes_description`): "Asks what makes a person the same person by setting two copies of one man against the record of a single life…"; `#ev3` tone (`properties.emotional_tone_description`). Both ids resolve inside the synthetic movies fixture `fixtures/qloo/insights-movies-lanternfold.json`. |
| **Proposed** (model, proposal stage) | idea: "Examine the themes of memory and identity under pressure, reflected in the sealed letter…"; interaction: "As you hold the letter, contemplate its significance…" — slot `discovery` |
| **Approved** (creator, `edit`, `edited_by_creator: true`) | "Borrow the idea of a contradictory identity, not the film's plot. The envelope is addressed to two names: Nia's, and someone else's. Returning the letter stays locked until you ask Nia who the other name belongs to." Intended effect: "Returning the letter stays locked until you ask Nia who the second name on the envelope belongs to." |
| **Scene changed** | `scene_changed` witness on v1: `action_availability`, `core.give`, prefix `core.ask_context → core.inspect`, enabled without → **locked** with; 20 pairs explored |

The proposal's own wording ("contemplate its significance") did not describe an
interaction, so the approval is the product's explicit creator **edit** of
that proposal, not a plain accept. The stored snapshot keeps both the proposed
and the approved text, so the UI can show the honest chain: *Qloo supplied
the reference and its identity/memory theme (here a synthetic stand-in) → the model proposed an identity-themed
idea → the creator approved this specific interpretation → this gate.* It must
not claim Qloo or the model wrote the approved sentence.

## The with / without difference, in player language

Same choices on both sides: **"Ask Nia why she needs it back" → "Examine the
letter".**

| Action | With Halcyon Relay (v1) | Without (v2) |
|---|---|---|
| Promise to keep it safe while I hold it | enabled | enabled |
| **Return the letter** | **locked** — "You need to ask Nia about the other name on the letter before you can return it." | **enabled** |
| Keep the letter | enabled | enabled |
| Walk away for now | enabled | enabled |
| Ask Nia who the other name belongs to | enabled (added by Halcyon Relay) | — |
| Examine the envelope closely | enabled (added by Halcyon Relay) | — |

After "Ask Nia who the other name belongs to", Return shows the second gate's
text: "You should first examine the envelope more closely before returning it."
After both, "Return the letter" ends in `end.give`.

**Module-added text** (v1 only): the player asks "Who is the other name on this
letter?"; examining closely, the player says "There must be something more to
this envelope."; and after the base "Examine the letter" Nia adds "The other
name is someone I care about deeply. It's vital that I get that letter back to
them."

## Stored diff (on v2, `revision_diff`)

`changed_by: remove` · `label: mechanical` · `mechanical_change: true` ·
`wording_change_only: false` · `changed_slots: [discovery]` ·
`removed_action_ids: [discovery.action_1, discovery.action_2]` · gate bindings
`discovery.gate_1` and `discovery.gate_2` on `core.give` present before, absent
after · `affected_endings: []` (all three endings stay reachable in both) ·
`unchanged: { world: true, core: true, ports: true, modules: { discovery:
false, commitment: true } }` · replay prefix `core.ask_context, core.inspect`,
both legal, `core.give` locked → enabled.

## Verification, run independently after the fact

Every check below re-reads both rows from `scene_versions` and runs the Phase 1
engine locally. **0 failures.**

| Check | Result |
|---|---|
| Same project; v2's parent is v1 | PASS |
| `world`, `core`, `ports` canonical hashes identical (`b551e226…`, `43e33608…`, `5b894fe7…`) | PASS |
| Only the `discovery` module differs (1 module → 0) | PASS |
| Stored diff equals `revisionDiffView` recomputed from the two stored scenes | PASS |
| Both versions validate (`validateScene`); v1's stored `validation_summary` records both removal subsets (`[]`, `[discovery]`) ok | PASS |
| v1: 20 reachable states, all three endings reachable, no softlock | PASS |
| v2: 5 reachable states, all three endings reachable, no softlock | PASS |
| v1: prefix then Return is refused; ask + examine-closely then Return → `end.give` | PASS |
| v2: prefix then Return → `end.give` | PASS |
| Approved evidence ids resolve in the stored capture (now: the synthetic movies fixture) | PASS |
| v1 still in the project's immutable version list | PASS |

## Caveats Phase 6 must present honestly

1. **Two requirements, not one.** The compiler chose two Halcyon Relay mechanics
   (ask *and* examine closely), each gating Return. The headline sentence above
   names both. A one-line UI label should say "Return is locked until you
   ask about the other name" only if the second requirement is also visible.
2. **Copy seams.** The base "Examine the letter" text calls the envelope
   "unmarked", and Halcyon Relay's hook then has Nia speak about "the other name" before
   the player has asked. These are the stored model text. They can't be changed
   without a new compile, which would make a new pair. Phase 6 copy polish must
   not silently rewrite these versions.
3. **The "other name" question is offered from the start.** Module actions are
   gated only on their own flag (server-owned wiring), so "Ask Nia who the other
   name belongs to" is available before examining. This is a limit of the
   current mechanical vocabulary, not of this pair.
4. **This is a removal (ablation), not the specification's §15 edit revision.**
   It answers "what did this approved influence contribute?" and is labelled
   "Without this influence", never as a competing creative version.

## Candidate search — 3 of 3 tried, then stopped

All three used the same brief, artist, reference (one movie reference → Discovery), model, and
code. Each is a complete, valid, mechanical pair. They differ only in the
creator's approval wording and the model's module output.

| # | Project | v1 → v2 | Approval wording | Why not chosen |
|---|---|---|---|---|
| 1 | `cde2b2ac-e9b2-49e7-93c1-2668dd5e4749` | `f0ee3b56…` → `57a102bb…` | §15's "contradictory identity … two names … ask Nia about that contradiction" | Halcyon Relay added a second action with the **identical label** "Examine the sealed letter"; gate 1's blocked text names the wrong requirement |
| 2 | `b2bcd0c9-5a32-47df-bd2c-0e871bbfcdae` | `f9978ff7…` → `34a80938…` | same idea, plus "do not add a second way to examine" | Same duplicate label (the module stage correctly treats approval text as data, not instruction); gate 1 text again mismatched |
| **3** | **`2568d1b1-…`** | **`80bbc61c…` → `1725dd05…`** | two names on the envelope; return locked until you ask about the other one | **chosen:** distinct labels, each blocked text matches its own gate |

## Cost of producing it

| Resource | Before | After | Used |
|---|---|---|---|
| OpenAI, `model_cost_micros` (cumulative cap $0.60) | $0.059036 | $0.064766 | **$0.005730**: 3 proposal calls + 6 compile calls; removals and verification 0 |
| Qloo, `qloo_calls` bucket | 9 | 12 | **3**: one artist search per project |
| Qloo first-hop (movies/games) | — | — | **0**: all served from stored captures |

The three Qloo calls were artist searches. The stored artist search capture
expired on 2026-10-05 at 08:56 UTC, and the capture insert uses
`ignoreDuplicates`, so the expired row is not refreshed and each search is
live. This was observed and is not changed here.
