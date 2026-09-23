/**
 * Shared by seed.ts and the spatial integration test so both agree on the geometries and on the expected
 * resolution of each probe point. The boxes are rectangles, not true boundaries, and strictly nested so
 * place precedence is testable.
 *
 * REAL geoids, PLACEHOLDER contacts (deliberate): the geoids are the true Census GEOIDs, so the first real
 * TIGER load upserts these very rows and replaces the rectangles instead of leaving fake duplicates
 * overlapping them (nothing prunes stale place/county/state rows). The example.* contacts must not survive
 * as the routing target on a box where the seed ran before the first refresh, so upsertJurisdiction clears
 * contact_emails when every address is an example.* placeholder. Keep any contact added here inside an
 * example.* domain (RFC 2606) so it stays self-cleaning.
 */

export interface JurisdictionSeed {
  geoid: string
  name: string
  layer: "place" | "county" | "state"
  priority: number
  population: number
  contactEmails: string[]
  /** [xmin(lng), ymin(lat), xmax(lng), ymax(lat)] */
  bbox: [number, number, number, number]
}

export const CALIFORNIA: JurisdictionSeed = {
  geoid: "06",
  name: "California",
  layer: "state",
  priority: 2,
  population: 39_000_000,
  contactEmails: ["state-referral@example.gov"],
  bbox: [-124.5, 32.5, -114.0, 42.0],
}

export const LA_COUNTY: JurisdictionSeed = {
  geoid: "06037",
  name: "Los Angeles County",
  layer: "county",
  priority: 1,
  population: 9_800_000,
  contactEmails: ["pw-referral@example.lacounty.gov"],
  bbox: [-119.0, 33.7, -117.6, 34.8],
}

export const LA_CITY: JurisdictionSeed = {
  geoid: "0644000",
  name: "Los Angeles",
  layer: "place",
  priority: 0,
  population: 3_900_000,
  contactEmails: ["311@example.lacity.gov"],
  bbox: [-118.5, 34.0, -118.2, 34.2],
}

export const JURISDICTION_SEEDS: readonly JurisdictionSeed[] = [CALIFORNIA, LA_COUNTY, LA_CITY]

/** `expectGeoid` null = outside every box. */
export interface ProbePoint {
  name: string
  lng: number
  lat: number
  expectGeoid: string | null
}

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
