/**
 * SYNTHETIC Qloo-shaped payloads for the offline normalization, client, cache
 * and route tests.
 *
 * Nothing in these files was retrieved from Qloo. The artist "Lanternfold",
 * every film and videogame, every entity id, every description, keyword, tag,
 * affinity and popularity value is invented. What they do reproduce is the
 * *response shape* the live API was observed to return and the production
 * normalizer reads: the `{ results: [...] }` search envelope, the
 * `{ success, results: { entities } }` insights envelope, `subtype`,
 * `query.affinity`, the namespaced tag types, `properties.external` catalogue
 * names, and the movie and videogame property fields in the order the
 * normalizer prefers them.
 *
 * The cases the tests rely on are deliberate:
 *
 *   * the artist search returns the exact match at rank 1 plus four similarly
 *     named acts, so confirmation must stay an explicit choice;
 *   * both insights payloads return ten rows; the movie at rank 3,
 *     "Halcyon Relay", carries duplicate-identity context in its
 *     `plot_summary`, and one movie description is longer than the
 *     per-item evidence limit, so truncation is exercised;
 *   * game metadata is thinner than movie metadata, as in the live API;
 *   * `search-no-match.json` is the empty result envelope.
 *
 * Entity ids follow visibly patterned UUIDs (`5A…` artists, `5B…` movies,
 * `5C…` videogames) so they cannot be mistaken for Qloo-issued identifiers.
 * No API key, header, or request diagnostic appears in any of these files.
 */

import moviesLanternfold from "./insights-movies-lanternfold.json";
import videogamesLanternfold from "./insights-videogames-lanternfold.json";
import searchLanternfold from "./search-lanternfold.json";
import searchNoMatch from "./search-no-match.json";

/** The synthetic artist the synthetic search returns at rank 1 for "Lanternfold". */
export const LANTERNFOLD_ENTITY_ID = "5A000000-0000-4000-8000-000000000001";

/** The synthetic movie the saved example draws its Discovery influence from. */
export const HALCYON_RELAY_ENTITY_ID = "5B000000-0000-4000-8000-000000000003";

export const QLOO_FIXTURES = {
  searchLanternfold: searchLanternfold as unknown,
  searchNoMatch: searchNoMatch as unknown,
  moviesLanternfold: moviesLanternfold as unknown,
  videogamesLanternfold: videogamesLanternfold as unknown,
} as const;
