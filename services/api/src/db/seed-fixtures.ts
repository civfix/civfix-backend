/**
 * Seed fixtures for jurisdictions, shared between the seed runner (seed.ts) and the spatial
 * integration test so both agree on the exact geometries and the expected resolution of each probe
 * point. Keeping them here is the single source of truth for the dev/test jurisdiction set.
 *
 * Geometry strategy: each jurisdiction is a simple axis-aligned bounding box built with
 * ST_Multi(ST_MakeEnvelope(xmin, ymin, xmax, ymax, 4326)) -> a valid MultiPolygon(4326). The boxes
 * are strictly NESTED so place precedence is testable:
 *
 *     California (state)  ----------------------------------------------------------------
 *     |  Los Angeles County (county)  ------------------------------                      |
 *     |  |  Los Angeles city (place)  ------------                  |                      |
 *     |  |  |  PROBE: inside_city   |                              |                      |
 *     |  |  -----------------------------                          |                      |
 *     |  |              PROBE: county_not_city (unincorporated)    |                      |
 *     |  ----------------------------------------------------------                       |
 *     |                                          PROBE: outside_all is OUTSIDE this box -> |
 *     ----------------------------------------------------------------------------------- |
 *
 * Coordinates are real-ish LA-area lon/lat but deliberately rectangular, not the true boundaries.
 * Envelope bounds: [xmin(lng), ymin(lat), xmax(lng), ymax(lat)].
 */

/**
 * A jurisdiction seed row plus its bounding box (lng/lat). These are the nested place/county/state TEST
 * boxes; the real federal + tribal lands are a separate curated set in data/federal-lands.ts.
 */
export interface JurisdictionSeed {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
  priority: number
  population: number
  contactEmails: string[]
  /** [xmin(lng), ymin(lat), xmax(lng), ymax(lat)] envelope passed to ST_MakeEnvelope. */
  bbox: [number, number, number, number]
}

/** California: outermost box. Contains the county box. */
export const CALIFORNIA: JurisdictionSeed = {
  geoid: "06",
  name: "California",
  layer: "state",
  priority: 2,
  population: 39_000_000,
  contactEmails: ["state-referral@example.gov"],
  bbox: [-124.5, 32.5, -114.0, 42.0],
}

/** Los Angeles County: middle box. Inside California, contains the city box. */
export const LA_COUNTY: JurisdictionSeed = {
  geoid: "06037",
  name: "Los Angeles County",
  layer: "county",
  priority: 1,
  population: 9_800_000,
  contactEmails: ["pw-referral@example.lacounty.gov"],
  bbox: [-119.0, 33.7, -117.6, 34.8],
}

/** Los Angeles city: innermost box. Inside the county box. */
export const LA_CITY: JurisdictionSeed = {
  geoid: "0644000",
  name: "Los Angeles",
  layer: "place",
  priority: 0,
  population: 3_900_000,
  contactEmails: ["311@example.lacity.gov"],
  bbox: [-118.5, 34.0, -118.2, 34.2],
}

/**
 * The place/county/state seed set, outer-to-inner (insertion order is irrelevant; ON CONFLICT DO
 * NOTHING). The real federal + tribal lands (incl. the Angeles National Forest that overlaps LA County)
 * live in data/federal-lands.ts and are seeded alongside these by seedJurisdictions -> seedFederalLands.
 */
export const JURISDICTION_SEEDS: readonly JurisdictionSeed[] = [CALIFORNIA, LA_COUNTY, LA_CITY]

/** A probe point and the geoid we expect resolveJurisdiction() to return (null = outside all). */
export interface ProbePoint {
  name: string
  lng: number
  lat: number
  expectGeoid: string | null
}

/**
 * Probe points used by the spatial test. inside_city falls inside all three boxes and must resolve to
 * the place; county_not_city falls inside the county + state boxes but OUTSIDE the city box and must
 * resolve to the county (unincorporated path); outside_all falls outside every box and resolves null.
 */
export const PROBE_INSIDE_CITY: ProbePoint = {
  name: "inside_city",
  lng: -118.35,
  lat: 34.1,
  expectGeoid: LA_CITY.geoid,
}

export const PROBE_COUNTY_NOT_CITY: ProbePoint = {
  name: "county_not_city",
  lng: -118.8,
  lat: 34.5,
  expectGeoid: LA_COUNTY.geoid,
}

export const PROBE_OUTSIDE_ALL: ProbePoint = {
  name: "outside_all",
  lng: -100.0,
  lat: 40.0,
  expectGeoid: null,
}

export const PROBE_POINTS: readonly ProbePoint[] = [
  PROBE_INSIDE_CITY,
  PROBE_COUNTY_NOT_CITY,
  PROBE_OUTSIDE_ALL,
]
