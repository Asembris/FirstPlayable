# Phase 3 — real Qloo references and explicit influence approval

**Branch:** `feat/phase-3-qloo` · **Date:** 4 October 2026 · **Status:** PASS

Every figure in this document was observed. Nothing here is a projection, and
nothing claims a capability the repository does not contain. Where a claim is
narrower than it might appear, the narrowing is stated.

No API key, access token, database password, or cookie secret appears anywhere
in this file.

---

## 1. What Phase 3 implemented

| Area | Files |
|---|---|
| Qloo contracts and evidence model | `src/domain/qloo.ts` |
| Influence pipeline records | `src/domain/influence.ts` |
| Pinned upstream response shapes | `src/server/qloo/contracts.ts` |
| Normalization from real captures | `src/server/qloo/normalize.ts` |
| Three-operation adapter | `src/server/qloo/client.ts` |
| Capture cache and TTL policy | `src/server/qloo/cache.ts` |
| Global launch policy and quota reserve | `src/server/qloo/limiter.ts` |
| Parallel first-hop orchestration | `src/server/qloo/references.ts` |
| Context firewall payload builders | `src/server/influence/payload.ts` |
| Bounded proposal stage | `src/server/influence/proposals.ts` |
| Approval resolution from immutable history | `src/server/influence/approvals.ts` |
| Three-layer provenance | `src/server/influence/provenance.ts` |
| Routes | `src/server/api/{qloo,proposals,decisions,shared}.ts` and five route files |
| Studio workflow | `src/components/studio/{AnchorPanel,ReferenceRows,ApprovedInfluences,ProjectClient}.tsx` |
| Migration | `supabase/migrations/20261004085412_phase3_qloo.sql` |
| Redacted real captures | `fixtures/qloo/` |
| Live smokes | `scripts/smoke-qloo.ts`, `scripts/smoke-proposal.ts` |

---

## 2. The verified Qloo surface

Three frozen operations, and no fourth. There is no general proxy, no
caller-supplied URL, and no caller-supplied parameter object anywhere in the
application: `tests/server/qloo-client.test.ts` asserts the exact bytes.

```http
GET https://hackathon.api.qloo.com/search?query=<encoded>&types=urn:entity:artist&take=5
GET https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:movie&signal.interests.entities=<confirmed artist UUID>&take=10
GET https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:videogame&signal.interests.entities=<same confirmed artist UUID>&take=10
X-Api-Key: <server secret>
```

The exact URLs observed on the wire during the live smoke, with the base
substituted and the key header never printed:

```
{base}/search?query=Radiohead&types=urn%3Aentity%3Aartist&take=5
{base}/v2/insights?filter.type=urn%3Aentity%3Amovie&signal.interests.entities=70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C&take=10
{base}/v2/insights?filter.type=urn%3Aentity%3Avideogame&signal.interests.entities=70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C&take=10
```

`urn:entity:videogame` is the type that works. `urn:entity:video_game` is never
sent: it appears in this repository only inside comments stating that it is not
the working value, and inside two assertions in
`tests/server/qloo-client.test.ts` that it is absent from the outgoing
`filter.type` and from the documented request shapes. The specification records
the conflict between the published guide and the live recon (§ "Conflict
handling"); this phase smoke-tested the observed working GET form and it
succeeded.

A creator-supplied query cannot become a parameter: a search for
`a&filter.type=urn:entity:movie&x= #` produces a URL whose only keys are
`query`, `types`, and `take`, with the hostile text percent-encoded inside
`query`.

### Observed envelopes

Pinned from live payloads, not from documentation:

```text
GET /search?...                -> { "results": [ entity, ... ] }          (no "success" field)
GET /search?... (no match)     -> { "results": [] }
GET /v2/insights?...           -> { "success": true, "results": { "entities": [ ... ] } }
```

**No parameter echo exists.** Neither envelope echoes `filter.type`,
`signal.interests.entities`, or the query. Each insights entity carries a
`query` object, but it holds that entity's affinity, not a parameter echo. The
application records this absence (`echo_available: false`) and preserves the
outbound request fingerprint; it does not treat an absent echo as proof the
parameters were applied, and it does not claim to detect every silently ignored
parameter. The actual defences are the pinned contract tests and the returned
`subtype` check below.

---

## 3. Field mappings, pinned from real captures

Read off live responses on 4 October 2026 and recorded in
`src/server/qloo/normalize.ts`. Normalizer version `qloo-norm-1`.

### Search

| Observed path | Normalized to |
|---|---|
| `results[]` | candidate list, in returned order |
| `results[].entity_id` | `entity_id` (uppercase canonical UUID) |
| `results[].name` | `name` |
| `results[].types[]` | must contain `urn:entity:artist` |
| `results[].properties.short_description` | `short_description` |
| `results[].disambiguation` | `disambiguation` |
| `results[].properties.external` | `identity_hints` — catalogue **names only** |

`results[].popularity` is read and then dropped. Listener and scrobble counts
inside `external` are dropped. Those would read as taste inference rather than
identity.

### Insights, both domains

| Observed path | Normalized to |
|---|---|
| `results.entities[]` | candidate list; `original_rank` is the 1-based position |
| `results.entities[].entity_id` | `entity_id` |
| `results.entities[].name` | `name` |
| `results.entities[].subtype` | checked against the requested `filter.type` |
| `results.entities[].disambiguation` | `disambiguation` |
| `results.entities[].query.affinity` | `affinity` — **private**, stripped from every public view |
| `results.entities[].properties.release_year` / `release_date` | `year`, or `null` |

### Movie evidence, in priority order

`properties.plot_summary` → `properties.plot_themes_description` →
`properties.emotional_tone_description` → `properties.style_description` →
`properties.keywords` → `properties.genre_description` →
`properties.description` → `properties.short_descriptions[en].value` →
`properties.genres` → `tags[urn:tag:theme:qloo].name`

The concise interpretive fields come first deliberately.
`properties.description` is a 600–700 character marketing-style paragraph in the
live payload and would otherwise consume the whole per-candidate budget, leaving
theme, tone, and style unrepresented.

### Videogame evidence, in priority order

`properties.description` → `properties.short_descriptions[en].value` →
`properties.emotional_tone` → `properties.audience_tags` →
`properties.gameplay_type` → `properties.steam_tags` → `properties.genre` →
`properties.art_style` → `tags[urn:tag:emotional_tone:qloo].name` →
`tags[urn:tag:genre:qloo].name`

### Never read, and therefore never stored or sent onward

`properties.audience_identity`, `properties.situational_contexts`,
`properties.player_demographics`, `properties.websites`,
`properties.collaborators`, `properties.production_companies`,
`properties.filming_location`, `properties.akas`, `properties.image`,
`external`. Long audience claims, demographic data, marketing links, and
images. `tests/server/qloo-normalize.test.ts` asserts none of these field paths
appears in a normalized capture.

### Evidence item shape

Each item carries an id (`<reference_id>#ev<n>`, globally unique so a foreign
citation is detectable), the observed field path, a kind label, bounded text,
a SHA-256 of the **full** original text taken before bounding, and a
`truncated` flag. A list of returned strings becomes one comma-joined evidence
string; no code path in the normalizer can introduce a sentence the payload did
not contain.

Caps: 1,200 characters per candidate, 700 per item. Observed per-candidate
totals for the canonical movies were 1,121–1,197 characters across five items;
for the canonical games, 932–1,038 characters across ten thinner items.

### Application reference ids are not Qloo UUIDs

`ref.mv.<16 hex>` / `ref.vg.<16 hex>`, derived as
`sha256(domain|entity_id)[0..15]`. Stable across captures, so an approval
survives a refetch, and not a UUID, so nothing can smuggle a forged identity in
through a field the compiler trusts.

---

## 4. Live Qloo smoke

```
RUN_QLOO_SMOKE=1 npm run smoke:qloo       →  exit 0
```

### Confirmed canonical artist

| Field | Value |
|---|---|
| Query | `Radiohead` |
| Confirmed name | Radiohead |
| Confirmed UUID | `70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C` |
| Returned at rank | 1 of 5 |
| Confirmation rule | exact case-insensitive name match, never position |

The UUID matches the one the supplied report recorded (E2 §4). It was
re-observed live, not copied from the report.

The other four returned candidates were `Radiohead Tribute`,
`Dub Tribute To Radiohead`, `The Bluegrass Tribute to Radiohead`, and
`Thom Yorke and Johnny Greenwood (Radiohead)` — which is exactly why
confirmation is an explicit creator action and not a top-result pick.

### Movie first hop — all ten rows normalized, ten usable

| Rank | Name | Year | Qloo UUID | Application id |
|---|---|---|---|---|
| 1 | Children of Men | 2006 | `BB9AA6CE-8012-44B8-B554-54BE8A374A5E` | `ref.mv.7b622fd31d6f5938` |
| 2 | Being John Malkovich | 1999 | `42AFD1E0-D42C-42C8-9272-945248E87BB6` | `ref.mv.ba9d3ec4a7c40a9a` |
| 3 | Moon | 2009 | `6BBB34F4-9345-4459-82AE-10991FA35CD2` | `ref.mv.fe2f37e5fa35ed7b` |

Ranks 4–10: Adaptation., Synecdoche New York, A Scanner Darkly, Donnie Darko,
Pi, Lost in Translation, Primer. All three historically observed titles are
still present.

**Moon's canonical context was recovered, not invented.** The duplicate-identity
material comes from `properties.plot_summary`, verbatim from the API:
"…an identical man at an exterior harvester forces him to confront the truth
about his identity…". `properties.plot_themes_description` adds: "The film
probes what makes someone human by exploring identity and memory under extreme
isolation…".

### Videogame first hop — all ten rows normalized, ten usable

| Rank | Name | Year | Qloo UUID | Application id |
|---|---|---|---|---|
| 1 | Mass Effect 2 | 2010 | `5B3C9A59-72CF-4EC1-924A-3CC7AA87647D` | `ref.vg.c517a0da602525c6` |
| 2 | Dragon Age: Origins | 2009 | `2EFBE2D7-A977-4824-8304-6389BF377127` | `ref.vg.b0e598da32f6aa32` |
| 3 | Mass Effect | 2007 | `DB003E13-0C9F-4011-B928-43ADC2A59F26` | `ref.vg.76da93dea4ee7839` |

All three historically observed titles are still present. Game metadata is
genuinely thinner — short descriptions plus tag groups rather than a plot
summary — and it was left thin. No model-written game description exists
anywhere in the application.

### A second artist, to show the path is not Radiohead-specific

```
QLOO_SMOKE_ARTIST="Taylor Swift" RUN_QLOO_SMOKE=1 npm run smoke:qloo  →  exit 0
```

Confirmed `Taylor Swift` / `4BBEF799-A0C4-4110-AB01-39216993C312` at rank 1 of
5. Movies: Me Before You (2016), Love Rosie (2014), The Fault in Our Stars
(2014). Videogames: Temple Run (2011), Mario Kart Wii (2008), Tennis (2020).
Ten usable rows per domain. A completely different neighbourhood, which is
consistent with the supplied report's observation that first-hop neighbourhoods
are distinct (E2).

### Call counts

| Path | Upstream calls |
|---|---|
| Fully uncached creation | **3** — one search, two first hops |
| Worst case with the one permitted retry each | 6 |
| Repeat of the identical retrieval | **0** |
| Repeat in a separate process, against the shared database | **0** |

Observed on the Taylor Swift run, which was genuinely uncached: three calls,
both insight launches taking a lease (`references_movie`,
`references_videogame`). The immediately following repeat made zero requests,
took zero leases, and returned the same immutable capture ids.

A later fully cached Radiohead run reported `upstream calls this run: 0` for
every stage including the artist search.

### Quota the API actually returned

| Header | Observed |
|---|---|
| `x-month-ratelimit-limit` | 10000 |
| `x-month-ratelimit-remaining` | 9547 → 9542 across this phase's live work |
| `x-month-ratelimit-reset` | ~2,476,800 s (~28.7 days) |
| `x-second-ratelimit-limit` | 5 |

Recorded per capture in `qloo_captures.quota_diagnostics`. The reset figure is
reported, not relied on: the application makes no assumption about a calendar
month reset.

### Retries

No retry was triggered during any live run. The retry behaviour is covered
deterministically in `tests/server/qloo-client.test.ts`: one retry for a
connection failure, a 429, or a 5xx; `Retry-After` honoured only when it fits
the stage budget; never a retry for 400, 401, 403, or a malformed success; and a
lease taken for the retry too, because a retry consumes quota.

---

## 5. Cache and rate policy

| Rule | Value | Where |
|---|---|---|
| Artist search TTL | 24 h | observed in the database: `23:59:59.867` and `1 day 00:00:00.677` |
| Empty artist search TTL | 10 min | `tests/server/qloo-cache.test.ts` |
| First-hop TTL | 7 days | observed: `6 days 23:59:59.368` and `6 days 23:59:58.394` |
| Stale fallback ceiling | 30 days, same artist, same domain, explicit consent | `tests/server/qloo-cache.test.ts` |
| Launch spacing | ≥ 250 ms globally | `reserve_qloo_launch` under a row lock |
| Concurrent leases | ≤ 2 globally | same |
| Local allowance | 9,500 calls per 30-day window (10,000 − 500 judging reserve) | `budget_buckets` scope `qloo_calls` |

Cache keys:

* artist search — normalized query + artist type + take + normalizer version + API host;
* first hop — API host + confirmed artist UUID + `filter.type` + take + normalizer version.

The normalized query folds Unicode, trims, collapses whitespace, and case-folds,
so `"  RadioHead "`, `"radiohead"`, and `"RADIOHEAD"` share one capture. Three
differently written searches cost one upstream call, verified in
`tests/server/qloo-routes.test.ts`.

**Expiry is not deletion.** `readCapturesByIds` reads the capture a frozen
decision points at regardless of its lookup TTL, which is what makes the
provenance drawer keep working. A test reads a capture ten first-hop TTLs later
and gets it back.

**A stale capture is never relabelled live.** `readStaleReferenceFallback`
returns `null` without explicit consent, re-checks the artist and domain on the
row itself rather than trusting the query that found it, refuses anything older
than 30 days, and labels what it does return `stale` with its capture date.

### The launch policy is database-backed, not per-process

`reserve_qloo_launch` decides both conditions — in-flight count and elapsed time
since the previous grant — inside one `select … for update` on one row, then
commits *before* the caller opens its socket. No database transaction is held
across network I/O. Under eight interleaved concurrent callers with spacing
disabled, exactly `maxActiveLeases` were granted and the rest refused
(`tests/server/qloo-limiter.test.ts`). An abandoned lease is swept after its
lifetime and the slot is recovered.

The pacing row uses one fixed non-rolling window (1970 → 2270) on purpose: a
daily or monthly window would reset `last_launch_at` at its boundary and let one
launch through early.

### Qloo pacing cannot corrupt model budgeting

Three separate rows in `budget_buckets`, observed after all of this phase's live
work:

| scope | key | call_limit | used_calls | used_tokens | last_launch_at | window |
|---|---|---|---|---|---|---|
| `model_calls` | global | 40 | 4 | 19,980 | null | 1 day |
| `qloo_calls` | global | 9,500 | 5 | 0 | null | 30 days (4 Oct → 3 Nov) |
| `qloo_launch` | global | 2 | 0 | 0 | set | fixed |

`last_launch_at` is written only by the `qloo_launch` scope; the phase 2
migration's model-budget functions never mention the column. `release_qloo_launch`
is scoped, so it cannot reclaim a model lease even if handed its id.

**One honest discrepancy.** `qloo_calls.used_calls` reads 5 where six live calls
were actually made. The very first Radiohead smoke run happened before the smoke
script was changed to reserve around its own artist search, so that one search
was not written to the counter. The *route* has always reserved — the gap is in
the smoke script's earlier version, not in the application — and the enforced
guard is the local counter together with the `x-month-ratelimit-remaining`
header the API returns.

### The judging reserve

The local counter is the guard that actually blocks a call before it is made:
reaching 9,500 in a window refuses retrieval with an honest `BUDGET_EXHAUSTED`
state and no automatic top-up. The returned `x-month-ratelimit-remaining`
header is the authoritative figure and is checked after each response; within
one retrieval that check suppresses a retry and the remaining hop where
ordering allows, but two hops launched 250 ms apart may both predate the first
header. This is stated plainly rather than advertised as a hard pre-call halt.

---

## 6. Domain and parameter defence

| Condition | Behaviour | Test |
|---|---|---|
| Returned `subtype` contradicts `filter.type` | **whole capture fails** with `QLOO_DOMAIN_MISMATCH`, even if only a later row contradicts | `qloo-normalize` |
| Returned `types[]` contradicts the search type | whole response fails with `QLOO_SEARCH_TYPE_MISMATCH` | `qloo-normalize` |
| `success: false` inside HTTP 200 | fails with `QLOO_ERROR_SHAPED_SUCCESS` | `qloo-normalize` |
| Envelope is not an observed shape | fails with `QLOO_ENVELOPE_UNEXPECTED` | `qloo-normalize` |
| Malformed required identity on one row | row dropped and counted in `malformed_rows`; rank gap preserved | `qloo-normalize` |
| Duplicate entity id | row dropped and counted in `duplicates_dropped` | `qloo-normalize` |
| Identity but no usable context | candidate kept, `usable: false`, reason `no_usable_context`; cannot drive an approval | `qloo-normalize` |
| Body over 3 MiB, declared or streamed | `QLOO_RESPONSE_TOO_LARGE`, no retry | `qloo-client` |
| Unknown new upstream field | ignored, retrieval continues | `qloo-normalize` |

A wrong domain fails the capture rather than flagging a row, because a
contradicted subtype is the signal that `filter.type` was not applied. That is
the strongest honest reading of an HTTP 200 whose body answers a different
question.

---

## 7. The proposal stage

One bounded structured call over the frozen brief and at most six eligible
normalized references. One permitted structural repair, and no second hidden
retry budget.

| Fact | Value |
|---|---|
| Model | `gpt-4o-mini-2024-07-18`, pinned; no fallback model, no fallback provider |
| Calls, live local run | **1** (`repaired: false`) |
| Token usage reported | 4,247 input · 945 output · **5,192 total** |
| List-price cost estimate | ~$0.00120 — arithmetic on those tokens, not a billed amount |
| Proposals returned, local | 6 of 6 eligible references |
| Proposals returned, deployed | 5 of 6 — within the 1–6 contract |
| Output cap | 2,400 tokens |
| Budget primitive | the phase 2 `reserve_model_budget` / `reconcile_model_budget` RPCs, unchanged |

### Not an arbitrary prompt endpoint

`POST /api/projects/:id/decisions`'s sibling, `POST /api/projects/:id/proposals`,
accepts exactly one field: `expected_revision`. A body carrying
`instructions`, `model`, `prompt`, `references`, `evidence`, or `temperature` is
refused with `VALIDATION_FAILED` and no model call is made — asserted for all
six in `tests/server/proposals-route.test.ts`. The brief comes from the project
row, the eligible references from the immutable captures, and the instructions
from a module constant into which no retrieved or creator text is interpolated.

### What the model may and may not produce

The output schema has no field for a Qloo endorsement, a confidence score, or an
approval flag. On top of that, the server rejects the whole set — never a
partially accepted subset — when any proposal:

* names a reference this request did not include (`FOREIGN_REFERENCE`);
* cites an evidence id that does not exist, or belongs to another reference
  (`UNSUPPORTED_EVIDENCE`);
* cites zero, more than four, or duplicated evidence ids (`EVIDENCE_COUNT`);
* uses a slot outside `discovery` / `commitment` (`INVALID_SLOT`);
* exceeds 500 / 300 / 300 characters, is empty, or is not plain text
  (`TEXT_BOUNDS`);
* literally asserts one of sixteen forbidden attributions — "qloo recommends",
  "qloo proves", "qloo knows", "your true taste", "objectively best", and so on
  — or uses the brief's own forbidden wording (`FORBIDDEN_CLAIM`);
* duplicates a reference, or returns none at all (`SHAPE`).

The forbidden-attribution list is a **literal** wording guard on an enumerated
set of false attributions. It is not a semantic classifier and does not prove
the absence of the underlying idea.

`reference_id`, `entity_id`, `reference_name`, `domain`, `capture_id`, and the
`proposal_id` are all assigned by the server from the frozen capture, never read
from model output.

### Repair discipline, verified

A shape-valid response that fails application validation triggers exactly one
repair, whose instructions carry the concise deterministic error codes; a second
failure ends the stage with no stored draft. A response whose slot is outside
the enum is refused by the authoritative contract in one call, so the repair
allowance is not spent on an unfixable shape. A refusal, a truncation, a foreign
model, and a transport failure each end the stage immediately with a stable code
and no partial output.

### Idempotency, verified

The stage key is derived from the brief hash, the confirmed artist, the capture
ids, and every eligible evidence hash. A second identical request returned
`replayed: true`, `model_calls: 0`, and the committed draft — with the scripted
provider having received exactly one request.

---

## 8. Context firewall and sentinel isolation

Two pure builders, each with an explicit parameter list and nothing else in
scope:

```ts
buildProposalPayload(brief, eligibleReferences)
buildApprovedInfluencePayload(approval, capture)
```

`buildApprovedInfluencePayload` is the smallest compiler-facing representation
of one approval. It is built and tested now, before the phase 4 module compiler
exists, so the boundary is established before anything depends on it.

### Sentinels

`tests/server/influence-isolation.test.ts` plants five distinct strings in
synthetic Qloo payloads, retrieves them through the real routes, dismisses one
proposal, approves two into different slots, and then builds the payloads from
the committed state:

| Sentinel | Planted in | Absent from the approved payload |
|---|---|---|
| `SENTINEL_REJECTED_7f3a` | a proposal the creator dismissed | yes |
| `SENTINEL_UNSELECTED_91bc` | a reference nobody decided on | yes |
| `SENTINEL_OTHER_SLOT_c44d` | the other slot's reference | yes, from the Discovery payload |
| `SENTINEL_ARTIST_QUERY_2e8f` | the artist's own description | yes, from both payloads |
| `SENTINEL_UNUSABLE_a001` | an identity-only row | yes, and absent from the proposal payload too |

The positive half is asserted too: the proposal payload *does* contain the
rejected, unselected, and other-slot sentinels, because all three were eligible
at that point. Without that, the negative assertions would prove nothing.

The approved payload's key set is exactly
`approval_id, approved_text, evidence, intended_effect, reference, slot`. It
carries no artist, no entity UUID, no affinity, no capture id, no original rank,
and no request fingerprint. It refuses to build at all when a cited evidence id
does not resolve in the capture, when the capture is from the wrong domain, or
when the reference is absent.

### What this guarantee is, precisely

**Dataflow and ownership isolation.** The value a compiler would receive is
built from one approval and its own cited evidence, and the rejected,
unselected, and other-slot material is not reachable from it.

It is **not** a claim that a language model could never independently invent a
semantically similar idea from the brief or from its training. No test in this
repository asserts that, because none could. A test in that file makes the point
explicitly: the brief *is* present in the proposal payload, so any idea the
brief itself supports remains reachable, and that is expected rather than a
leak.

---

## 9. Creator decisions

Default approved count is **zero**, by construction. `active_approvals` is
written only by `append_influence_decision`, and only from the decisions route,
and only on an explicit creator action. Retrieving a reference, rendering a
proposal, and opening a card all leave it empty — verified after retrieval,
after the proposal stage, and on reload.

| Kind | Behaviour | Verified |
|---|---|---|
| `accept` | approves a proposal as written, **into an empty slot only** | yes |
| `edit` | approves creator-edited wording; marks `edited_by_creator` | yes |
| `replace` | explicitly displaces an occupied slot, recording the predecessor | yes |
| `reject` | dismisses a proposal; **never** clears an existing approval | yes |
| `remove` | withdraws the approval a slot holds, keeping its record | yes |

`accept` into an occupied slot is refused with `VALIDATION_FAILED`, so filling a
taken slot is always an explicit replacement with a visible predecessor.
`replace` on an empty slot is refused too. At most one approval per slot, and at
most two slots, verified end to end.

**Editing never rewrites evidence.** The creator's wording goes into
`influence_decisions.creator_text`; the proposal snapshot — and therefore every
cited Qloo evidence item — is written once and never touched. A test serializes
every capture row before an edit and asserts byte equality afterwards. The
`qloo_captures` and `influence_decisions` tables also carry a phase 2 trigger
that rejects `UPDATE` outright.

**Narrowing only.** A creator may cite fewer of the proposal's evidence items;
an id outside them is refused rather than dropped, so an approval can never cite
evidence the proposal did not.

**Append-only history.** A replacement leaves both rows; the superseded row
still holds its original approved text. A removal leaves the accept row intact
and adds a `remove` row pointing at it.

**Compare-and-swap.** A decision taken against a stale revision is refused with
no row written, and replaying the same decision at the same revision is refused
because the project has already moved on.

---

## 10. Provenance

Three layers, because three layers exist:

```text
Qloo retrieved        → reference, domain, year, one supported context sentence,
                        the original artist, the capture date; rank and evidence
                        field paths behind a second disclosure
FirstPlayable proposed → the model's own abstraction and interaction, labelled
                        "FirstPlayable interpretation, not a Qloo assertion"
Creator approved       → the exact frozen wording, "Edited by you" when it
                        differs, the slot, and the predecessor when replaced
```

The observed key set of a live provenance chain is
`approval_id, approved, proposed, retrieved, slot`. **There is no
`scene_changed` field.** Phase 4's mechanical-witness layer is not hidden behind
a flag and not rendered empty — the type offers nowhere to put it, so a creator
cannot be shown a mechanical consequence no compiler produced.

The retrieved layer's context sentence is drawn from one returned evidence item
and truncated on a word boundary. It never merges two fields, because the result
would be a claim no single returned field makes. The evidence shown is only what
the approval cites. No affinity appears anywhere in the chain.

The model's proposed wording is stored alongside the creator's approved wording
(`proposed_idea`, `proposed_interaction`), so the two layers stay
distinguishable and "Edited by you" is a fact rather than a label.

### Wording discipline

The UI says "Qloo describes", "Qloo retrieved", "FirstPlayable proposed",
"Creator approved". A browser test reads the rendered studio and asserts the
absence of `affinity`, `confidence`, `best match`, any `NN%` figure, and the
patterns `Qloo recommends|proves|says|knows|generated`. The deployed
verification repeats the same scan against the live page.

---

## 11. Database changes

One forward migration, `supabase/migrations/20261004085412_phase3_qloo.sql`.
No phase 2 migration was modified, no table was dropped, no column was removed,
and no column was altered. A static test asserts all of that.

The phase 2 schema already modelled what phase 3 stores: `qloo_captures` for
immutable retrieval evidence, `influence_decisions` as append-only with a
predecessor pointer, `projects.anchor` and `projects.reference_capture_ids`, and
`append_influence_decision` for the revision compare-and-swap. What was genuinely
missing:

| Addition | Why it could not be avoided |
|---|---|
| `projects.proposal_draft jsonb` | specification section 11 permits the current draft as a project field; nothing existed to hold it |
| `budget_buckets.last_launch_at timestamptz` | a 250 ms global gap needs the previous grant's time; no phase 2 counter expressed it |
| `reserve_qloo_launch` / `release_qloo_launch` | the launch policy, in its own scope so it cannot touch model budgeting |
| `confirm_project_anchor` | owner-checked, revision-checked anchor confirmation with explicit rebranch |
| `set_project_references` / `set_project_proposal_draft` | so no route mutates a project through a bare `UPDATE` |
| `qloo_captures_artist_domain_captured_idx` | orders the stale-fallback lookup the phase 2 index already filters |

### How it was applied

`supabase db push` still cannot be used from this machine, for the two reasons
diagnosed in `docs/DEPLOYMENT_PREFLIGHT.md` §2: the direct database host is
IPv6-only on a network without an IPv6 route, and the scoped access token lacks
`database_pooling_config_read`. No permission was broadened, no Full Access
token was requested, and the database password was never requested, entered, or
stored.

The committed file was applied verbatim through the same already-authorised
Supabase management connection phase 2 used. The remote history recorded it as
version `20261004085412`, so the local file was **renamed to match**, keeping
local and remote migration histories identical.

### Applied state, read back from the live catalog

| Check | Observed |
|---|---|
| `projects.proposal_draft` exists | yes |
| `budget_buckets.last_launch_at` exists | yes |
| `qloo_captures_artist_domain_captured_idx` exists | yes |
| Phase 3 functions present | 5 of 5 |
| Tables in `public` | 8 — still the eight of section 11, no ninth |
| Row-level security policies | 0 — deny-by-default posture unchanged |
| Phase 3 functions: `SECURITY DEFINER` | none |
| Phase 3 functions: `search_path` | pinned to `''` on all five |
| Phase 3 function grantees | `postgres` (owner) and `service_role` only |

### Security advisors

| Advisor | Level | Assessment |
|---|---|---|
| `rls_enabled_no_policy` ×8 | INFO | the intended posture: RLS on, no policy, so browser roles are denied by default. Unchanged from phase 2. |
| `anon_security_definer_function_executable` — `public.rls_auto_enable()` | WARN | **not an application object.** Supabase's own event trigger from the project's automatic-RLS setting, already recorded in `docs/DEPLOYMENT_PREFLIGHT.md` §3, untouched by phase 3. |

No advisor finding concerns a phase 3 object.

### Live row state after this phase's work

| Table | Rows | Note |
|---|---|---|
| `qloo_captures` | 6 | 2 search, 2 movies, 2 videogames — two artists |
| `influence_decisions` | 4 | all `accept`; append-only |
| `projects` | 16 | 4 anchored, 4 holding one approval |
| `operations` (`proposals`, succeeded) | 4 | one per real proposal call |
| `scene_versions` | **0** | phase 4 is not implemented |
| `publications` | **0** | phase 5 is not implemented |

---

## 12. Routes

The frozen phase 3 subset, and nothing else:

| Method/path | Behaviour |
|---|---|
| `POST /api/projects/:id/artist-search` | cached typed artist search; one field, `query` |
| `PUT /api/projects/:id/anchor` | confirm one entity id from a named snapshot |
| `POST /api/projects/:id/references` | the two allowed first hops, in parallel under the limiter |
| `POST /api/projects/:id/proposals` | one bounded proposal operation; one field |
| `POST /api/projects/:id/decisions` | one explicit creator decision |

`tests/engine/fixtures.test.ts` asserts the exact route file list and the
absence of anything named `compile`, `activate`, `revisions`, `operations`,
`publish`, `publications`, `public`, `export`, `qloo`, `openai`, `model`, or
`prompt`.

Every route runs the phase 2 gauntlet first, in this order and before touching
anything: Origin, content type, body cap, Zod contract, owner session,
owner-scoped project read. Each refusal is verified per route:
`ORIGIN_REQUIRED` 403, `ORIGIN_MISMATCH` 403, `CONTENT_TYPE_UNSUPPORTED` 415,
`BODY_TOO_LARGE` 413, `SESSION_REQUIRED` 401, and `NOT_FOUND` 404 for a foreign
project, a nonexistent project, and a malformed id alike — with no upstream call
made in any of those cases.

### Anchor confirmation cannot be forged

The request names a capture and an entity id. Every other anchor field — name,
description, disambiguation, identity hints, rank, query — is copied by the
server out of that stored capture. A body carrying a different `name` is refused
by the strict contract; an entity id that is not in the named snapshot is
refused with `VALIDATION_FAILED`; a snapshot id that does not exist is refused.
This is verified locally and against the deployment.

### Partial failure is honest

One domain failing never destroys the other. With movies returning 503 and games
succeeding, the response carries `movie.status: "unavailable"`,
`failure_code: "QLOO_UPSTREAM"`, an empty `displayed`, a usable videogame row,
`any_usable: true`, and only the successful domain's capture attached. With both
domains returning identity-only rows, `any_usable` is false, nothing is
fabricated, and the studio shows "No supported influences available for this
artist."

### The browser never sees what it should not

A references response was scanned and contains no `affinity`, no `popularity`,
no `request_fingerprint`, and no `x-api-key`. The public project view's key set
is fixed and excludes the owner session id, the clean base scene, every
fingerprint, and every affinity.

---

## 13. Offline test coverage

`npm test` → **425 tests in 23 files**, all passing, with no network access and
no credential. Phase 3 added 197 of them:

| File | Tests | Covers |
|---|---|---|
| `qloo-normalize.test.ts` | 35 | real-shape normalization, cache keys, every defence above |
| `qloo-client.test.ts` | 24 | exact request bytes, timeouts, body caps, retry budget, leases |
| `qloo-cache.test.ts` | 18 | every TTL, stale consent, wrong-artist and wrong-domain refusal |
| `qloo-limiter.test.ts` | 13 | spacing, concurrency under interleaving, lease recovery, scope separation |
| `qloo-routes.test.ts` | 27 | the three retrieval routes, security matrix, partial failure, cache reuse |
| `influence-proposals.test.ts` | 29 | payload firewall, every rejection code, repair discipline |
| `proposals-route.test.ts` | 14 | bounded operation, idempotent replay, budget, no prompt surface |
| `decisions-route.test.ts` | 23 | zero default, accept/edit/replace/reject/remove, append-only, CAS |
| `influence-isolation.test.ts` | 14 | the five sentinels, end to end through the real routes |

`npm run test:e2e` → **33 Playwright tests**, all passing. Phase 3 added 20, in
`tests/browser/phase3.spec.ts`: the project opening, artist search with nothing
preselected, the honest no-match state, explicit confirmation, the truthful
loading state, three cards per row with supported context, one empty domain,
both domains unusable, proposal rendering, zero default approvals, edit,
approve, dismiss, explicit replacement, one approval per slot, reload survival,
removal, the foreign-browser refusal, same-origin-only traffic, keyboard
operation, and no clipped action or horizontal overflow at 390 px and 1440 px.

The browser gate mocks **this application's own** API, because
`playwright.config.ts` deliberately starts the app with invalid persistence
sentinels so CI needs no credential and reaches no external service. Every
mocked route is same-origin by construction, which is exactly what the
"no direct upstream call" assertion needs. The route handlers themselves — real
contracts, ownership, cache, limiter, model boundary — are covered by the unit
suite against the in-memory gateway, and the real deployed UI is covered by
`verify:deployment` below.

### CI is unchanged

`.github/workflows/ci.yml` was not modified. No repository secret is read, no
live-service job was added, and the new offline tests run inside the existing
`quality` and `e2e` jobs.

---

## 14. Live proposal and approval smoke

```
RUN_PROPOSAL_SMOKE=1 npm run smoke:proposal   →  exit 0
```

Drives the real route handlers against the real Supabase project, the stored
Qloo captures, and one real model call:

```
session → project → artist search → explicit anchor confirmation →
first hops → one bounded proposal call → one explicit approval
```

| Observation | Value |
|---|---|
| Qloo upstream calls | **0** — answered from the shared captures |
| Model calls | **1** |
| Model | `gpt-4o-mini-2024-07-18` |
| Token usage | 4,247 in · 945 out · 5,192 total |
| Proposals returned | 6 |
| Approval created | **Moon → Discovery**, unedited |
| Project revision at the end | 3 |
| Workflow state | `PROPOSALS_READY` |

The approved interpretation, as the model wrote it and the creator accepted it
unedited, citing `properties.plot_themes_description` on Moon:

> Delve into the themes of identity and memory, emphasizing how the past can be
> blurred and uncertain. Encountering clues within the letter triggers thoughts
> about personal history and what defines a person.

Checks that passed in the same run: every proposal cites evidence belonging to
its own reference; every proposal names a reference this application retrieved;
exactly one influence is approved; the approval froze the proposal's wording
unedited and is labelled a Qloo source; the provenance chain has three layers
and no fourth; one compiler-facing payload was built carrying only that
approval's own evidence, naming no other retrieved reference, and containing no
artist, affinity, or capture id; the approval survives a fresh read; and a
second anonymous owner gets 404 and learns nothing from the refusal.

The call was not re-rolled. The first result is the recorded one.

---

## 15. Deployed verification

```
RUN_DEPLOY_VERIFY=1 DEPLOY_URL=https://firstplayable.vercel.app npm run verify:deployment
  →  exit 0, 54 of 54 checks passed
```

Production URL: **https://firstplayable.vercel.app**

### Pages and the phase 2 surface

Landing page, `/example`, and `/studio` all 200. The full phase 2 HTTP matrix
still passes: session establishment with `HttpOnly` and `Secure`, project
persistence, cross-session denial, byte-identical foreign and nonexistent
envelopes, and every mutation-security refusal, with no credential, host, SQL,
or stack trace in any refusal body.

### Phase 3 over HTTP, against real services

| Check | Observed |
|---|---|
| `POST artist-search` | 200, 5 real candidates, cache `cached` |
| Searching confirms nothing | `anchor_confirmed: false` |
| No affinity or credential in the response | 2,742 bytes scanned, clean |
| Canonical artist confirmable by exact name | Radiohead at rank 1 |
| An artist not in the snapshot cannot be confirmed | 422 |
| `PUT anchor` | 200, Radiohead frozen at rank 1 |
| Confirming approves nothing | 0 approved |
| `POST references` | 200, **upstream calls 0**, 10 usable per domain, both `cached` |
| Real first-hop titles rendered | Children of Men, Being John Malkovich, Moon · Mass Effect 2, Dragon Age: Origins, Mass Effect |
| No affinity, fingerprint, or credential | 20,250 bytes scanned, clean |
| `POST proposals` | 200, 5 proposals, **1 model call**, `repaired: false` |
| Default approved count | 0 |
| `POST decisions` | 200, exactly one approval, slot `discovery` |
| Provenance key set | `approval_id, approved, proposed, retrieved, slot` |
| Approval survives a reload | yes |
| Reference rows rebuilt from stored captures on reload | 3 movie cards |
| Repeating the retrieval | **upstream calls 0** |
| Second anonymous owner at every phase 3 route | 404 · 404 · 404 · 404 · 404, identical |

### Phase 3 in a real browser, against real services

A separate Chromium context created a fresh brief through the studio form and
walked the whole workflow on the live site:

| Check | Observed |
|---|---|
| Real artist results listed, none preselected | 5 options, Confirm disabled |
| Clicking Confirm froze the chosen artist | Radiohead |
| Both domain rows rendered real cards | 3 movie, 3 videogame |
| Cards show retrieved context and no quality score | "Qloo describes" present; no affinity, confidence, `NN%`, or "Qloo recommends/proves/says/knows/generated" |
| Proposals approve nothing by default | the empty-approvals panel was present |
| Clicking Approve froze exactly one influence | `Discovery: Children of Men` |
| Provenance drawer layers | qloo retrieved → firstplayable proposed → creator approved |
| No scene-change claim | absent; "Retrieved for Radiohead" present |
| Approval survived a full page reload | yes |
| Requests | 40, **all same-origin** |
| Direct Qloo, OpenAI, or Supabase request from the browser | **none** |
| Credential or provider host in the rendered page | none |

### Client bundle

8 client chunks scanned: no credential shape, no `*.supabase.co` host, and no
`api.openai.com`.

Nothing in production was intentionally broken to test a failure path. The
destructive and outage branches are covered by the deterministic local and
browser suites.

---

## 16. Deployment secrets

Added to Vercel for Production and Preview, as Sensitive values through the CLI
reading the local environment. No value was printed at any point.

| Variable | Production | Preview | Kind |
|---|---|---|---|
| `SUPABASE_URL` | yes (phase 2) | yes (phase 2) | sensitive |
| `SUPABASE_SECRET_KEY` | yes (phase 2) | yes (phase 2) | sensitive |
| `QLOO_API_KEY` | **added** | **added** | sensitive |
| `QLOO_API_BASE_URL` | **added** | **added** | sensitive |
| `OPENAI_API_KEY` | **added** | **added** | sensitive |
| `OPENAI_CHAT_MODEL` | **added** | **added** | sensitive |

**Deliberately not uploaded:** `SUPABASE_ACCESS_TOKEN` (CLI and migration
tooling only) and the database password (never requested, never entered, never
stored). No `NEXT_PUBLIC_` variant of any of these exists; a test scans every
tracked file for the pattern and `scripts/scan-secrets.ts` scans the built
assets too.

---

## 17. Local gate, from a clean tree

| Command | Result |
|---|---|
| `npm run typecheck` | passed, exit 0 |
| `npm test` | passed, exit 0 — 23 files, **425 tests**, 0 failures |
| `npm run check:fixtures` | passed, exit 0 — all fixture checks passed |
| `npm run build` | passed, exit 0 — 13 routes, 4 static and 9 server-rendered on demand |
| `npm run check:secrets` | passed, exit 0 — 129 tracked and 277 built files scanned |
| `npm run test:e2e` | passed, exit 0 — **33 Playwright tests**, 0 failures |

Live, opt-in, never in CI:

| Command | Result |
|---|---|
| `RUN_QLOO_SMOKE=1 npm run smoke:qloo` | passed, exit 0 |
| `QLOO_SMOKE_ARTIST="Taylor Swift" RUN_QLOO_SMOKE=1 npm run smoke:qloo` | passed, exit 0 |
| `RUN_PROPOSAL_SMOKE=1 npm run smoke:proposal` | passed, exit 0 |
| `RUN_DEPLOY_VERIFY=1 DEPLOY_URL=… npm run verify:deployment` | passed, exit 0 — 54 checks |

---

## 18. What Phase 3 did not build, and does not claim

Not implemented, and verified absent:

* core scene generation, module generation, playable compilation, scene repair,
  scene activation, mechanical witnesses for fresh output, revision generation,
  the `/api/operations/:id/advance` compilation controller — `scene_versions`
  holds 0 rows and no such route exists;
* public sharing, offline HTML export, model-selected comparators,
  publication — `publications` holds 0 rows;
* a third Qloo domain, multi-hop retrieval, trends, audiences, demographics, an
  explainability or compare endpoint, popularity floors, Qloo weights, graph
  traversal, a culture graph, location discovery, affinity as a quality score,
  taste percentages;
* RAG, embeddings, a vector database, LangChain, LangGraph, a multi-agent
  system, MCP, Redis, queue workers, or any new service.

Claims this phase does **not** make:

* that Qloo recommended a mechanic, rated a reference, or knows a creator's
  taste. Affinity is read because it is returned, kept private, and never shown
  as creative confidence;
* that the application detects every silently ignored upstream parameter. It
  detects a contradicted subtype, a contradicted search type, an error-shaped
  200, and a malformed envelope. There is no parameter echo to check;
* that the isolation guarantee is semantic. It is dataflow and ownership
  isolation only;
* that the retrieved references, the proposals, or the approvals are good
  writing. Nothing in this phase evaluates creative quality.

---

## 19. Known limitations of Phase 3

1. **The header-based judging-reserve halt is best-effort within one
   retrieval.** Two first hops launched 250 ms apart may both predate the first
   `x-month-ratelimit-remaining` response. The enforced pre-call guard is the
   local 9,500-call counter.
2. **`qloo_calls.used_calls` under-counts by one.** The first Radiohead smoke
   run predated the script change that made it reserve around its own artist
   search. The route has always reserved; the gap is historical and in the smoke
   script only.
3. **The offline browser suite mocks this application's own API.** It must, to
   stay credential-free and CI-safe. The real deployed UI is exercised by
   `verify:deployment`, which does drive the live services.
4. **Playwright installs only Chromium**, at the revision the pinned
   `@playwright/test@1.56.1` resolves to. Firefox and WebKit are unverified.
   This limitation is inherited from phases 1 and 2.
5. **`supabase db push` still does not work from this machine**, for the two
   reasons in `docs/DEPLOYMENT_PREFLIGHT.md` §2. Migrations are applied through
   the authorised management connection and verified against the live catalog.
6. **The forbidden-attribution check is literal.** It catches an enumerated set
   of sixteen false attributions as complete words or phrases. It does not prove
   the absence of the underlying claim, and it is deliberately **not** applied
   to creator-authored text, which is rendered under "Creator approved" and
   attributed to the creator.
7. **One proposal call was observed, not a distribution.** The live smoke made
   one call and was not re-rolled. No statement about typical proposal quality,
   repair frequency, or token usage variance is supported by one sample.
8. **The canonical Radiohead neighbourhood was present on 4 October 2026.** All
   three historically observed titles per domain still appeared. Nothing in the
   application injects them; a future run that returns different titles is a
   real result, and the smoke reports the comparison rather than requiring it.
9. **Deployment protection is off** for this project, so the deployed
   verification reaches the routes directly. That is a hackathon-judging
   decision, not a security recommendation.
10. **No release smoke across three artists has been run.** Two artists were
    verified live. The three-brief release smoke of specification section 16
    belongs to phase 7.
