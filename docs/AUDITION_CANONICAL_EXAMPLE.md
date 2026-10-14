# The default audience audition: The Last Signal

**Recorded Qloo evidence.** The `/audition` default is a real Qloo
comparison. Every entity id, title, artist name and affinity in
`evidence/qloo/audition/recorded-2026-10-07.json` is a value Qloo returned, in
one bounded retrieval run on 7 October 2026 through the production client
(`src/server/qloo/client.ts`) and the production normalizers
(`src/server/qloo/audition.ts`). Replaying it makes no provider call and needs
no credential, so the default demo opens instantly and offline.

The invented record that stood behind this surface between 7 October 2026 and
this change is still committed, still labelled synthetic, and still reachable
at `/audition?mode=synthetic`; it is what the offline tests use. See
"The synthetic record" below.

## The run

The creator-selected concept is an exploration game about decoding an
abandoned orbital station's final message. Movie comps: **Moon** (2009),
**Arrival** (2016), **Interstellar** (2014). Game comps: **Outer Wilds**
(2019), **Death Stranding** (2019), **Mass Effect** (2007). Audiences:
**Radiohead** and **Kendrick Lamar**. The concept and the comp choices are
creative framing by the creator, not Qloo project-fit evidence.

Twelve upstream HTTP calls, in order: six `/search` requests (one per comp,
`types=urn:entity:movie` or `urn:entity:videogame`, `take=5`), two `/search`
requests for the audiences (`types=urn:entity:artist`), and four
`/v2/insights` requests — one per domain per audience, each with
`filter.results.entities` set to exactly the confirmed candidate ids of that
domain. Each comp was confirmed by exact name and release year out of its own
search response, and each audience by exact artist name, before anything was
scored. Qloo returned a score for every requested entity; no capture has a
missing id.

## What Qloo returned

| Domain / pair | Radiohead | Kendrick Lamar | Deterministic call |
| --- | --- | --- | --- |
| Moon / Arrival | 0.927710 / 0.835544 | 0.722093 / 0.822660 | Reversed |
| Moon / Interstellar | 0.927710 / 0.811855 | 0.722093 / 0.755879 | Reversed |
| Arrival / Interstellar | 0.835544 / 0.811855 | 0.822660 / 0.755879 | Close, no call |
| Outer Wilds / Death Stranding | 0.670337 / 0.537880 | 0.518036 / 0.639281 | Reversed |
| Outer Wilds / Mass Effect | 0.670337 / 0.880901 | 0.518036 / 0.612591 | Holds |
| Death Stranding / Mass Effect | 0.537880 / 0.880901 | 0.639281 / 0.612591 | Close, no call |

Full returned precision drives the comparison; the table is rounded for
reading. The under-0.03 close threshold is a display rule of this
application, never statistical significance and never a Qloo-supplied
confidence value. Movies and games are compared separately.

The fixed example question is *"Which movie comp should I foreground for
Radiohead fans?"* The answer — **Moon is the clear lead** — is computed by
`decideForeground` from the ranking on the page, and the Kendrick Lamar games
column shows the other outcome: its top two sit within 0.03, so the tool says
*close at the top — no single lead* instead of picking one.

Nothing about that is stored. The record holds identities and affinities only;
`domainAuditionView` → `compareAudiences` → `decideForeground` produce every
ordering, close call, reversal and decision at render time, and they are the
same functions the live path uses.

## Evidence integrity

| Mechanism | Where |
|---|---|
| SHA-256 over the whole record, affinities pinned to twelve decimals, recomputed at module load; a mismatch refuses the load | `src/presentation/recorded-audition.ts` |
| Every stored request fingerprint recomputed by the production fingerprint functions from the stored host, domain, audience and candidate ids | `tests/presentation/recorded-audition.test.ts` |
| Each capture re-checked against the confirmed identities: Qloo's name per confirmed entity, requested set equals the confirmed comps of that domain, missing ids consistent with scores | `src/presentation/recorded-audition.ts` |
| Exact affinities, rankings, verdicts and the decision pinned and recomputed through `compareAudiences` and `decideForeground` | `tests/presentation/recorded-audition.test.ts` |
| Tamper cases: an edited affinity, a swapped audience id, and a renamed title with a freshly computed digest, each refused | `tests/presentation/recorded-audition.test.ts` |
| No raw response body, credential, or unused provider metadata in the record; no stored ordering or verdict | `tests/presentation/recorded-audition.test.ts` |

Raw Qloo response bodies are **not** committed. The record keeps only the
normalized identity and affinity evidence the product displays, plus the
SHA-256 of each original wire body as provenance. `evidence/qloo/audition/README.md`
states the boundary.

## The synthetic record

`fixtures/qloo/audition/canonical.json` and `selection.json` are invented:
twelve synthetic raw responses on the reserved `qloo.invalid` host, synthetic
identities (Quiet Orbit, First Hello, Farther Than Light; Orrery Vale, Courier
of Ash, Starward Accord; Lanternfold and Juno Kestrel), synthetic affinities
and timestamps, written in the shapes the production normalizers accept. None
of it was returned by Qloo. `tests/engine/fixtures.test.ts` fails if any id
under `fixtures/qloo/` is not a patterned synthetic UUID, and
`tests/server/audition-saved.test.ts` re-normalizes every synthetic response
through the production normalizers.

It is reachable at `/audition?mode=synthetic`, where the mode label, the
decision basis, the evidence drawer and every entity line say so.

## The three ways in

| Path | Evidence | Provider calls |
|---|---|---|
| `/audition` | Recorded Qloo evidence, 7 October 2026 | None |
| `/audition?mode=synthetic` | Invented demonstration record | None |
| `/audition?mode=live`, or **Try your own** | Live Qloo search and insights for the comps and audiences the creator confirms | One search per new name, then up to four insights requests; session readiness gates the first request |

Audience buttons change the reading focus and the position movement; both
audience orders stay visible in every mode.
