# Saved audience audition: The Last Signal

**Synthetic deterministic demonstration.** The saved `/audition` example contains no Qloo data. Every title, artist, entity ID, affinity, request fingerprint, digest and timestamp in `fixtures/qloo/audition/` is invented and written in the response shapes the production normalizers accept. It is not a Qloo response and was never retrieved from Qloo. (Until 7 October 2026 this example was a redacted real Qloo capture; it was replaced so that no Qloo response data is published in the repository.)

The creator-selected concept is an exploration game about decoding an abandoned orbital station's final message. Invented movie comps: Quiet Orbit (2009), First Hello (2016), Farther Than Light (2014). Invented game comps: Orrery Vale (2019), Courier of Ash (2019), Starward Accord (2007). Invented audiences: Lanternfold and Juno Kestrel, each confirmed by exact name from a synthetic artist search. The concept and comp choices are creative framing, not Qloo project-fit evidence.

`fixtures/qloo/audition/selection.json` records the identities frozen before scoring. `fixtures/qloo/audition/canonical.json` holds twelve synthetic raw responses (six comp searches, two artist searches, four candidate-filtered insights responses), their request URLs on the reserved `qloo.invalid` host, synthetic retrieval timestamps, the SHA-256 of each synthetic body as serialized, normalizer versions, request fingerprints computed by the production fingerprint functions, and the normalized captures the production normalizers produce from those bodies. The first movie search returns two films with the same name and different years, so identity confirmation still has to disambiguate by year. `tests/server/audition-saved.test.ts` re-normalizes every raw response and requires it to equal the stored capture.

The invented affinities reproduce the comparison cases the saved example has to show:

| Domain / pair | Lanternfold | Juno Kestrel | Deterministic call |
| --- | --- | --- | --- |
| Quiet Orbit / First Hello | 0.913482 / 0.846217 | 0.701364 / 0.808571 | Reversed |
| Quiet Orbit / Farther Than Light | 0.913482 / 0.829905 | 0.701364 / 0.744018 | Reversed |
| First Hello / Farther Than Light | 0.846217 / 0.829905 | 0.808571 / 0.744018 | Close, no call |
| Orrery Vale / Courier of Ash | 0.684120 / 0.552907 | 0.503388 / 0.651742 | Reversed |
| Orrery Vale / Starward Accord | 0.684120 / 0.871346 | 0.503388 / 0.629015 | Holds |
| Courier of Ash / Starward Accord | 0.552907 / 0.871346 | 0.651742 / 0.629015 | Close, no call |

Full precision values in the fixture drive comparison. The under-0.03 close threshold is a display rule, never statistical significance. Movies and games remain separate. Both saved replay and live handlers call `domainAuditionView`, which calls the unchanged `compareAudiences`. No stored rankings exist; the saved affinities are invented inputs to the same deterministic logic.

Replay: `/audition` loads the saved comparison without session, database, Qloo or OpenAI calls, and labels it as synthetic demonstration data. Audience buttons change the reading focus and position movement; both audience orders remain visible. Evidence drawers show the synthetic entities and filtered requests. `/audition?mode=live` or Try your own opens the creator flow, which searches and scores with live Qloo; session readiness gates its first request.
