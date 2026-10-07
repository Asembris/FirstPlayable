# Saved audience audition: The Last Signal

Captured 7 October 2026. One fixed candidate set, one audience pair, no selection probe and no resampling. The initial transport attempt failed TLS verification before retrieval; the same run succeeded with Node's Windows system certificate trust enabled. TLS verification remained on.

The creator-selected concept is an exploration game about decoding an abandoned orbital station's final message. Movie references: Moon (2009), Arrival (2016), Interstellar (2014). Game references: Outer Wilds (2019), Death Stranding (2019), Mass Effect (2007). Both domains use Radiohead and Kendrick Lamar, confirmed by exact name from Qloo search captures. The concept and reference choices are creative framing, not Qloo project-fit evidence.

`fixtures/qloo/audition/selection.json` records the identities frozen before scoring. `fixtures/qloo/audition/canonical.json` contains redacted Qloo responses retaining original identity and affinity fields, exact credential-free request URLs, UTC retrieval timestamps, original HTTP-body SHA-256 digests, normalizer versions, request fingerprints and normalized captures. Capture UUIDs are locally assigned provenance identifiers, not Qloo-issued request IDs. The body digests identify the original wire text; whitespace of that text is not retained. Integrity tests re-normalize the redacted responses instead. Unused image, tag, marketing and descriptive fields are omitted; captured identities and affinities are unchanged.

The successful run used twelve Qloo calls: six comp searches, two artist searches, four candidate-filtered insights requests. No OpenAI calls. Each insights request scores exactly three frozen comps for one audience in one domain. Raw responses are imported only by the server-side saved projection; the browser receives the same minimal ScoreResponse as the live path.

| Domain / pair | Radiohead | Kendrick Lamar | Deterministic call |
| --- | --- | --- | --- |
| Moon / Arrival | 0.927710 / 0.835544 | 0.722093 / 0.822660 | Reversed |
| Moon / Interstellar | 0.927710 / 0.811855 | 0.722093 / 0.755879 | Reversed |
| Arrival / Interstellar | 0.835544 / 0.811855 | 0.822660 / 0.755879 | Close, no call |
| Outer Wilds / Death Stranding | 0.670337 / 0.537880 | 0.518036 / 0.639281 | Reversed |
| Outer Wilds / Mass Effect | 0.670337 / 0.880901 | 0.518036 / 0.612591 | Holds |
| Death Stranding / Mass Effect | 0.537880 / 0.880901 | 0.639281 / 0.612591 | Close, no call |

Full precision values in captures drive comparison. The under-0.03 close threshold is a display rule, never statistical significance. Movies and games remain separate. Both saved replay and live handlers call `domainAuditionView`, which calls the unchanged `compareAudiences`. No stored rankings or hand-entered affinities exist.

Replay: `/audition` loads the saved comparison without session, database, Qloo or OpenAI calls. Audience buttons change the reading focus and position movement; both audience orders remain visible. Evidence drawers identify the confirmed entities and filtered requests. `/audition?mode=live` or Try your own opens the creator flow; session readiness gates its first request.
