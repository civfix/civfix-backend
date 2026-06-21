/**
 * Automated jurisdiction-boundary refresh seam. Registers the "jurisdiction.refresh" pg-boss cron +
 * worker and houses runBoundaryRefresh — the on-box half of the boundary pipeline that ends the
 * "everything is Unmapped" problem with a fully self-maintaining nationwide load.
 *
 * THE PIPELINE (two halves, joined by R2). Real US boundaries — Census TIGER place/county/state + Census
 * AIANNH tribal + USGS PAD-US federal — are far too large to bake into the image, and prod Postgres is
 * not reachable from CI, so the work is split:
 *   - A scheduled GitHub Actions workflow (.github/workflows/boundaries-refresh.yml) does the heavy GDAL
 *     prep: probe the latest TIGER vintage, download the public-domain sources, ogr2ogr -> reprojected
 *     (EPSG:4326) GeoJSON, gzip, and publish a vintage-tagged bundle to R2 —
 *     boundaries/<tag>/<layer>.geojson.gz plus a manifest.json — flipping boundaries/current.json (the
 *     atomic pointer) LAST. GDAL lives ONLY on the CI runner; it never enters this runtime image.
 *   - THIS on-box cron reads current.json, compares the published vintageTag against the boundary_vintage
 *     row, and when they differ streams each layer out of R2 and loads it via the existing
 *     ingestGeoJsonFile (idempotent upsert-by-geoid, PRESERVES operator contacts), then backfillReports()
 *     heals NULL reports, then stamps boundary_vintage. When they match it is a cheap no-op (one R2 GET +
 *     one DB read), so a daily cron + a boot-time enqueue cost almost nothing except in the ~yearly
 *     window right after a new vintage publishes.
 *
 * GATING. Wired into server.ts start() in the SAME real-pg-boss + real-DATABASE_URL block as the inbound
 * sweep, so an all-fakes offline boot (dev/test) never registers it and never touches R2. The
 * "jurisdiction.refresh" queue is created in PgBossJobs.start() (API_QUEUE_NAMES) before schedule/work,
 * matching the inbound-sweep wiring (pg-boss v10 requires the queue to exist first).
 *
 * SAFETY (FK + crash). Every layer load is an upsert-by-geoid — NEVER a delete — so the
 * reports/gov_claims/mail_threads foreign keys into jurisdictions(geoid) can never be orphaned. A place
 * that DISAPPEARS in a new vintage simply keeps its prior boundary (advisory-stale; pruning such rows is
 * a deferred admin follow-up, see documents/20-jurisdiction-mapping.md). The vintage is stamped ONLY
 * after every layer + the backfill succeed, so a failure mid-run leaves the recorded vintage unchanged
 * and the next tick retries the whole idempotent load from scratch. The worker never throws (a bad bundle
 * logs loudly and waits for the next daily tick rather than churning pg-boss retries).
 *
 * NOTE on the event loop: each layer is gunzip+JSON.parse'd synchronously (a brief CPU block per file).
 * That is acceptable here because the refresh runs at most ~yearly, at the off-peak BOUNDARY_REFRESH_CRON
 * hour, and the per-file blocks are interleaved with awaited (non-blocking) DB upserts.
 */

import { gunzipSync } from "node:zlib"
import type { Container } from "../../di.js"
import { ingestGeoJsonFile, type IngestRow } from "../../db/ingest-jurisdictions.js"
import { backfillReports } from "../../db/backfill-jurisdictions.js"

/** The cron job name for the automated jurisdiction-boundary refresh. */
export const BOUNDARY_REFRESH_JOB = "jurisdiction.refresh"

/** R2 key prefix all boundary bundles live under (in container.boundaryStorage's bucket). */
const BOUNDARIES_PREFIX = "boundaries/"
/** The atomic pointer object naming the currently-published vintage. Written by CI LAST. */
const CURRENT_KEY = `${BOUNDARIES_PREFIX}current.json`

/** Valid jurisdiction layers (mirrors IngestRow["layer"]); used to validate the untrusted manifest. */
const VALID_LAYERS: ReadonlySet<string> = new Set(["place", "county", "state", "federal", "tribal"])
function asLayer(s: string): IngestRow["layer"] | null {
  return VALID_LAYERS.has(s) ? (s as IngestRow["layer"]) : null
}

/** boundaries/current.json — the atomic pointer CI flips last to activate a new bundle. */
interface CurrentPointer {
  vintageTag: string
}

/** One layer file inside a published bundle's manifest.json. */
interface BoundaryFileEntry {
  /** Object name within boundaries/<tag>/, e.g. "places_06.geojson.gz". */
  file: string
  /** Target jurisdiction layer (validated against VALID_LAYERS before ingest). */
  layer: string
  /** Load-time geoid prefix (e.g. "AIANNH-"/"PADUS-"); null for FIPS-hierarchical TIGER layers. */
  geoidPrefix: string | null
  /** Feature count CI recorded at publish time — the cron cross-checks it as a corruption guard. */
  featureCount: number
}

/** boundaries/<tag>/manifest.json — the bundle descriptor the cron loads from. */
interface PublishedManifest {
  vintageTag: string
  tigerVintage: number
  padusVersion: string
  files: BoundaryFileEntry[]
}

/**
 * The outcome of one refresh attempt. `noop-*` are the cheap common cases; `loaded` means a new vintage
 * was ingested; `error` is an expected, recoverable problem (bad/missing bundle) that leaves the recorded
 * vintage untouched so the next tick retries.
 */
export interface BoundaryRefreshResult {
  status: "noop-unpublished" | "noop-current" | "loaded" | "error"
  vintageTag?: string
  filesLoaded?: number
  upserted?: number
  reportsBackfilled?: number
  error?: string
}

/**
 * Read the published bundle pointed at by boundaries/current.json and, if it differs from the loaded
 * vintage, ingest every layer + backfill NULL reports + stamp boundary_vintage. Idempotent and
 * upsert-only (see file header). Takes the whole container so it can reach boundaryStorage + the raw DB
 * handle; factored out of the worker so the integration harness can drive it against a seeded R2 fake.
 */
export async function runBoundaryRefresh(container: Container): Promise<BoundaryRefreshResult> {
  const storage = container.boundaryStorage
  const sql = container.getDb().sql

  // 1) Atomic pointer. Absent -> nothing published yet (a fresh deploy before the first CI publish run).
  const currentBytes = await storage.getObject(CURRENT_KEY)
  if (currentBytes === null) return { status: "noop-unpublished" }
  let pointer: CurrentPointer
  try {
    pointer = JSON.parse(decodeUtf8(currentBytes)) as CurrentPointer
  } catch (err) {
    return { status: "error", error: `current.json parse failed: ${errMsg(err)}` }
  }
  const tag = (pointer.vintageTag ?? "").trim()
  if (!tag) return { status: "error", error: "current.json missing vintageTag" }

  // 2) Already loaded? The common daily/boot case — one R2 GET + one DB read, then return.
  const [row] = await sql<{ vintage_tag: string }[]>`SELECT vintage_tag FROM boundary_vintage LIMIT 1`
  if (row?.vintage_tag === tag) return { status: "noop-current", vintageTag: tag }

  // 3) Bundle manifest.
  const manifestBytes = await storage.getObject(`${BOUNDARIES_PREFIX}${tag}/manifest.json`)
  if (manifestBytes === null) {
    return { status: "error", error: `manifest.json missing for ${tag}`, vintageTag: tag }
  }
  let manifest: PublishedManifest
  try {
    manifest = JSON.parse(decodeUtf8(manifestBytes)) as PublishedManifest
  } catch (err) {
    return { status: "error", error: `manifest.json parse failed: ${errMsg(err)}`, vintageTag: tag }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { status: "error", error: `manifest.json lists no files for ${tag}`, vintageTag: tag }
  }

  // 4) Load each layer file (upsert-by-geoid). Abort WITHOUT stamping on the first hard error so the
  //    whole load is retried next tick; the already-upserted files just re-upsert idempotently then.
  const rowCounts: Record<string, number> = {}
  let filesLoaded = 0
  let upsertedTotal = 0
  for (const entry of manifest.files) {
    const layer = asLayer(String(entry.layer))
    if (layer === null) {
      return { status: "error", error: `unknown layer "${entry.layer}" in ${entry.file}`, vintageTag: tag }
    }
    const prefix = entry.geoidPrefix ?? undefined
    const key = `${BOUNDARIES_PREFIX}${tag}/${entry.file}`
    const bytes = await storage.getObject(key)
    if (bytes === null) {
      return { status: "error", error: `bundle object missing: ${key}`, vintageTag: tag }
    }
    const text = inflateUtf8(bytes)
    let result: { upserted: number; skipped: number; features: number }
    try {
      result = await ingestGeoJsonFile(sql, text, layer, prefix)
    } catch (err) {
      return { status: "error", error: `ingest ${entry.file} failed: ${errMsg(err)}`, vintageTag: tag }
    }
    // Corruption guard: the parsed feature count must equal what CI recorded for this exact file. (A
    // truncated download already fails JSON.parse above; this additionally catches a swapped/edited file.)
    if (typeof entry.featureCount === "number" && result.features !== entry.featureCount) {
      return {
        status: "error",
        error: `${entry.file}: parsed ${result.features} features != manifest ${entry.featureCount} (corrupt bundle)`,
        vintageTag: tag,
      }
    }
    rowCounts[layer] = (rowCounts[layer] ?? 0) + result.upserted
    upsertedTotal += result.upserted
    filesLoaded += 1
  }

  // 5) Heal reports.jurisdiction_geoid rows that were stamped NULL while coverage was missing.
  const { resolved } = await backfillReports(sql)

  // 6) Stamp the vintage LAST — only now that every layer + the backfill have succeeded.
  await sql`
    INSERT INTO boundary_vintage (id, vintage_tag, tiger_vintage, padus_version, row_counts, loaded_at)
    VALUES (
      true,
      ${tag},
      ${typeof manifest.tigerVintage === "number" ? manifest.tigerVintage : 0},
      ${typeof manifest.padusVersion === "string" ? manifest.padusVersion : ""},
      ${sql.json(rowCounts as Parameters<typeof sql.json>[0])},
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      vintage_tag = EXCLUDED.vintage_tag,
      tiger_vintage = EXCLUDED.tiger_vintage,
      padus_version = EXCLUDED.padus_version,
      row_counts = EXCLUDED.row_counts,
      loaded_at = now()
  `

  return {
    status: "loaded",
    vintageTag: tag,
    filesLoaded,
    upserted: upsertedTotal,
    reportsBackfilled: resolved,
  }
}

/**
 * Register the boundary-refresh cron + worker. Called from server.ts start() after the API queues are up
 * and only under real pg-boss + a real DATABASE_URL (the caller gates this). The worker never throws: a
 * bad bundle is logged loudly and retried on the next tick rather than failing the pg-boss job.
 */
export async function registerBoundaryRefreshJobs(container: Container): Promise<void> {
  await container.jobs.schedule(BOUNDARY_REFRESH_JOB, container.env.BOUNDARY_REFRESH_CRON)
  await container.jobs.work(BOUNDARY_REFRESH_JOB, async () => {
    try {
      const result = await runBoundaryRefresh(container)
      if (result.status === "error") {
        console.error(
          `jurisdiction.refresh: FAILED for ${result.vintageTag ?? "?"}: ${result.error} ` +
            `(vintage NOT stamped; will retry next tick)`,
        )
      } else if (result.status === "loaded") {
        console.info(
          `jurisdiction.refresh: loaded ${result.vintageTag} — ${result.filesLoaded} files, ` +
            `${result.upserted} jurisdictions upserted, ${result.reportsBackfilled} reports backfilled`,
        )
      }
      // noop-current / noop-unpublished: silent (the common daily case; logging every tick is noise).
    } catch (err) {
      // Belt-and-suspenders: an unexpected throw (e.g. a DB blip) must not crash the worker or churn
      // pg-boss retries. Log and let the next scheduled tick retry the whole idempotent load.
      console.error(`jurisdiction.refresh: unexpected failure: ${errMsg(err)}`)
    }
  })
}

/** Decompress a (possibly gzipped) R2 object to a UTF-8 string. The CI bundle is gzipped (.gz); a plain
 *  object is tolerated by sniffing the gzip magic bytes (0x1f 0x8b). */
function inflateUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes).toString("utf8")
  }
  return decodeUtf8(bytes)
}

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8")
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
