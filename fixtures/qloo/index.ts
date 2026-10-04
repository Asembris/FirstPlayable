/**
 * Redacted Qloo captures, taken from the real hackathon Qloo API responses
 * observed on 4 October 2026 for the canonical artist Radiohead. The host is
 * named only in server configuration, never in a module the engine, the
 * domain, or the browser can reach.
 *
 * These are *real response shapes*, not invented ones: the envelope, the field
 * names, the nesting, the `subtype` values, the `query.affinity` block, and the
 * namespaced tag types are all exactly as returned. That is what makes them
 * usable as the deterministic basis for the offline normalization tests.
 *
 * What was removed, and why:
 *
 *   * every `properties.image.url` and every third-party media URL — not read
 *     by the normalizer and not worth committing;
 *   * `properties.external` identifiers on the search rows, replaced with
 *     `"redacted"`, keeping only the *catalogue names* the normalizer turns
 *     into disambiguation hints;
 *   * `properties.websites`, `collaborators`, `production_companies`,
 *     `filming_location`, `akas`, `audience_identity`,
 *     `situational_contexts`, and `player_demographics` — long audience
 *     claims, demographic data, and marketing links that specification
 *     section 6 forbids carrying onward, so they are not stored here either;
 *   * tags outside the three namespaces the normalizer reads;
 *   * floating-point affinity and popularity rounded to six places.
 *
 * No API key, header, or request diagnostic appears in any of these files.
 * Nothing was added: there is no field in these fixtures that the live API did
 * not return.
 */

import moviesRadiohead from "./insights-movies-radiohead.json";
import videogamesRadiohead from "./insights-videogames-radiohead.json";
import searchNoMatch from "./search-no-match.json";
import searchRadiohead from "./search-radiohead.json";

/** The artist UUID the live search returned at rank 1 for "Radiohead". */
export const RADIOHEAD_ENTITY_ID = "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C";

/** The movie the canonical saved example draws its Discovery influence from. */
export const MOON_ENTITY_ID = "6BBB34F4-9345-4459-82AE-10991FA35CD2";

export const QLOO_FIXTURES = {
  searchRadiohead: searchRadiohead as unknown,
  searchNoMatch: searchNoMatch as unknown,
  moviesRadiohead: moviesRadiohead as unknown,
  videogamesRadiohead: videogamesRadiohead as unknown,
} as const;
