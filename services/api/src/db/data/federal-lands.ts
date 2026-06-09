/**
 * Curated set of REAL, DISTINCT federal + tribal jurisdictions, each its own routing target.
 *
 * Every entry is a real-world federal land (National Park, National Forest) or tribal nation with its
 * real name, a distinct geoid, and its OWN routing posture - so a report landing in Yellowstone routes
 * to the Yellowstone contact, one in Yosemite to Yosemite's, one in the Angeles National Forest to the
 * Forest Service, etc. They resolve via the same place->county->state precedence query, where `federal`
 * and `tribal` out-rank place/county/state (a national-park point routes to the federal owner, not the
 * surrounding city/county). See src/db/sql/jurisdiction.ts.
 *
 * GEOMETRY: each unit carries its real WGS84 BOUNDING EXTENT (`bbox`). The loader generalizes it to a
 * simplified octagonal boundary GeoJSON polygon (`federalLandGeoJson`) and ingests it via
 * ST_GeomFromGeoJSON - the SAME PostGIS path used to load FULL-fidelity boundaries. To load the real
 * detailed polygons at scale (every NPS unit, every PAD-US federal parcel, every reservation), run the
 * ingest CLI against an external GeoJSON export:
 *
 *     pnpm db:ingest path/to/federal-lands.geojson
 *
 * Real sources (public-domain): NPS unit boundaries
 *   https://public-nps.opendata.arcgis.com/datasets/nps-boundary  (and the per-unit boundary service),
 * and USGS PAD-US (Protected Areas Database) for federal/state ownership +
 *   https://biamaps.geoplatform.gov/  (BIA tribal boundaries / "American Indian Reservations").
 *
 * This curated set is what `pnpm db:seed` (and the Testcontainers spatial test) load so the model works
 * offline with several distinct units; production ingests the full external datasets via the CLI.
 */

/** A real federal-land / tribal jurisdiction (its routing posture is per-unit, like any jurisdiction). */
export interface FederalLand {
  /** Distinct id (NPS unit code "NPS-YELL", USFS "USFS-ANGELES", BIA "BIA-NAVAJO", ...). */
  geoid: string
  name: string
  layer: "federal" | "tribal"
  /** The responsible agency (cosmetic; the routing contact is what reports are sent to). */
  agency: string
  /** Residents (0 for uninhabited park/forest land; real population for a reservation). */
  population: number
  /** The unit's routing contact(s). EMPTY = not mapped yet -> shows in the directory "needs contact". */
  contactEmails: string[]
  /** Optional reporting-form URL fallback. */
  reportFormUrl: string | null
  /** Real WGS84 bounding extent [minLng, minLat, maxLng, maxLat]. */
  bbox: [number, number, number, number]
}

/**
 * The curated units. A MIX of mapped (own contact) and unmapped (needs a contact) so the directory shows
 * both states, and a tribal nation alongside the federal parks/forest. The Angeles National Forest sits
 * inside Los Angeles County on purpose (the spatial test proves a forest point routes to the Forest
 * Service, not the county/city).
 */
export const FEDERAL_LANDS: readonly FederalLand[] = [
  {
    geoid: "NPS-YELL",
    name: "Yellowstone National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: ["yellowstone_superintendent@nps.gov"],
    reportFormUrl: null,
    bbox: [-111.06, 44.13, -109.99, 45.1],
  },
  {
    geoid: "NPS-YOSE",
    name: "Yosemite National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: ["yosemite_info@nps.gov"],
    reportFormUrl: null,
    bbox: [-119.89, 37.49, -119.2, 38.19],
  },
  {
    geoid: "NPS-GRCA",
    name: "Grand Canyon National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    // Unmapped on purpose: a fresh federal jurisdiction an operator still needs to map a contact for.
    contactEmails: [],
    reportFormUrl: null,
    bbox: [-114.3, 35.97, -111.8, 36.6],
  },
  {
    geoid: "NPS-JOTR",
    name: "Joshua Tree National Park",
    layer: "federal",
    agency: "National Park Service",
    population: 0,
    contactEmails: [],
    reportFormUrl: null,
    bbox: [-116.3, 33.66, -115.45, 34.1],
  },
  {
    geoid: "USFS-ANGELES",
    name: "Angeles National Forest",
    layer: "federal",
    agency: "US Forest Service",
    population: 0,
    contactEmails: ["angeles_so@fs.usda.gov"],
    reportFormUrl: null,
    bbox: [-118.5, 34.16, -117.65, 34.51],
  },
  {
    geoid: "BIA-NAVAJO",
    name: "Navajo Nation",
    layer: "tribal",
    agency: "Navajo Nation / Bureau of Indian Affairs",
    population: 170_000,
    contactEmails: ["info@navajo-nsn.gov"],
    reportFormUrl: null,
    bbox: [-111.5, 35.3, -108.0, 37.1],
  },
] as const

/** Corner-clip fraction used to generalize a bounding box into an octagon (purely cosmetic shape). */
const OCTAGON_CLIP = 0.18

/**
 * Generalize a real bounding extent into a simplified OCTAGONAL boundary as a GeoJSON Polygon string
 * (closed ring, lng/lat). Octagonal (not a bare rectangle) so the seeded shape reads as a boundary, and
 * convex so the bbox center is always interior (the spatial test probes the center). Production replaces
 * these with full PAD-US/NPS polygons via the ingest CLI.
 */
export function federalLandGeoJson(bbox: readonly [number, number, number, number]): string {
  const [x0, y0, x1, y1] = bbox
  const fw = OCTAGON_CLIP * (x1 - x0)
  const fh = OCTAGON_CLIP * (y1 - y0)
  const ring: [number, number][] = [
    [x0 + fw, y1],
    [x1 - fw, y1],
    [x1, y1 - fh],
    [x1, y0 + fh],
    [x1 - fw, y0],
    [x0 + fw, y0],
    [x0, y0 + fh],
    [x0, y1 - fh],
    [x0 + fw, y1], // close the ring
  ]
  return JSON.stringify({ type: "Polygon", coordinates: [ring] })
}

/** The center of a unit's bounding extent (guaranteed interior to its convex octagon). */
export function federalLandCenter(bbox: readonly [number, number, number, number]): {
  lng: number
  lat: number
} {
  const [x0, y0, x1, y1] = bbox
  return { lng: (x0 + x1) / 2, lat: (y0 + y1) / 2 }
}

/** A spatial probe + the geoid we expect resolveJurisdiction() to return. Shared with the spatial test. */
export interface FederalProbe {
  name: string
  lng: number
  lat: number
  expectGeoid: string
}

/** One center probe per unit: a point in each federal/tribal land must resolve to THAT unit. */
export const FEDERAL_PROBES: readonly FederalProbe[] = FEDERAL_LANDS.map((land) => {
  const c = federalLandCenter(land.bbox)
  return { name: `inside_${land.geoid}`, lng: c.lng, lat: c.lat, expectGeoid: land.geoid }
})

/**
 * A point in the Angeles National Forest that ALSO falls inside the seeded Los Angeles city box - it must
 * resolve to the Forest (federal), proving the land-ownership override beats `place`. (lng/lat chosen in
 * the ANF octagon's south-west, which overlaps the LA city extent.)
 */
export const PROBE_ANGELES_OVER_CITY: FederalProbe = {
  name: "angeles_over_city",
  lng: -118.3,
  lat: 34.18,
  expectGeoid: "USFS-ANGELES",
}
