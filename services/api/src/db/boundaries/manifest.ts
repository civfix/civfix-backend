/**
 * Path-A boundary-prep manifest: the PURE, DB-free enumeration of the GIS conversion jobs an operator
 * runs ONCE (Phase 1 of documents/20-jurisdiction-mapping.md) to turn the authoritative, public-domain
 * US boundary sources into the GeoJSON artifacts the existing `db:ingest` CLI loads. This is what ends
 * the "everything is Unmapped" problem: the resolver/table/ingest/geocoder are all built and correct;
 * the only thing missing is real coverage in the `jurisdictions` table, and these jobs produce it.
 *
 * One job per layer (a national file for state/county/AIANNH/federal, and one file PER STATE for
 * places). Each job records:
 *   - the canonical Census/USGS download URL for the source archive,
 *   - the civfix `layer` the file maps to (a member of JURISDICTION_LAYER_VALUES — drift-guarded),
 *   - the exact `ogr2ogr` arguments (format + reprojection + any source filter), and
 *   - the output GeoJSON filename + the geoid prefix the INGEST step must apply (metadata only).
 *
 * Two invariants this module deliberately enforces, both load-bearing:
 *
 *   1. EVERY job reprojects NAD83 (EPSG:4269, the TIGER native CRS) -> WGS84 (EPSG:4326). The
 *      `jurisdictions.geom` column and the `ST_GeomFromGeoJSON` ingest path both assume 4326; the
 *      offset is sub-meter but the SRID MUST be correct, so `-t_srs EPSG:4326` is on every job.
 *
 *   2. The conversion keeps the RAW Census/USGS ids (place/county/state carry the bare FIPS-hierarchical
 *      GEOID; AIANNH/PAD-US keep their native ids). The geoid PREFIX (AIANNH-/PADUS-) that makes the
 *      non-FIPS layers globally unique — and keeps the geocoder's FIPS-prefix shortcut valid (it must
 *      only trust place/county/state geoids, see geocoder.tiger.ts) — is applied EXACTLY ONCE, later,
 *      by the ingest CLI (src/db/ingest-jurisdictions.ts, positional geoid-prefix arg). This manifest
 *      therefore NEVER puts a prefix string inside `ogr2ogrArgs`; it records the intended prefix only as
 *      the `ingestGeoidPrefix` METADATA field so the runner/runbook can print the right `db:ingest`
 *      invocation. Keeping prefixing out of the conversion is what makes a double-prefix impossible.
 *
 * Why places are filtered to MTFCC `G4110`: that is the "incorporated place" class that carries
 * governmental authority. `G4210` (Census Designated Place — an unincorporated statistical area) is
 * EXCLUDED, because a point in unincorporated land must fall through place -> county, and the COUNTY is
 * the correct routing authority there (Design A; no county-subdivision tier — see the design doc §5).
 *
 * Why PAD-US is filtered to `Mang_Type='FED'`: AIANNH owns the `tribal` layer (cleaner, non-overlapping,
 * GEOID-keyed), so PAD-US is scoped to FEDERAL manager only to avoid double-counting tribal polygons.
 *
 * This module is PURE: it imports nothing from the DB client or env, performs no IO and no network
 * probe (the `'latest'` vintage resolves to DEFAULT_TIGER_VINTAGE in-process), so it is fully
 * unit-testable with no database and no GDAL. The thin runner (scripts/prepare-boundaries.ts) is the
 * only piece that shells `ogr2ogr`.
 */

import type { JURISDICTION_LAYER_VALUES } from "../schema/types.js"

/** The civfix jurisdiction layers a boundary job can target. Subset of JURISDICTION_LAYER_VALUES. */
type BoundaryLayer = (typeof JURISDICTION_LAYER_VALUES)[number]

/**
 * One boundary-prep job: a single source archive converted (with reprojection + any source filter) into
 * one GeoJSON file, plus the geoid prefix the ingest step should apply when loading it.
 */
export interface BoundaryJob {
  /** Census/USGS download URL for the source archive (the operator fetches + unzips this). */
  sourceUrl: string
  /** civfix `layer` this file maps to (drift-guarded against JURISDICTION_LAYER_VALUES). */
  layer: BoundaryLayer
  /**
   * Exact `ogr2ogr` arguments for the conversion: GeoJSON output (GeoJSONSeq for the oversized federal
   * layer) reprojected to EPSG:4326, plus a source filter for places (`-where` G4110) and federal
   * (`-sql` Mang_Type='FED'). NEVER contains a geoid
   * prefix string — prefixing happens at ingest time (see file header). The runner appends the output
   * path and the (already-downloaded) source path after these args.
   */
  ogr2ogrArgs: string[]
  /** Output GeoJSON filename (relative to the runner's outDir), e.g. "places_06.geojson". */
  outFile: string
  /**
   * The dataset path (relative to <outDir>/sources/) that ogr2ogr reads — i.e. what the source archive
   * extracts to. For TIGER/AIANNH shapefiles this is the like-named ".shp" (a single-layer dataset);
   * for the PAD-US job it is the File Geodatabase directory "PADUS<v>Geodatabase.gdb" (the specific Fee
   * feature class is selected by the job's ogr2ogr `-sql`, so no separate layer arg is needed). An
   * explicit path — not a basename heuristic — so the GDB and the query-string PAD-US URL load correctly.
   */
  sourcePath: string
  /**
   * The geoid prefix the INGEST CLI must apply to this file's features (METADATA ONLY — not used by the
   * conversion). null for the FIPS-hierarchical TIGER layers (place/county/state keep the raw GEOID);
   * "AIANNH-" for the tribal/AIANNH job; "PADUS-" for the federal/PAD-US job.
   */
  ingestGeoidPrefix: string | null
}

/**
 * Newest TIGER/Line vintage as of the design doc (2026-06-15). The freshness job (design doc §11) should
 * always resolve "latest" rather than pinning a year; in Design A `boundaryManifest('latest')` resolves
 * to this constant in-process (no network probe).
 */
export const DEFAULT_TIGER_VINTAGE = 2025

/** Current PAD-US (USGS GAP) version — versioned separately from TIGER (4.1 = 2024 release). */
export const PADUS_VERSION = "4.1"

/**
 * Canonical dataset identity for a (TIGER vintage, PAD-US version) pair, e.g. "tiger2025-padus4.1". The
 * local refresh tool (scripts/refresh-boundaries.ts) stamps this into boundary_vintage after a load so an
 * operator can see WHAT is loaded (a "-nofed" suffix records a run where PAD-US was skipped). AIANNH
 * shares the TIGER vintage, so it does not appear in the tag.
 */
export function vintageTag(tigerVintage: number, padusVersion: string = PADUS_VERSION): string {
  return `tiger${tigerVintage}-padus${padusVersion}`
}

/**
 * USGS PAD-US human download page — kept for the runbook/citation (DOI 10.5066/P96WBCHS). The machine
 * fetch uses PADUS_GDB_URL below, not this page.
 */
export const PADUS_DOWNLOAD_URL =
  "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download"

/**
 * VERIFIED direct-download URL for the PAD-US 4.1 national File Geodatabase (~1.52 GB zip), used by the
 * CI workflow's federal job. This is a ScienceBase asset whose item id (652d4fc5…) is SPECIFIC to the
 * 4.1 release and is NOT derivable from the version number — so bumping PADUS_VERSION ALSO requires
 * updating this URL (find the new "Full Inventory Database" item on ScienceBase). The only working fetch
 * pattern is catalog/file/get/<itemId>?name=<exactFilename> on www.sciencebase.gov; the `manager/`
 * download hosts serve an HTML shell, not the zip. NOTE: this endpoint ignores HTTP Range, so the full
 * 1.52 GB is pulled each run (no resumable download).
 */
export const PADUS_GDB_URL =
  "https://www.sciencebase.gov/catalog/file/get/652d4fc5d34e44db0e2ee45e?name=PADUS4_1Geodatabase.zip"

/** PAD-US version with the dot replaced ("4.1" -> "4_1"), used to derive the GDB folder + Fee layer
 *  names, which both embed the version (PADUS4_1Geodatabase.gdb / PADUS4_1Fee). */
const PADUS_VERSION_NODOT = PADUS_VERSION.replace(/\./g, "_")

/**
 * All 50 US state FIPS codes (2-digit, zero-padded), used to enumerate the per-state TIGER PLACE jobs.
 * Territories + DC (11 DC, 60 AS, 66 GU, 69 MP, 72 PR, 78 VI) are DEFERRED to Design B — places there
 * are not part of the first Design-A ship. Order matches the geocoder's STATE_FIPS_TO_USPS key order.
 */
export const STATE_FIPS: readonly string[] = [
  "01", "02", "04", "05", "06", "08", "09", "10", "12", "13",
  "15", "16", "17", "18", "19", "20", "21", "22", "23", "24",
  "25", "26", "27", "28", "29", "30", "31", "32", "33", "34",
  "35", "36", "37", "38", "39", "40", "41", "42", "44", "45",
  "46", "47", "48", "49", "50", "51", "53", "54", "55", "56",
] as const

/** Census TIGER directory root for a given vintage, e.g. ".../TIGER2025". */
function tigerRoot(vintage: number): string {
  return `https://www2.census.gov/geo/tiger/TIGER${vintage}`
}

/**
 * Build the Path-A boundary-prep manifest for a TIGER vintage. `'latest'` resolves to
 * DEFAULT_TIGER_VINTAGE (no network probe — Design A pins the in-process default; the freshness job
 * owns "actually latest"). Returns one job per national layer (state/county/AIANNH/federal) plus one
 * PLACE job per state in STATE_FIPS (50). PURE: no IO, no DB, deterministic for a given vintage.
 *
 * @param vintage TIGER vintage year, or 'latest' (-> DEFAULT_TIGER_VINTAGE).
 */
export function boundaryManifest(
  vintage: number | "latest" = DEFAULT_TIGER_VINTAGE,
): BoundaryJob[] {
  const year = vintage === "latest" ? DEFAULT_TIGER_VINTAGE : vintage
  // Reject a non-integer / out-of-range vintage here rather than letting it 404 at fetch time with a
  // confusing URL like .../TIGERNaN. The Census TIGER program began in 2007.
  if (!Number.isInteger(year) || year < 2007 || year > 2100) {
    throw new Error(`boundaryManifest: invalid TIGER vintage ${String(vintage)}`)
  }
  const root = tigerRoot(year)

  const jobs: BoundaryJob[] = []

  // (a) States (national). GEOID = 2-char STATEFP; raw geoid is kept (FIPS-hierarchical), no prefix.
  jobs.push({
    sourceUrl: `${root}/STATE/tl_${year}_us_state.zip`,
    layer: "state",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326"],
    outFile: "states.geojson",
    sourcePath: `tl_${year}_us_state.shp`,
    ingestGeoidPrefix: null,
  })

  // (b) Counties (national). GEOID = 5-char (state+county); raw geoid is kept, no prefix.
  jobs.push({
    sourceUrl: `${root}/COUNTY/tl_${year}_us_county.zip`,
    layer: "county",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326"],
    outFile: "counties.geojson",
    sourcePath: `tl_${year}_us_county.shp`,
    ingestGeoidPrefix: null,
  })

  // (c) Places (per-state, 50 jobs). Filter to MTFCC G4110 (incorporated places with governmental
  //     authority); G4210 (CDP) is excluded so unincorporated land falls through place -> county.
  //     GEOID = 7-char (state+place); raw geoid is kept, no prefix.
  for (const ss of STATE_FIPS) {
    jobs.push({
      sourceUrl: `${root}/PLACE/tl_${year}_${ss}_place.zip`,
      layer: "place",
      ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-where", "MTFCC='G4110'"],
      outFile: `places_${ss}.geojson`,
      sourcePath: `tl_${year}_${ss}_place.shp`,
      ingestGeoidPrefix: null,
    })
  }

  // (d) AIANNH (national tribal). TIGER AIANNH carries GEOID + NAME as real attributes (id field is
  //     AIANNHCE, equal to GEOID), so the ingest CLI reads them directly. The "AIANNH-" prefix that
  //     prevents a 5-char AIANNH geoid from colliding with a 5-char county PK is applied by the INGEST
  //     step, recorded here as metadata only.
  jobs.push({
    sourceUrl: `${root}/AIANNH/tl_${year}_us_aiannh.zip`,
    layer: "tribal",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326"],
    outFile: "aiannh.geojson",
    sourcePath: `tl_${year}_us_aiannh.shp`,
    ingestGeoidPrefix: "AIANNH-",
  })

  // (e) PAD-US federal (national File Geodatabase). Reads the Fee feature class and scopes to FEDERAL
  //     manager (AIANNH owns tribal). Uses ogr2ogr's DEFAULT (OGR) SQL dialect — which reliably carries
  //     the geometry through an attribute projection — to (1) select the version-named Fee layer,
  //     (2) filter Mang_Type='FED', and (3) ALIAS the GDB's OBJECTID -> GEOID and Unit_Nm -> NAME so they
  //     land as GeoJSON *properties* the ingest CLI reads. `-nlt PROMOTE_TO_MULTI` normalizes Polygon ->
  //     MultiPolygon. (We deliberately avoid the SQLITE dialect here: with an explicit column projection
  //     it can drop the geometry unless the geometry column is named, which silently yields 0 ingestable
  //     features — the prepare-boundaries polygon-count guard would catch that, but the OGR dialect avoids
  //     it outright.) The "PADUS-" prefix (applied at ingest, metadata here) makes the non-FIPS ids
  //     globally unique AND makes the geocoder fall back to the authoritative containing-state query.
  //     NOTE: PAD-US OBJECTIDs are not stable across PAD-US versions, so a version bump reshuffles these
  //     geoids (old PADUS- rows linger, advisory-stale, since the load never deletes).
  //     OUTPUT FORMAT: GeoJSONSeq (`.geojsonl`, one Feature per line), NOT a single FeatureCollection. The
  //     federal export is >512 MB, which exceeds Node's max string length — so the refresh tool STREAMS it
  //     (ingestGeoJsonSeqFile) instead of readFileSync, which would throw ERR_STRING_TOO_LONG. The small
  //     TIGER layers stay on plain GeoJSON. ogr2ogr `-t_srs`/`-sql`/`-nlt` are format-independent.
  jobs.push({
    sourceUrl: PADUS_GDB_URL,
    layer: "federal",
    ogr2ogrArgs: [
      "-f",
      "GeoJSONSeq",
      "-t_srs",
      "EPSG:4326",
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
