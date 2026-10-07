import { describe, expect, it } from "vitest";
import {
  HALCYON_RELAY_ENTITY_ID,
  QLOO_FIXTURES,
  LANTERNFOLD_ENTITY_ID,
} from "../../fixtures/qloo";
import {
  EVIDENCE_CONTEXT_CHARS_PER_CANDIDATE,
  EVIDENCE_ITEM_MAX_CHARS,
  QLOO_NORMALIZER_VERSION,
  supportedContextSentence,
  toPublicCandidate,
  toPublicCapture,
} from "../../src/domain/qloo";
import { sha256Hex } from "../../src/engine/hash";
import {
  artistSearchFingerprint,
  normalizeArtistSearch,
  normalizeQuery,
  normalizeReferences,
  QLOO_NORMALIZE_CODES,
  QlooNormalizeError,
  referenceFingerprint,
  referenceIdFor,
} from "../../src/server/qloo/normalize";

const RETRIEVED_AT = "2026-10-04T10:00:00.000Z";

function searchInput(query = "Lanternfold") {
  const normalizedQuery = normalizeQuery(query);
  return {
    query,
    normalizedQuery,
    requestFingerprint: artistSearchFingerprint({ host: "example.invalid", normalizedQuery }),
    retrievedAt: RETRIEVED_AT,
  };
}

function referencesInput(domain: "movie" | "videogame") {
  return {
    domain,
    artistEntityId: LANTERNFOLD_ENTITY_ID,
    requestFingerprint: referenceFingerprint({
      host: "example.invalid",
      artistEntityId: LANTERNFOLD_ENTITY_ID,
      domain,
    }),
    retrievedAt: RETRIEVED_AT,
  };
}

/** The observed insights envelope, with caller-supplied entity rows. */
function insights(entities: readonly unknown[], success: boolean | undefined = true): unknown {
  return success === undefined
    ? { results: { entities } }
    : { success, results: { entities } };
}

function movieRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: "A Film",
    entity_id: "11111111-2222-4333-8444-555555555555",
    type: "urn:entity",
    subtype: "urn:entity:movie",
    properties: { plot_summary: "Someone finds something they did not expect." },
    ...overrides,
  };
}

describe("query normalization and cache keys", () => {
  it("folds whitespace and case so one artist cannot cost two calls", () => {
    expect(normalizeQuery("  LanternFold ")).toBe("lanternfold");
    expect(normalizeQuery("Lantern  fold")).toBe("lantern fold");
    expect(normalizeQuery("Lanternfold")).toBe(normalizeQuery("LANTERNFOLD"));
  });

  it("keys an artist search on the query, the artist type, and the normalizer version", () => {
    const a = artistSearchFingerprint({ host: "h", normalizedQuery: "lanternfold" });
    expect(a).toContain(QLOO_NORMALIZER_VERSION);
    expect(a).toBe(artistSearchFingerprint({ host: "h", normalizedQuery: "lanternfold" }));
    expect(a).not.toBe(artistSearchFingerprint({ host: "h", normalizedQuery: "metallica" }));
    // A different host is a different key: a base-URL change cannot be served
    // out of a capture taken elsewhere.
    expect(a).not.toBe(artistSearchFingerprint({ host: "other", normalizedQuery: "lanternfold" }));
  });

  it("keys a first hop on the host, the artist, the domain, and the parameters", () => {
    const movie = referenceFingerprint({
      host: "h",
      artistEntityId: LANTERNFOLD_ENTITY_ID,
      domain: "movie",
    });
    const game = referenceFingerprint({
      host: "h",
      artistEntityId: LANTERNFOLD_ENTITY_ID,
      domain: "videogame",
    });
    expect(movie).not.toBe(game);
    expect(movie).toMatch(/^movies\|/);
    expect(game).toMatch(/^videogames\|/);
    // Case cannot split one artist's cache entry in two.
    expect(movie).toBe(
      referenceFingerprint({
        host: "h",
        artistEntityId: LANTERNFOLD_ENTITY_ID.toLowerCase(),
        domain: "movie",
      }),
    );
  });

  it("gives a reference an application address that is not a Qloo UUID", () => {
    const id = referenceIdFor("movie", HALCYON_RELAY_ENTITY_ID);
    expect(id).toMatch(/^ref\.mv\.[0-9a-f]{16}$/);
    expect(id).not.toContain(HALCYON_RELAY_ENTITY_ID);
    expect(id).not.toContain(HALCYON_RELAY_ENTITY_ID.toLowerCase());
    // Stable across captures, so an approval survives a refetch.
    expect(id).toBe(referenceIdFor("movie", HALCYON_RELAY_ENTITY_ID.toLowerCase()));
    expect(id).not.toBe(referenceIdFor("videogame", HALCYON_RELAY_ENTITY_ID));
  });
});

describe("artist search normalization, against the synthetic fixture shape", () => {
  it("preserves the returned order and the confirmed identity", () => {
    const snapshot = normalizeArtistSearch(QLOO_FIXTURES.searchLanternfold, searchInput());
    expect(snapshot.candidates).toHaveLength(5);
    expect(snapshot.candidates[0]?.entity_id).toBe(LANTERNFOLD_ENTITY_ID);
    expect(snapshot.candidates[0]?.name).toBe("Lanternfold");
    expect(snapshot.candidates.map((c) => c.original_rank)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.normalizer_version).toBe(QLOO_NORMALIZER_VERSION);
    expect(snapshot.retrieved_at).toBe(RETRIEVED_AT);
  });

  it("keeps enough context to disambiguate five artists with similar names", () => {
    const snapshot = normalizeArtistSearch(QLOO_FIXTURES.searchLanternfold, searchInput());
    // The synthetic payload returns the band plus four acts named after it.
    const names = snapshot.candidates.map((c) => c.name);
    expect(names[0]).toBe("Lanternfold");
    expect(names.slice(1).every((name) => name !== "Lanternfold")).toBe(true);
    expect(snapshot.candidates[0]?.short_description).toContain("art-rock band");
    expect(snapshot.candidates[0]?.identity_hints).toContain("musicbrainz");
  });

  it("exposes catalogue names only, never a listener count or a popularity score", () => {
    const snapshot = normalizeArtistSearch(QLOO_FIXTURES.searchLanternfold, searchInput());
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("popularity");
    expect(serialized).not.toContain("listeners");
    expect(serialized).not.toContain("scrobbles");
    for (const hint of snapshot.candidates[0]?.identity_hints ?? []) {
      expect(hint).toMatch(/^[a-z]+$/);
    }
  });

  it("returns an empty candidate list for a query with no match", () => {
    const snapshot = normalizeArtistSearch(QLOO_FIXTURES.searchNoMatch, searchInput("zzqxvno"));
    expect(snapshot.candidates).toEqual([]);
  });

  it("drops a row whose entity id is not a well-formed UUID", () => {
    const snapshot = normalizeArtistSearch(
      { results: [{ name: "Broken", entity_id: "not-a-uuid", types: ["urn:entity:artist"] }] },
      searchInput(),
    );
    expect(snapshot.candidates).toEqual([]);
  });

  it("drops a row with no name", () => {
    const snapshot = normalizeArtistSearch(
      {
        results: [
          { name: "   ", entity_id: "11111111-2222-4333-8444-555555555555", types: ["urn:entity:artist"] },
        ],
      },
      searchInput(),
    );
    expect(snapshot.candidates).toEqual([]);
  });

  it("fails when a returned row declares a type nobody asked for", () => {
    expect(() =>
      normalizeArtistSearch(
        {
          results: [
            {
              name: "Not an artist",
              entity_id: "11111111-2222-4333-8444-555555555555",
              types: ["urn:entity:movie"],
            },
          ],
        },
        searchInput(),
      ),
    ).toThrow(
      expect.objectContaining({ code: QLOO_NORMALIZE_CODES.SEARCH_TYPE_MISMATCH }) as Error,
    );
  });

  it("fails on an error-shaped HTTP 200", () => {
    expect(() =>
      normalizeArtistSearch({ success: false, error: "nope" }, searchInput()),
    ).toThrow(
      expect.objectContaining({ code: QLOO_NORMALIZE_CODES.ERROR_SHAPED_SUCCESS }) as Error,
    );
  });

  it("fails on an envelope that is not the observed shape", () => {
    for (const body of [null, 7, "text", {}, { results: { entities: [] } }]) {
      expect(() => normalizeArtistSearch(body, searchInput())).toThrow(QlooNormalizeError);
    }
  });
});

describe("first-hop movie normalization, against the synthetic fixture shape", () => {
  const capture = normalizeReferences(QLOO_FIXTURES.moviesLanternfold, referencesInput("movie"));

  it("normalizes all ten returned rows with their original ranks", () => {
    expect(capture.candidates).toHaveLength(10);
    expect(capture.candidates.map((c) => c.original_rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(capture.kind).toBe("movies");
    expect(capture.domain).toBe("movie");
    expect(capture.artist_entity_id).toBe(LANTERNFOLD_ENTITY_ID);
    expect(capture.duplicates_dropped).toBe(0);
    expect(capture.malformed_rows).toBe(0);
  });

  it("recovers the Halcyon Relay identity and its duplicate-identity context", () => {
    const halcyon = capture.candidates.find((c) => c.name === "Halcyon Relay");
    expect(halcyon?.entity_id).toBe(HALCYON_RELAY_ENTITY_ID);
    expect(halcyon?.year).toBe(2009);
    expect(halcyon?.usable).toBe(true);
    const text = (halcyon?.evidence ?? []).map((item) => item.text).join(" ");
    // The context the specification cites comes from a returned field, not
    // from a model and not from this repository.
    expect(text).toMatch(/identical man|duplicate/i);
    expect(halcyon?.evidence.some((item) => item.field_path === "properties.plot_summary")).toBe(
      true,
    );
  });

  it("records the first three usable titles in returned order", () => {
    const names = capture.candidates
      .filter((c) => c.usable)
      .slice(0, 3)
      .map((c) => c.name);
    expect(names).toEqual(["Ashfall Covenant", "The Borrowed Window", "Halcyon Relay"]);
  });

  it("names the observed field path and hashes the full original text", () => {
    for (const candidate of capture.candidates) {
      for (const item of candidate.evidence) {
        expect(item.field_path).toMatch(/^(properties|tags)\./);
        expect(item.id.startsWith(`${candidate.reference_id}#ev`)).toBe(true);
        expect(item.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(item.text.length).toBeLessThanOrEqual(EVIDENCE_ITEM_MAX_CHARS);
        if (!item.truncated) expect(item.hash).toBe(sha256Hex(item.text));
      }
    }
  });

  it("keeps each candidate inside the per-candidate context budget", () => {
    for (const candidate of capture.candidates) {
      const total = candidate.evidence.reduce((sum, item) => sum + item.text.length, 0);
      expect(total).toBeLessThanOrEqual(EVIDENCE_CONTEXT_CHARS_PER_CANDIDATE);
    }
  });

  it("carries no image, website, audience, or demographic field onward", () => {
    // Checked on the field paths and on the JSON keys, not on substrings of
    // returned prose: a plot summary may legitimately contain the word "image".
    const forbidden = [
      "properties.image",
      "properties.websites",
      "properties.audience_identity",
      "properties.situational_contexts",
      "properties.player_demographics",
      "properties.collaborators",
      "properties.production_companies",
      "properties.filming_location",
    ];
    const paths = capture.candidates.flatMap((c) => c.evidence.map((item) => item.field_path));
    for (const path of forbidden) {
      expect(paths.includes(path), path).toBe(false);
    }
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (typeof value === "object" && value !== null) {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          collect(nested);
        }
      }
    };
    collect(capture);
    for (const path of forbidden) {
      expect(keys.has(path.replace("properties.", "")), path).toBe(false);
    }
  });

  it("records the returned affinity privately and strips it from every public view", () => {
    const withAffinity = capture.candidates.filter((c) => c.affinity !== null);
    expect(withAffinity.length).toBeGreaterThan(0);
    const publicCapture = toPublicCapture({ ...capture, capture_id: null, cache: "live" });
    expect(JSON.stringify(publicCapture)).not.toContain("affinity");
    expect("affinity" in toPublicCandidate(capture.candidates[0]!)).toBe(false);
  });

  it("records that the response carried no parameter echo", () => {
    // Absence is recorded, never read as proof the parameters were applied.
    expect(capture.echo_available).toBe(false);
    expect(capture.request_fingerprint).toContain(QLOO_NORMALIZER_VERSION);
  });

  it("builds a card sentence only out of one returned field", () => {
    const halcyon = capture.candidates.find((c) => c.name === "Halcyon Relay")!;
    const sentence = supportedContextSentence(toPublicCandidate(halcyon));
    expect(sentence).not.toBeNull();
    const source = halcyon.evidence.find((item) => item.kind === "plot")!;
    expect(source.text.startsWith(sentence!.replace(/…$/, ""))).toBe(true);
  });
});

describe("first-hop videogame normalization, against the synthetic fixture shape", () => {
  const capture = normalizeReferences(
    QLOO_FIXTURES.videogamesLanternfold,
    referencesInput("videogame"),
  );

  it("normalizes the verified urn:entity:videogame rows", () => {
    expect(capture.kind).toBe("videogames");
    expect(capture.candidates).toHaveLength(10);
    const names = capture.candidates
      .filter((c) => c.usable)
      .slice(0, 3)
      .map((c) => c.name);
    expect(names).toEqual(["Starward Accord II", "Emberfall: Oaths", "Starward Accord"]);
  });

  it("derives a year from the returned release date and never invents one", () => {
    expect(capture.candidates[0]?.year).toBe(2010);
    const noDate = normalizeReferences(
      insights([
        {
          name: "Undated Game",
          entity_id: "22222222-3333-4444-8555-666666666666",
          subtype: "urn:entity:videogame",
          properties: { description: "A game with no release date in the payload." },
        },
      ]),
      referencesInput("videogame"),
    );
    expect(noDate.candidates[0]?.year).toBeNull();
    expect(noDate.candidates[0]?.usable).toBe(true);
  });

  it("accepts thin game metadata as usable without enriching it", () => {
    const thin = normalizeReferences(
      insights([
        {
          name: "Tag Only Game",
          entity_id: "33333333-4444-4555-8666-777777777777",
          subtype: "urn:entity:videogame",
          properties: { audience_tags: ["moral choices", "branching narrative"] },
        },
      ]),
      referencesInput("videogame"),
    );
    const candidate = thin.candidates[0]!;
    expect(candidate.usable).toBe(true);
    expect(candidate.evidence).toHaveLength(1);
    expect(candidate.evidence[0]?.field_path).toBe("properties.audience_tags");
    expect(candidate.evidence[0]?.text).toBe("moral choices, branching narrative");
    // Nothing was added: no description appeared where the payload had none.
    expect(candidate.missing_fields).toContain("properties.description");
  });

  it("marks an identity-only row unusable rather than writing context for it", () => {
    const identityOnly = normalizeReferences(
      insights([
        {
          name: "Identity Only",
          entity_id: "44444444-5555-4666-8777-888888888888",
          subtype: "urn:entity:videogame",
          properties: {},
        },
      ]),
      referencesInput("videogame"),
    );
    const candidate = identityOnly.candidates[0]!;
    expect(candidate.usable).toBe(false);
    expect(candidate.unusable_reason).toBe("no_usable_context");
    expect(candidate.evidence).toEqual([]);
    expect(candidate.missing_fields.length).toBeGreaterThan(5);
  });
});

describe("first-hop defences", () => {
  it("fails the whole capture when a returned subtype contradicts the request", () => {
    // HTTP 200 does not prove filter.type was applied. A contradicted subtype
    // is the signal that it was not.
    expect(() =>
      normalizeReferences(
        insights([movieRow({ subtype: "urn:entity:videogame" })]),
        referencesInput("movie"),
      ),
    ).toThrow(expect.objectContaining({ code: QLOO_NORMALIZE_CODES.DOMAIN_MISMATCH }) as Error);
  });

  it("fails the capture even when only a later row contradicts the request", () => {
    expect(() =>
      normalizeReferences(
        insights([
          movieRow(),
          movieRow({
            entity_id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
            subtype: "urn:entity:videogame",
          }),
        ]),
        referencesInput("movie"),
      ),
    ).toThrow(expect.objectContaining({ code: QLOO_NORMALIZE_CODES.DOMAIN_MISMATCH }) as Error);
  });

  it("fails on an error-shaped HTTP 200", () => {
    expect(() => normalizeReferences(insights([], false), referencesInput("movie"))).toThrow(
      expect.objectContaining({ code: QLOO_NORMALIZE_CODES.ERROR_SHAPED_SUCCESS }) as Error,
    );
  });

  it("fails on an envelope without results.entities", () => {
    for (const body of [{ success: true }, { success: true, results: {} }, { results: [] }]) {
      expect(() => normalizeReferences(body, referencesInput("movie"))).toThrow(
        expect.objectContaining({ code: QLOO_NORMALIZE_CODES.ENVELOPE_UNEXPECTED }) as Error,
      );
    }
  });

  it("drops and counts a row with a malformed required identity", () => {
    const capture = normalizeReferences(
      insights([
        movieRow({ entity_id: "not-a-uuid" }),
        movieRow({ entity_id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb", name: "" }),
        movieRow({ entity_id: "88888888-9999-4aaa-8bbb-cccccccccccc", subtype: null }),
        movieRow({ entity_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd", name: "Good Row" }),
      ]),
      referencesInput("movie"),
    );
    expect(capture.malformed_rows).toBe(3);
    expect(capture.candidates).toHaveLength(1);
    expect(capture.candidates[0]?.name).toBe("Good Row");
    // The surviving row keeps the rank it was returned at, gap included.
    expect(capture.candidates[0]?.original_rank).toBe(4);
  });

  it("deduplicates by entity id and counts what it dropped", () => {
    const duplicate = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const capture = normalizeReferences(
      insights([
        movieRow({ entity_id: duplicate, name: "First" }),
        movieRow({ entity_id: duplicate.toLowerCase(), name: "Same Entity Again" }),
        movieRow({ entity_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", name: "Second" }),
      ]),
      referencesInput("movie"),
    );
    expect(capture.duplicates_dropped).toBe(1);
    expect(capture.candidates.map((c) => c.name)).toEqual(["First", "Second"]);
    expect(capture.candidates.map((c) => c.original_rank)).toEqual([1, 3]);
  });

  it("reads at most the requested number of rows even if more come back", () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      movieRow({
        entity_id: `0000000${index.toString(16).padStart(1, "0")}-1111-4222-8333-444444444444`
          .slice(-36)
          .padStart(36, "0"),
        name: `Row ${index}`,
      }),
    );
    const capture = normalizeReferences(insights(rows), referencesInput("movie"));
    expect(capture.candidates.length).toBeLessThanOrEqual(10);
  });

  it("ignores an unknown upstream field instead of failing", () => {
    const capture = normalizeReferences(
      insights([movieRow({ brand_new_upstream_field: { nested: true } })]),
      referencesInput("movie"),
    );
    expect(capture.candidates).toHaveLength(1);
    expect(JSON.stringify(capture)).not.toContain("brand_new_upstream_field");
  });

  it("tolerates an insights envelope with no success field", () => {
    const capture = normalizeReferences(
      insights([movieRow()], undefined),
      referencesInput("movie"),
    );
    expect(capture.candidates).toHaveLength(1);
  });
});
