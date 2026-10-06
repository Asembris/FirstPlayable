# Phase 6 — the canonical judge-demo comparison pair

**Recorded:** 5 October 2026, 22:15–22:30 UTC · **Code:** `main` at `3106cdb`,
unchanged · **Phase 6 UI:** not started.

> **Current status:** this pair was recorded before the Phase 6 UI was built,
> and the header above is kept as recorded. Phase 6 is now complete; see
> [`BUILD_STATUS.md`](BUILD_STATUS.md).

This is the one real, saved "with this influence / without this influence" pair
that the Phase 6 judge experience is built on. It was produced entirely through
the product's own route handlers (`scripts/smoke-compile.ts`'s in-process
harness pattern) against the live Supabase project, the real Qloo adapter, and
the pinned `gpt-4o-mini-2024-07-18`. No scene, diff, witness, or label below
was written by hand: each one is copied from a stored row and was re-verified
independently through the Phase 1 engine.

The stored rows themselves are in [`phase6-canonical-pair/`](phase6-canonical-pair/):
`with-moon.version.json`, `without-moon.version.json` (it carries the stored
`revision_diff`), and `provenance.json`.

## Verdict: **PASS**, with the caveats listed below

## What changed, in one sentence

> With the approved Moon influence, **"Return the letter" stays locked** until
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
| **Artist** | Radiohead, Qloo entity `70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C`, rank 1, explicitly confirmed as the anchor; search capture `24ea712f-d3dd-4f8a-a358-efe93694513a` |
| **Qloo reference** | **Moon** (2009, Duncan Jones), entity `6BBB34F4-9345-4459-82AE-10991FA35CD2`, reference `ref.mv.fe2f37e5fa35ed7b`, original rank 3, from movies capture `e926c61a-18ac-453f-a387-d5aba4c483de` (captured 2026-10-04 08:56:47 UTC; served from cache, 0 upstream calls) |
| **Cited evidence** | `#ev2` theme (`properties.plot_themes_description`): "The film probes what makes someone human by exploring identity and memory under extreme isolation…"; `#ev3` tone (`properties.emotional_tone_description`). Both ids resolve inside the stored capture. |
| **Proposed** (model, proposal stage) | idea: "Examine the themes of memory and identity under pressure, reflected in the sealed letter…"; interaction: "As you hold the letter, contemplate its significance…" — slot `discovery` |
| **Approved** (creator, `edit`, `edited_by_creator: true`) | "Borrow the idea of a contradictory identity, not the film's plot. The envelope is addressed to two names: Nia's, and someone else's. Returning the letter stays locked until you ask Nia who the other name belongs to." Intended effect: "Returning the letter stays locked until you ask Nia who the second name on the envelope belongs to." |
| **Scene changed** | `scene_changed` witness on v1: `action_availability`, `core.give`, prefix `core.ask_context → core.inspect`, enabled without → **locked** with; 20 pairs explored |

The proposal's own wording ("contemplate its significance") did not describe an
interaction, so the approval is the product's explicit creator **edit** of
that proposal, not a plain accept. The stored snapshot keeps both the proposed
and the approved text, so the UI can show the honest chain: *Qloo supplied
Moon and its identity/memory theme → the model proposed an identity-themed
idea → the creator approved this specific interpretation → this gate.* It must
not claim Qloo or the model wrote the approved sentence.

## The with / without difference, in player language

Same choices on both sides: **"Ask Nia why she needs it back" → "Examine the
letter".**

| Action | With Moon (v1) | Without (v2) |
|---|---|---|
| Promise to keep it safe while I hold it | enabled | enabled |
| **Return the letter** | **locked** — "You need to ask Nia about the other name on the letter before you can return it." | **enabled** |
| Keep the letter | enabled | enabled |
| Walk away for now | enabled | enabled |
| Ask Nia who the other name belongs to | enabled (added by Moon) | — |
| Examine the envelope closely | enabled (added by Moon) | — |

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
| Approved evidence ids resolve in the stored Moon capture | PASS |
| v1 still in the project's immutable version list | PASS |

## Caveats Phase 6 must present honestly

1. **Two requirements, not one.** The compiler chose two Moon mechanics
   (ask *and* examine closely), each gating Return. The headline sentence above
   names both. A one-line UI label should say "Return is locked until you
   ask about the other name" only if the second requirement is also visible.
2. **Copy seams.** The base "Examine the letter" text calls the envelope
   "unmarked", and Moon's hook then has Nia speak about "the other name" before
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

All three used the same brief, artist, reference (Moon → Discovery), model, and
code. Each is a complete, valid, mechanical pair. They differ only in the
creator's approval wording and the model's module output.

| # | Project | v1 → v2 | Approval wording | Why not chosen |
|---|---|---|---|---|
| 1 | `cde2b2ac-e9b2-49e7-93c1-2668dd5e4749` | `f0ee3b56…` → `57a102bb…` | §15's "contradictory identity … two names … ask Nia about that contradiction" | Moon added a second action with the **identical label** "Examine the sealed letter"; gate 1's blocked text names the wrong requirement |
| 2 | `b2bcd0c9-5a32-47df-bd2c-0e871bbfcdae` | `f9978ff7…` → `34a80938…` | same idea, plus "do not add a second way to examine" | Same duplicate label (the module stage correctly treats approval text as data, not instruction); gate 1 text again mismatched |
| **3** | **`2568d1b1-…`** | **`80bbc61c…` → `1725dd05…`** | two names on the envelope; return locked until you ask about the other one | **chosen:** distinct labels, each blocked text matches its own gate |

## Cost of producing it

| Resource | Before | After | Used |
|---|---|---|---|
| OpenAI, `model_cost_micros` (cumulative cap $0.60) | $0.059036 | $0.064766 | **$0.005730**: 3 proposal calls + 6 compile calls; removals and verification 0 |
| Qloo, `qloo_calls` bucket | 9 | 12 | **3**: one artist search per project |
| Qloo first-hop (movies/games) | — | — | **0**: all served from stored captures |

The three Qloo calls were artist searches. The stored Radiohead search capture
expired on 2026-10-05 at 08:56 UTC, and the capture insert uses
`ignoreDuplicates`, so the expired row is not refreshed and each search is
live. This was observed and is not changed here.
