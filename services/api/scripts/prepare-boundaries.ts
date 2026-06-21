/**
 * Boundary-prep runner (ops-only): the thin imperative wrapper around the PURE boundaryManifest
 * (src/db/boundaries/manifest.ts). For each job it shells `ogr2ogr` to convert one already-downloaded
 * Census/USGS source into the reprojected (EPSG:4326) GeoJSON file the existing `db:ingest` CLI loads.
 *
 *   pnpm db:prepare-boundaries            # default vintage, outDir data/boundaries
 *   pnpm db:prepare-boundaries 2025 out   # explicit vintage + outDir
 *   tsx scripts/prepare-boundaries.ts [vintage] [outDir]
 *
 * IMPORTANT scope + constraints (why this is a .ts script under scripts/, not a tsup entry):
 *   - It REQUIRES GDAL/ogr2ogr (Phase 0 of documents/20-jurisdiction-mapping.md). It is a build/ops tool
 *     run by an operator on a box that has GDAL; it NEVER runs inside the production API image, so it is
 *     deliberately NOT a tsup entry and node `dist/` never contains it.
 *   - It is run via `tsx` (TypeScript) specifically so it can import the manifest from `src` directly —
 *     a plain .mjs under node cannot import a .ts module. It is the single source of the conversion
 *     commands; the manifest is the single source of WHAT to convert.
 *   - It touches NO database and NO env, adds NO npm dependency (only node:child_process + node:fs/path).
 *
 * What it does NOT do: it does not DOWNLOAD the source archives (TIGER zips are per-state and PAD-US is
 * a GB-scale national geodatabase — fetching/unzipping is a manual operator step, documented in the
 * runbook). It expects each job's source to already be present under `<outDir>/sources/` using the
 * archive's basename with the shapefile/gdb extension. It logs the exact command it runs, converts what
 * it can, continues past per-job failures (e.g. a not-yet-downloaded source), and prints a final
 * summary. For the prefixed jobs (AIANNH/PAD-US) it prints the exact follow-up `pnpm db:ingest` line so
 * the operator applies the geoid prefix at ingest (the conversion keeps raw ids — see the manifest).
 *
 * Exit codes: 0 = every job converted; 1 = at least one job failed; 2 = GDAL/ogr2ogr not found.
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { basename } from "node:path"
import { boundaryManifest, type BoundaryJob } from "../src/db/boundaries/manifest.js"

const PREFIX = "prepare-boundaries"

/**
 * Derive the local source path the operator is expected to have downloaded+unzipped for a job. TIGER
 * archives extract to a like-named shapefile (tl_2025_us_state.zip -> tl_2025_us_state.shp); the PAD-US
 * page yields a national geodatabase. We can only guess the conventional shapefile name from the archive
 * basename; the PAD-US federal job's source is a geodatabase, so we surface its URL and let the operator
 * point ogr2ogr at the extracted .gdb (the runbook documents the layer name PADUS_Fee).
 */
function localSourceFor(job: BoundaryJob, outDir: string): string {
  const base = basename(job.sourceUrl)
  // TIGER: tl_<Y>_<scope>_<layer>.zip -> tl_<Y>_<scope>_<layer>.shp under <outDir>/sources/.
  if (base.endsWith(".zip")) return `${outDir}/sources/${base.replace(/\.zip$/, ".shp")}`
  // PAD-US (and anything else non-.zip): the operator supplies the extracted dataset path manually;
  // surface a conventional placeholder so the logged command is obviously operator-editable.
  return `${outDir}/sources/PADUS_Combined.gdb`
}

/** Verify GDAL/ogr2ogr is on PATH; exit(2) with an actionable message if not. */
function assertOgr2ogr(): void {
  try {
    execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" })
  } catch {
    console.error(
      `${PREFIX}: ogr2ogr (GDAL) not found on PATH — install GDAL (Phase 0 of documents/20-jurisdiction-mapping.md) and re-run.`,
    )
    process.exit(2)
  }
}

function main(): void {
  // argv[2] = vintage (year, or omitted -> manifest default); argv[3] = outDir.
  const vintageArg = process.argv[2]
  const vintage = vintageArg ? Number(vintageArg) : undefined
  if (vintageArg !== undefined && !Number.isInteger(vintage)) {
    console.error(`${PREFIX}: vintage must be a 4-digit year (got "${vintageArg}")`)
    process.exit(2)
  }
  const outDir = process.argv[3] ?? "data/boundaries"

  assertOgr2ogr()

  // vintage===undefined -> let the manifest apply its own default; otherwise pass the year through.
  const jobs = vintage === undefined ? boundaryManifest() : boundaryManifest(vintage)
  console.log(
    `${PREFIX}: ${jobs.length} job(s) -> ${outDir} (sources expected under ${outDir}/sources/)`,
  )

  let converted = 0
  const failed: string[] = []

  for (const job of jobs) {
    const source = localSourceFor(job, outDir)
    const outPath = `${outDir}/${job.outFile}`
    // The full argv: the manifest's conversion args, then OUTPUT then SOURCE (ogr2ogr's positional order
    // is dst-then-src). NOTE: no geoid prefix appears here — prefixing is an ingest-time concern.
    const args = [...job.ogr2ogrArgs, outPath, source]
    console.log(`${PREFIX}: [${job.layer}] ogr2ogr ${args.join(" ")}`)
    try {
      execFileSync("ogr2ogr", args, { stdio: "inherit" })
      converted += 1
      // For a prefixed (non-FIPS) layer, print the exact ingest invocation so the operator applies the
      // geoid prefix exactly once, at ingest. For TIGER (null prefix) the two-arg form is enough.
      const ingest =
        job.ingestGeoidPrefix === null
          ? `pnpm db:ingest ${job.outFile} ${job.layer}`
          : `pnpm db:ingest ${job.outFile} ${job.layer} ${job.ingestGeoidPrefix}`
      console.log(`${PREFIX}:   then -> ${ingest}`)
    } catch (err) {
      failed.push(job.outFile)
      console.error(`${PREFIX}: [${job.layer}] FAILED for ${job.outFile} (source: ${source})`)
      console.error(err)
    }
  }

  console.log(`${PREFIX}: done — ${converted} converted, ${failed.length} failed`)
  if (failed.length > 0) {
    console.error(`${PREFIX}: failed jobs: ${failed.join(", ")}`)
    process.exit(1)
  }
}

// Run only when executed directly (tsx scripts/prepare-boundaries.ts), not when imported.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  try {
    main()
  } catch (err: unknown) {
    console.error(`${PREFIX}: failed`)
    console.error(err)
    process.exit(1)
  }
}
