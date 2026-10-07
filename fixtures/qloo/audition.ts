/**
 * SYNTHETIC test payloads for the comp audition.
 *
 * Like the Lanternfold payloads beside this file, these are **not** recorded
 * responses. They are written in the envelope shapes the live API was observed
 * to return (`{ results: [...] }` for search, `{ success, results: { entities } }`
 * for insights, `subtype`, `query.affinity`), and every affinity value below is
 * made up for the test that uses it. They must never be shown as Qloo
 * evidence, and no browser surface imports them.
 *
 * The first audience is the synthetic Lanternfold artist from
 * `search-lanternfold.json`, so the audience search can reuse that payload.
 * Every id is a synthetic UUID.
 */

import { LANTERNFOLD_ENTITY_ID } from "./index";

export { LANTERNFOLD_ENTITY_ID };
export const KENDRICK_ENTITY_ID = "A0000000-0000-4000-8000-0000000000A1";
export const METALLICA_ENTITY_ID = "A0000000-0000-4000-8000-0000000000A2";

export const MOON_ID = "B0000000-0000-4000-8000-0000000000B1";
export const MOON_SEQUEL_ID = "B0000000-0000-4000-8000-0000000000B9";
export const ARRIVAL_ID = "B0000000-0000-4000-8000-0000000000B2";
export const O_BROTHER_ID = "B0000000-0000-4000-8000-0000000000B3";
export const OUTER_WILDS_ID = "C0000000-0000-4000-8000-0000000000C1";
export const DEATH_STRANDING_ID = "C0000000-0000-4000-8000-0000000000C2";

function artistSearch(rows: readonly [string, string, string][]): unknown {
  return {
    results: rows.map(([entity_id, name, description]) => ({
      name,
      entity_id,
      types: ["urn:entity:artist"],
      disambiguation: name,
      properties: { short_description: description, external: {} },
    })),
  };
}

function compSearch(type: string, rows: readonly [string, string, number | null][]): unknown {
  return {
    results: rows.map(([entity_id, name, year]) => ({
      name,
      entity_id,
      types: [type],
      disambiguation: year === null ? null : String(year),
      properties: year === null ? {} : { release_year: year },
    })),
  };
}

/** An insights envelope scoring exactly the given entities, in the given order. */
export function insights(
  subtype: "urn:entity:movie" | "urn:entity:videogame",
  rows: readonly [string, string, number | null][],
): unknown {
  return {
    success: true,
    results: {
      entities: rows.map(([entity_id, name, affinity]) => ({
        name,
        entity_id,
        type: "urn:entity",
        subtype,
        properties: {},
        query: affinity === null ? {} : { affinity },
      })),
    },
  };
}

export const AUDITION_FIXTURES = {
  searchKendrick: artistSearch([
    [KENDRICK_ENTITY_ID, "Kendrick Lamar", "An American rapper."],
  ]),
  searchMetallica: artistSearch([
    [METALLICA_ENTITY_ID, "Metallica", "An American heavy metal band."],
  ]),
  searchMoon: compSearch("urn:entity:movie", [
    [MOON_ID, "Moon", 2009],
    [MOON_SEQUEL_ID, "Moonrise Kingdom", 2012],
  ]),
  searchArrival: compSearch("urn:entity:movie", [[ARRIVAL_ID, "Arrival", 2016]]),
  searchOBrother: compSearch("urn:entity:movie", [
    [O_BROTHER_ID, "O Brother, Where Art Thou?", 2000],
  ]),
  searchOuterWilds: compSearch("urn:entity:videogame", [[OUTER_WILDS_ID, "Outer Wilds", 2019]]),
  searchDeathStranding: compSearch("urn:entity:videogame", [
    [DEATH_STRANDING_ID, "Death Stranding", 2019],
  ]),
  /** A movie search that came back typed as a videogame: the silent-type case. */
  searchMoonWrongType: compSearch("urn:entity:videogame", [[MOON_ID, "Moon", 2009]]),
} as const;
