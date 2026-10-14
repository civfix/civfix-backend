/**
 * Boundary-prep convert tool (ops / air-gapped fallback) around the PURE boundaryManifest
 * (src/db/boundaries/manifest.ts): it shells `ogr2ogr` to convert each already-downloaded Census/USGS
 * source into a reprojected (EPSG:4326) GeoJSON file, then prints the matching `pnpm db:ingest` line.
 *
 *   pnpm db:prepare-boundaries             # default vintage, outDir data/boundaries
 *   pnpm db:prepare-boundaries 2025 out    # explicit vintage + outDir
 *
 * NOTE: the PRIMARY way to load boundaries is `pnpm db:boundaries:refresh` (scripts/refresh-boundaries.ts),
 * which does the whole flow in one command (tunnel + download + convert + ingest + backfill). THIS tool is
 * only the standalone CONVERT step, kept for the air-gapped path: convert here, copy the GeoJSON to the
 * box, then `node dist/db/ingest-jurisdictions.js <file> <layer> [geoid-prefix]` per layer there.
 *
 * Scope + constraints: REQUIRES GDAL/ogr2ogr; run on a box that has it (never inside the API image: this
 * is a `scripts/` tsx tool, never a tsup entry). Touches NO database, NO env, NO npm deps beyond node
 * builtins. It does NOT download the sources; it expects each job's source already extracted under
 * `<outDir>/sources/` at the path the manifest's `sourcePath` names (TIGER `.shp`; PAD-US `.gdb`).
 *
 * Exit codes: 0 = at least one layer converted; 1 = NOTHING converted; 2 = GDAL not found / bad args.
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { boundaryManifest, type BoundaryJob } from "../src/db/boundaries/manifest.js"

const PREFIX = "prepare-boundaries"

function localSourceFor(job: BoundaryJob, outDir: string): string {
  return `${outDir}/sources/${job.sourcePath}`
}

function assertOgr2ogr(): void {
  try {
    execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" })
  } catch {
    console.error(
      `${PREFIX}: ogr2ogr (GDAL) not found on PATH; install GDAL (e.g. \`brew install gdal\`) and re-run.`,
    )
    process.exit(2)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith("--"))
  const vintageArg = positional[0]
  const vintage = vintageArg !== undefined ? Number(vintageArg) : undefined
  if (vintageArg !== undefined && !Number.isInteger(vintage)) {
    console.error(`${PREFIX}: vintage must be a 4-digit year (got "${vintageArg}")`)
    process.exit(2)
  }
  const outDir = positional[1] ?? "data/boundaries"

  assertOgr2ogr()

  const jobs = vintage === undefined ? boundaryManifest() : boundaryManifest(vintage)
  console.log(
    `${PREFIX}: ${jobs.length} job(s) -> ${outDir} (sources expected under ${outDir}/sources/)`,
  )

  let converted = 0
  const failed: string[] = []

  for (const job of jobs) {
    const source = localSourceFor(job, outDir)
    const outPath = `${outDir}/${job.outFile}`
    // OUTPUT before SOURCE: ogr2ogr's dst-then-src order. No geoid prefix here: prefixing is an
    // ingest-time concern (see the manifest header).
    const args = [...job.ogr2ogrArgs, outPath, source]
    console.log(`${PREFIX}: [${job.layer}] ogr2ogr ${args.join(" ")}`)
    try {
      execFileSync("ogr2ogr", args, { stdio: "inherit" })
      converted += 1
      const ingest =
        job.ingestGeoidPrefix === null
          ? `node dist/db/ingest-jurisdictions.js ${job.outFile} ${job.layer}`
          : `node dist/db/ingest-jurisdictions.js ${job.outFile} ${job.layer} ${job.ingestGeoidPrefix}`
      console.log(`${PREFIX}:   then -> ${ingest}`)
    } catch (err) {
      failed.push(job.outFile)
      console.error(`${PREFIX}: [${job.layer}] FAILED for ${job.outFile} (source: ${source})`)
      console.error(err)
    }
  }

  console.log(`${PREFIX}: done: ${converted} converted, ${failed.length} failed`)
  if (failed.length > 0) console.error(`${PREFIX}: failed/missing jobs: ${failed.join(", ")}`)
  if (converted === 0) process.exit(1)
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
