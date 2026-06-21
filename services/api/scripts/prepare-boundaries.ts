/**
 * Boundary-prep runner (ops/CI): the thin imperative wrapper around the PURE boundaryManifest
 * (src/db/boundaries/manifest.ts). For each job it shells `ogr2ogr` to convert one already-downloaded
 * Census/USGS source into a reprojected (EPSG:4326) GeoJSON file, then GZIPS it and records it in a
 * manifest.json. This is the "prep" half of the automated boundary pipeline: the GitHub Actions workflow
 * (.github/workflows/boundaries-refresh.yml) runs this on a GDAL-equipped runner and uploads the
 * resulting boundaries/<tag>/*.geojson.gz + manifest.json to R2, where the on-box jurisdiction.refresh
 * cron (services/admin/boundary-refresh-jobs.ts) picks them up via the existing ingestGeoJsonFile loader.
 *
 *   pnpm db:prepare-boundaries --print-tag 2025   # print the bundle's vintage tag (no IO/GDAL), then exit
 *   pnpm db:prepare-boundaries                     # default vintage, outDir data/boundaries
 *   pnpm db:prepare-boundaries 2025 out            # explicit vintage + outDir
 *   tsx scripts/prepare-boundaries.ts [vintage] [outDir] [--print-tag]
 *
 * IMPORTANT scope + constraints (why this is a .ts script under scripts/, not a tsup entry):
 *   - It REQUIRES GDAL/ogr2ogr (except --print-tag). It is a build/CI tool run on a runner that has GDAL;
 *     it NEVER runs inside the production API image, so it is deliberately NOT a tsup entry and node
 *     `dist/` never contains it.
 *   - It is run via `tsx` (TypeScript) specifically so it can import the manifest from `src` directly —
 *     a plain .mjs under node cannot import a .ts module. It is the single source of the conversion
 *     commands; the manifest is the single source of WHAT to convert + the canonical vintage tag.
 *   - It touches NO database and NO env, adds NO npm dependency (only node:child_process + node:fs/zlib).
 *
 * What it does NOT do: it does not DOWNLOAD the source archives — fetching/unzipping is the workflow's job
 * (curl + unzip in bash). It expects each job's source to already be present under `<outDir>/sources/`
 * using the archive's basename with the shapefile/gdb extension. It converts what it can, continues past
 * per-job failures (e.g. a best-effort source like PAD-US that could not be fetched is simply omitted from
 * the manifest), gzips each success, and writes <outDir>/manifest.json describing the bundle.
 *
 * Exit codes: 0 = at least one layer converted (manifest written); 1 = NOTHING converted; 2 = GDAL not
 * found / bad args.
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { gzipSync } from "node:zlib"
import {
  boundaryManifest,
  vintageTag,
  PADUS_VERSION,
  DEFAULT_TIGER_VINTAGE,
  type BoundaryJob,
} from "../src/db/boundaries/manifest.js"

const PREFIX = "prepare-boundaries"

/** One entry in the published bundle manifest.json the CI workflow uploads alongside the .geojson.gz
 *  files; the on-box jurisdiction.refresh cron reads this to know what to ingest. Mirrors the
 *  BoundaryFileEntry shape in services/admin/boundary-refresh-jobs.ts. */
interface ManifestEntry {
  file: string
  layer: BoundaryJob["layer"]
  geoidPrefix: string | null
  featureCount: number
}

/** The local dataset path ogr2ogr reads for a job: each job declares its sourcePath (the .shp or .gdb it
 *  extracts to) in the manifest, under <outDir>/sources/. */
function localSourceFor(job: BoundaryJob, outDir: string): string {
  return `${outDir}/sources/${job.sourcePath}`
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

/**
 * Count features in a converted GeoJSON FeatureCollection: `total` is the raw feature count (recorded in
 * the manifest so the cron can corruption-check the bytes it later loads against fc.features.length), and
 * `polygons` is how many have a Polygon/MultiPolygon geometry — i.e. how many the ingest CLI will actually
 * load (normalizeFeatures skips non-polygon/null-geometry features). A layer with total>0 but polygons===0
 * means the geometry was dropped during conversion; the caller treats that as a failure. Throws if the
 * output is not a parseable FeatureCollection.
 */
function countFeatureGeoms(raw: Buffer): { total: number; polygons: number } {
  const fc = JSON.parse(raw.toString("utf8")) as {
    type?: string
    features?: { geometry?: { type?: string } | null }[]
  }
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    throw new Error("converted output is not a GeoJSON FeatureCollection")
  }
  let polygons = 0
  for (const f of fc.features) {
    const t = f?.geometry?.type
    if (t === "Polygon" || t === "MultiPolygon") polygons += 1
  }
  return { total: fc.features.length, polygons }
}

function main(): void {
  // Args: [vintage] [outDir], plus the optional --print-tag flag. vintage is a 4-digit year (omitted ->
  // manifest default); outDir holds sources/ (inputs) + the .geojson.gz outputs + manifest.json.
  const argv = process.argv.slice(2)
  const printTag = argv.includes("--print-tag")
  const positional = argv.filter((a) => !a.startsWith("--"))
  const vintageArg = positional[0]
  const vintage = vintageArg !== undefined ? Number(vintageArg) : undefined
  if (vintageArg !== undefined && !Number.isInteger(vintage)) {
    console.error(`${PREFIX}: vintage must be a 4-digit year (got "${vintageArg}")`)
    process.exit(2)
  }
  const year = vintage ?? DEFAULT_TIGER_VINTAGE

  // --print-tag: cheap, IO-free mode the CI workflow calls FIRST to compute the bundle's vintage tag and
  // skip the expensive download/convert when that tag is already published to R2. No GDAL needed.
  if (printTag) {
    console.log(vintageTag(year))
    return
  }

  // --list-sources: print one source archive URL per line so the workflow's download step stays DRY
  // (the 50-state PLACE list + URL patterns live ONLY in the manifest). No GDAL needed.
  if (argv.includes("--list-sources")) {
    const jobs = vintage === undefined ? boundaryManifest() : boundaryManifest(vintage)
    for (const job of jobs) console.log(job.sourceUrl)
    return
  }

  const outDir = positional[1] ?? "data/boundaries"

  assertOgr2ogr()

  // vintage===undefined -> let the manifest apply its own default; otherwise pass the year through.
  const jobs = vintage === undefined ? boundaryManifest() : boundaryManifest(vintage)
  console.log(
    `${PREFIX}: ${jobs.length} job(s) -> ${outDir} (sources expected under ${outDir}/sources/)`,
  )

  let converted = 0
  const failed: string[] = []
  const entries: ManifestEntry[] = []

  for (const job of jobs) {
    const source = localSourceFor(job, outDir)
    const outPath = `${outDir}/${job.outFile}`
    // The full argv: the manifest's conversion args, then OUTPUT then SOURCE (ogr2ogr's positional order
    // is dst-then-src). NOTE: no geoid prefix appears here — prefixing is an ingest-time concern.
    const args = [...job.ogr2ogrArgs, outPath, source]
    console.log(`${PREFIX}: [${job.layer}] ogr2ogr ${args.join(" ")}`)
    try {
      execFileSync("ogr2ogr", args, { stdio: "inherit" })
      const raw = readFileSync(outPath)
      const { total, polygons } = countFeatureGeoms(raw)
      // A layer that parsed but has ZERO ingestable (polygon) features is a conversion FAILURE, not a
      // shippable layer — this catches an empty source AND the subtle "geometry got dropped" case (the
      // file has N features but all with null geometry), which would otherwise publish + ingest 0 rows
      // silently. featureCount records the RAW total (what the cron's truncation guard compares its parsed
      // fc.features.length against); the pass/fail decision uses the polygon count.
      if (polygons === 0) {
        throw new Error(`0 ingestable (polygon) features (${total} total) — treating as a conversion failure`)
      }
      // gzip to <outFile>.gz (the form the bundle ships + the cron loads), then delete the (large)
      // uncompressed file to keep the CI runner's disk in budget (nationwide GeoJSON is multi-GB).
      writeFileSync(`${outPath}.gz`, gzipSync(raw))
      unlinkSync(outPath)
      entries.push({
        file: `${job.outFile}.gz`,
        layer: job.layer,
        geoidPrefix: job.ingestGeoidPrefix,
        featureCount: total,
      })
      converted += 1
      console.log(`${PREFIX}:   -> ${job.outFile}.gz (${total} features)`)
    } catch (err) {
      failed.push(job.outFile)
      console.error(`${PREFIX}: [${job.layer}] FAILED for ${job.outFile} (source: ${source})`)
      console.error(err)
    }
  }

  // Census (TIGER/AIANNH) layers are REQUIRED: a missing one means partial nationwide coverage we must
  // NOT publish. Only the federal (PAD-US) layer is best-effort. So a failure of ANY non-federal job exits
  // non-zero (the workflow's convert step fails → nothing is published). The federal-only failure is
  // tolerated and handled by the "-nofed" tag below.
  const federalOutFile = jobs.find((j) => j.layer === "federal")?.outFile
  const requiredFailed = failed.filter((f) => f !== federalOutFile)
  if (requiredFailed.length > 0) {
    console.error(
      `${PREFIX}: REQUIRED layers failed (${requiredFailed.join(", ")}) — refusing to publish a partial-coverage bundle`,
    )
    process.exit(1)
  }

  // The bundle's vintage tag reflects what actually converted: the full tag when federal (PAD-US) is
  // present, else a "-nofed" tag. This makes the pipeline SELF-HEALING — a run that publishes a federal-
  // less bundle lands under a distinct tag, so a later run that DOES get federal publishes under the full
  // tag, which the on-box cron sees as a new vintage and reloads (the box keys purely on tag equality).
  const hasFederal = entries.some((e) => e.layer === "federal")
  const tag = hasFederal ? vintageTag(year) : `${vintageTag(year)}-nofed`

  // Write the bundle manifest the cron reads (lists ONLY the layers that converted successfully).
  const manifest = { vintageTag: tag, tigerVintage: year, padusVersion: PADUS_VERSION, files: entries }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2))

  console.log(
    `${PREFIX}: done — ${converted} converted, ${failed.length} failed; tag=${tag}; manifest -> ${outDir}/manifest.json`,
  )
  if (failed.length > 0) console.error(`${PREFIX}: federal omitted (best-effort): ${failed.join(", ")}`)
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
