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
   * Exact `ogr2ogr` arguments for the conversion: always GeoJSON output reprojected to EPSG:4326, plus
   * a source `-where` filter for places (G4110) and federal (Mang_Type='FED'). NEVER contains a geoid
   * prefix string — prefixing happens at ingest time (see file header). The runner appends the output
   * path and the (already-downloaded) source path after these args.
   */
  ogr2ogrArgs: string[]
  /** Output GeoJSON filename (relative to the runner's outDir), e.g. "places_06.geojson". */
  outFile: string
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
 * USGS PAD-US download entry point. PAD-US is distributed as a national geodatabase (not a single stable
 * direct-download URL the way TIGER is), so this is the human download page; the operator fetches the
 * national archive from here, then the runner/operator points the federal job at the extracted PADUS_Fee
 * layer. Kept as a constant so the manifest carries the canonical source for the runbook.
 */
export const PADUS_DOWNLOAD_URL =
  "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download"

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
  const root = tigerRoot(year)

  const jobs: BoundaryJob[] = []

  // (a) States (national). GEOID = 2-char STATEFP; raw geoid is kept (FIPS-hierarchical), no prefix.
  jobs.push({
    sourceUrl: `${root}/STATE/tl_${year}_us_state.zip`,
    layer: "state",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326"],
    outFile: "states.geojson",
    ingestGeoidPrefix: null,
  })

  // (b) Counties (national). GEOID = 5-char (state+county); raw geoid is kept, no prefix.
  jobs.push({
    sourceUrl: `${root}/COUNTY/tl_${year}_us_county.zip`,
    layer: "county",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326"],
    outFile: "counties.geojson",
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
      ingestGeoidPrefix: null,
    })
  }

  // (d) AIANNH (national tribal). The conversion keeps the RAW AIANNHCE/NAME properties (the ingest CLI
  //     already reads GEOID/NAME etc.); the "AIANNH-" prefix that prevents a 5-char AIANNH geoid from
  //     colliding with a 5-char county PK is applied by the INGEST step, recorded here as metadata only.
  jobs.push({
    sourceUrl: `${root}/AIANNH/tl_${year}_us_aiannh.zip`,
    layer: "tribal",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326"],
    outFile: "aiannh.geojson",
    ingestGeoidPrefix: "AIANNH-",
  })

  // (e) PAD-US federal. Scope to FEDERAL manager (AIANNH owns tribal). PAD-US ids are not Census FIPS,
  //     so a numeric OBJECTID could look like a wrong state FIPS — the "PADUS-" prefix (applied at
  //     ingest, metadata here) makes them globally unique AND makes the geocoder fall back to the
  //     authoritative containing-state spatial query for these rows.
  jobs.push({
    sourceUrl: PADUS_DOWNLOAD_URL,
    layer: "federal",
    ogr2ogrArgs: ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-where", "Mang_Type='FED'"],
    outFile: "federal.geojson",
    ingestGeoidPrefix: "PADUS-",
  })

  return jobs
}
