/**
 * Unit tests for `parseAcs` (src/db/backfill-population-core.ts) — the pure Census ACS5 response parser
 * that turns the API's header+rows matrix into { geoid, population } pairs for the population backfill.
 *
 * Why this is worth pinning (audit 2026-07-24, db LOW test-gap): the geoid is ASSEMBLED by concatenating
 * geography columns, and it used to take "every column that isn't the population variable, in HEADER
 * order". That is right for the three shapes we actually request today and silently wrong for anything
 * else — a caller adding `NAME` to the `get=` list would have concatenated "Los Angeles city, California"
 * into the geoid, and a Census column reshuffle ("county" emitted before "state") would have produced
 * "03706". Neither throws: a bad geoid just makes the UPDATE match zero jurisdiction rows, so the backfill
 * reports "fetched N, updated 0" and the operator has no idea why.
 *
 * The hardening is a FIXED whitelist + order (ACS_GEO_COLUMNS = state, county, place), so the tests below
 * assert the two properties that whitelist buys — an unlisted column is IGNORED and the geoid follows the
 * whitelist order, not header order — alongside the row-level filters.
 *
 * Pure functions: no DB, no network, no fakes.
 */

import { describe, expect, it } from "vitest"
import { ACS_POP_VAR, parseAcs } from "../../src/db/backfill-population-core.js"

/** The three real request shapes, as the Census API returns them (header row first, values as strings). */
const STATE_RESPONSE: unknown[][] = [
  [ACS_POP_VAR, "state"],
  ["39029342", "06"],
  ["29145505", "48"],
]

const COUNTY_RESPONSE: unknown[][] = [
  [ACS_POP_VAR, "state", "county"],
  ["9848406", "06", "037"],
  ["3269973", "06", "073"],
]

const PLACE_RESPONSE: unknown[][] = [
  [ACS_POP_VAR, "state", "place"],
  ["3822238", "06", "44000"],
  ["1381162", "06", "66000"],
]

describe("parseAcs geoid assembly", () => {
  it("state responses yield the 2-digit state FIPS", () => {
    expect(parseAcs(STATE_RESPONSE)).toEqual([
      { geoid: "06", population: 39029342 },
      { geoid: "48", population: 29145505 },
    ])
  })

  it("county responses concatenate state + county into the 5-digit FIPS", () => {
    expect(parseAcs(COUNTY_RESPONSE)).toEqual([
      { geoid: "06037", population: 9848406 },
      { geoid: "06073", population: 3269973 },
    ])
  })

  it("place responses concatenate state + place into the 7-digit FIPS", () => {
    expect(parseAcs(PLACE_RESPONSE)).toEqual([
      { geoid: "0644000", population: 3822238 },
      { geoid: "0666000", population: 1381162 },
    ])
  })

  it("IGNORES a NAME column instead of concatenating it into the geoid", () => {
    // The whole point of ACS_GEO_COLUMNS: `NAME` is neither the population variable nor a whitelisted geo
    // level, so it contributes nothing. Under the old "everything but the variable, in header order" rule
    // this produced geoid "Los Angeles city, California0644000".
    const withName: unknown[][] = [
      ["NAME", ACS_POP_VAR, "state", "place"],
      ["Los Angeles city, California", "3822238", "06", "44000"],
    ]
    expect(parseAcs(withName)).toEqual([{ geoid: "0644000", population: 3822238 }])
    expect(parseAcs(withName)[0]!.geoid).not.toContain("Los Angeles")
  })

  it("IGNORES unlisted geography levels (tract/block group) rather than appending them", () => {
    const tract: unknown[][] = [
      [ACS_POP_VAR, "state", "county", "tract"],
      ["4321", "06", "037", "207103"],
    ]
    // state + county only; `tract` is not in the whitelist, so it is dropped (and the caller is expected
    // not to request levels the whitelist does not cover).
    expect(parseAcs(tract)).toEqual([{ geoid: "06037", population: 4321 }])
  })

  it("assembles in WHITELIST order (state, county, place), NOT header order", () => {
    // Census emitting the geography columns in a different order must not reorder the geoid.
    const reshuffled: unknown[][] = [
      [ACS_POP_VAR, "county", "state"],
      ["9848406", "037", "06"],
    ]
    expect(parseAcs(reshuffled)).toEqual([{ geoid: "06037", population: 9848406 }])
  })

  it("tolerates the population variable not being the first column", () => {
    const varLast: unknown[][] = [
      ["state", "place", ACS_POP_VAR],
      ["06", "44000", "3822238"],
    ]
    expect(parseAcs(varLast)).toEqual([{ geoid: "0644000", population: 3822238 }])
  })

  it("drops a row whose whitelisted geo cells are all empty (no geoid to key the UPDATE on)", () => {
    const empty: unknown[][] = [
      [ACS_POP_VAR, "state"],
      ["100", ""],
      ["200", "06"],
    ]
    expect(parseAcs(empty)).toEqual([{ geoid: "06", population: 200 }])
  })

  it("renders a null/absent geo cell as an empty segment rather than the string 'null'", () => {
    const nulls: unknown[][] = [
      [ACS_POP_VAR, "state", "county"],
      ["100", "06", null],
    ]
    expect(parseAcs(nulls)).toEqual([{ geoid: "06", population: 100 }])
  })

  it("accepts numeric (already-parsed JSON) geo cells", () => {
    // The Census returns strings, but a caller-supplied CensusJsonFetch may hand back numbers.
    const numeric: unknown[][] = [
      [ACS_POP_VAR, "state"],
      [39029342, 6],
    ]
    expect(parseAcs(numeric)).toEqual([{ geoid: "6", population: 39029342 }])
  })
})

describe("parseAcs population + row filtering", () => {
  it("rounds a fractional population", () => {
    expect(parseAcs([[ACS_POP_VAR, "state"], ["123.6", "06"]])).toEqual([
      { geoid: "06", population: 124 },
    ])
  })

  it("keeps a zero population (a real ACS value, not a missing one)", () => {
    expect(parseAcs([[ACS_POP_VAR, "state"], ["0", "06"]])).toEqual([
      { geoid: "06", population: 0 },
    ])
  })

  it("skips rows with a non-numeric or NEGATIVE population, keeping the rest", () => {
    // -666666666 is the Census's own "value not available" sentinel; "N" and "null" are the textual
    // placeholders it uses for suppressed values.
    const mixed: unknown[][] = [
      [ACS_POP_VAR, "state"],
      ["null", "06"],
      ["-666666666", "48"],
      ["N", "36"],
      ["12345", "12"],
    ]
    expect(parseAcs(mixed)).toEqual([{ geoid: "12", population: 12345 }])
  })

  it("SHARP EDGE: an empty-string or JSON-null population coerces to 0 and is KEPT, not skipped", () => {
    // Documented, not endorsed: the guard is `Number.isFinite(pop) && pop >= 0`, and Number("") ===
    // Number(null) === 0, so a blank/null cell survives as a real 0 and the backfill writes population = 0
    // over whatever was stored. Only "null"/"N"-style TEXT is rejected (NaN). Pinned here so that if the
    // parser is ever tightened to reject empty cells, this expectation flips deliberately rather than the
    // change slipping in unnoticed.
    expect(parseAcs([[ACS_POP_VAR, "state"], ["", "36"]])).toEqual([{ geoid: "36", population: 0 }])
    expect(parseAcs([[ACS_POP_VAR, "state"], [null, "36"]])).toEqual([{ geoid: "36", population: 0 }])
  })

  it("skips a non-array row without dropping the rows around it", () => {
    const ragged: unknown[][] = [
      [ACS_POP_VAR, "state"],
      ["100", "06"],
      null as unknown as unknown[],
      ["200", "48"],
    ]
    expect(parseAcs(ragged)).toEqual([
      { geoid: "06", population: 100 },
      { geoid: "48", population: 200 },
    ])
  })
})

describe("parseAcs malformed payloads", () => {
  it("returns [] for a header-only response (no data rows)", () => {
    expect(parseAcs([[ACS_POP_VAR, "state"]])).toEqual([])
  })

  it("returns [] for an empty array and for a non-array payload", () => {
    expect(parseAcs([])).toEqual([])
    expect(parseAcs(null as unknown as unknown[][])).toEqual([])
    expect(parseAcs({ error: "nope" } as unknown as unknown[][])).toEqual([])
  })

  it("returns [] when the population variable column is absent (an error/HTML payload)", () => {
    const noVar: unknown[][] = [
      ["NAME", "state"],
      ["California", "06"],
    ]
    expect(parseAcs(noVar)).toEqual([])
  })

  it("exports the ACS5 total-population variable it keys on", () => {
    expect(ACS_POP_VAR).toBe("B01003_001E")
  })
})
