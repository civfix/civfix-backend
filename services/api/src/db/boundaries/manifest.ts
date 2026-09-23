/**
 * The GIS conversion jobs that turn the public-domain US boundary sources into the GeoJSON the `db:ingest`
 * CLI loads. Pure (no IO, no DB, no GDAL) so it is unit-testable; scripts/prepare-boundaries.ts is the only
 * piece that shells out to ogr2ogr.
 *
 * Two load-bearing invariants:
 *
 *   1. Every job reprojects NAD83 (EPSG:4269, TIGER's native CRS) to EPSG:4326, which the geom column and
 *      the ST_GeomFromGeoJSON ingest path both assume. The offset is sub-meter, but the SRID must be right.
 *
 *   2. Conversion keeps the raw Census/USGS ids. The AIANNH-/PADUS- prefix that makes the non-FIPS layers
 *      globally unique (and keeps the geocoder's FIPS-prefix shortcut valid for place/county/state only)
 *      is applied exactly once, at ingest. It never appears in `ogr2ogrArgs`, which is what makes a
 *      double prefix impossible.
 *
 * Places are filtered to MTFCC G4110 (incorporated places with governmental authority). Census Designated
 * Places (G4210) are excluded because a point on unincorporated land must fall through to the county, the
 * correct routing authority there.
 *
 * PAD-US is scoped to Mang_Type='FED' because AIANNH owns the tribal layer; including PAD-US tribal
 * polygons would double-count them.
 */

import type { JURISDICTION_LAYER_VALUES } from "../schema/types.js"

type BoundaryLayer = (typeof JURISDICTION_LAYER_VALUES)[number]

export interface BoundaryJob {
  sourceUrl: string
  layer: BoundaryLayer
  /**
   * Never contains a geoid prefix (see the header). `-makevalid` is on every job so no invalid polygon
   * reaches prod. The runner appends the output and source paths.
   */
  ogr2ogrArgs: string[]
  outFile: string
  /**
   * An explicit path rather than a basename heuristic, so the PAD-US geodatabase directory and its
   * query-string URL load correctly.
   */
  sourcePath: string
  /** Metadata only: the conversion never uses it. */
  ingestGeoidPrefix: string | null
}

/** `boundaryManifest('latest')` resolves to this in-process rather than probing the network. */
export const DEFAULT_TIGER_VINTAGE = 2025

/** Versioned separately from TIGER. Bumping it also requires updating PADUS_GDB_URL. */
export const PADUS_VERSION = "4.1"

/** AIANNH shares the TIGER vintage, so it does not appear in the tag. */
export function vintageTag(tigerVintage: number, padusVersion: string = PADUS_VERSION): string {
  return `tiger${tigerVintage}-padus${padusVersion}`
}

/** For the runbook and citation (DOI 10.5066/P96WBCHS); the machine fetch uses PADUS_GDB_URL. */
export const PADUS_DOWNLOAD_URL =
  "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download"

/**
 * The ScienceBase item id is specific to the 4.1 release and not derivable from the version, so bumping
 * PADUS_VERSION means finding the new "Full Inventory Database" item. Only the catalog/file/get pattern
 * serves the zip (the `manager/` hosts serve an HTML shell), and it ignores HTTP Range, so the full
 * ~1.5 GB is pulled every run.
 */
export const PADUS_GDB_URL =
  "https://www.sciencebase.gov/catalog/file/get/652d4fc5d34e44db0e2ee45e?name=PADUS4_1Geodatabase.zip"

const PADUS_VERSION_NODOT = PADUS_VERSION.replace(/\./g, "_")

/**
 * Territories and DC (11, 60, 66, 69, 72, 78) are deliberately not covered yet. Order matches the
 * geocoder's STATE_FIPS_TO_USPS key order.
 */
export const STATE_FIPS: readonly string[] = [
  "01",
  "02",
  "04",
  "05",
  "06",
  "08",
  "09",
  "10",
  "12",
  "13",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "29",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "38",
  "39",
  "40",
  "41",
  "42",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "50",
  "51",
  "53",
  "54",
  "55",
  "56",
] as const

function tigerRoot(vintage: number): string {
  return `https://www2.census.gov/geo/tiger/TIGER${vintage}`
}

export function boundaryManifest(
  vintage: number | "latest" = DEFAULT_TIGER_VINTAGE,
): BoundaryJob[] {
  const year = vintage === "latest" ? DEFAULT_TIGER_VINTAGE : vintage
  // Fail here rather than 404 later on a URL like .../TIGERNaN. TIGER began in 2007.
  if (!Number.isInteger(year) || year < 2007 || year > 2100) {
    throw new Error(`boundaryManifest: invalid TIGER vintage ${String(vintage)}`)
  }
  const root = tigerRoot(year)

  const jobs: BoundaryJob[] = []

  jobs.push({
    sourceUrl: `${root}/STATE/tl_${year}_us_state.zip`,
    layer: "state",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-makevalid"],
    outFile: "states.geojson",
    sourcePath: `tl_${year}_us_state.shp`,
    ingestGeoidPrefix: null,
  })

  jobs.push({
    sourceUrl: `${root}/COUNTY/tl_${year}_us_county.zip`,
    layer: "county",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-makevalid"],
    outFile: "counties.geojson",
    sourcePath: `tl_${year}_us_county.shp`,
    ingestGeoidPrefix: null,
  })

  for (const ss of STATE_FIPS) {
    jobs.push({
      sourceUrl: `${root}/PLACE/tl_${year}_${ss}_place.zip`,
      layer: "place",
      ogr2ogrArgs: [
        "-f",
        "GeoJSON",
        "-t_srs",
        "EPSG:4326",
        "-makevalid",
        "-where",
        "MTFCC='G4110'",
      ],
      outFile: `places_${ss}.geojson`,
      sourcePath: `tl_${year}_${ss}_place.shp`,
      ingestGeoidPrefix: null,
    })
  }

  // The AIANNH- prefix keeps a 5-char AIANNH geoid from colliding with a 5-char county PK.
  jobs.push({
    sourceUrl: `${root}/AIANNH/tl_${year}_us_aiannh.zip`,
    layer: "tribal",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-makevalid"],
    outFile: "aiannh.geojson",
    sourcePath: `tl_${year}_us_aiannh.shp`,
    ingestGeoidPrefix: "AIANNH-",
  })

  // The default OGR SQL dialect, not SQLITE: with an explicit column projection SQLITE can drop the
  // geometry unless it is named, silently yielding zero ingestable features. The aliases land OBJECTID and
  // Unit_Nm as the GEOID/NAME properties the ingest CLI reads.
  //
  // PAD-US OBJECTIDs are not stable across versions, so a version bump reshuffles these geoids; old
  // PADUS- rows linger because the load never deletes.
  //
  // GeoJSONSeq, not a FeatureCollection: the federal export exceeds Node's max string length, so the
  // refresh tool streams it instead of readFileSync (ERR_STRING_TOO_LONG).
  //
  // `-makevalid` must repair PAD-US's invalid polygons here, during the local conversion: ST_MakeValid on
  // the worst multipolygons is slow enough to take down a Postgres backend, and invalid geometry would
  // make the resolver's ST_Contains unreliable.
  jobs.push({
    sourceUrl: PADUS_GDB_URL,
    layer: "federal",
    ogr2ogrArgs: [
      "-f",
      "GeoJSONSeq",
      "-t_srs",
      "EPSG:4326",
      "-makevalid",
      "-sql",
      `SELECT OBJECTID AS GEOID, Unit_Nm AS NAME FROM PADUS${PADUS_VERSION_NODOT}Fee WHERE Mang_Type='FED'`,
      "-nlt",
      "PROMOTE_TO_MULTI",
    ],
    outFile: "federal.geojsonl",
    sourcePath: `PADUS${PADUS_VERSION_NODOT}Geodatabase.gdb`,
    ingestGeoidPrefix: "PADUS-",
  })

  return jobs
}
