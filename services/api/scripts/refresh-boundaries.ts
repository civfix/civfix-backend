/**
 * refresh-boundaries: the ONE local command that loads real nationwide jurisdiction boundaries into prod
 * Postgres. Run it on a workstation (Mac/Linux) that has GDAL + SSH access to the prod box:
 *
 *   pnpm db:boundaries:refresh                 # latest TIGER vintage, auto SSH tunnel to prod
 *   pnpm db:boundaries:refresh 2025            # explicit TIGER vintage year
 *   pnpm db:boundaries:refresh 2025 /tmp/bnd   # explicit vintage + work dir
 *
 * What it does, end to end (no CI, no R2):
 *   1. Opens an `ssh -L` tunnel to prod Postgres (resolves the postgres container's live bridge IP +
 *      password via `ssh`, forwards a local port). Skipped if DATABASE_URL is already set (then it loads
 *      against that directly — open your own tunnel and export it if you prefer).
 *   2. Downloads the public-domain sources the manifest enumerates (Census TIGER state/county/place×50 +
 *      Census AIANNH; USGS PAD-US federal is best-effort) and unzips them.
 *   3. Converts each with `ogr2ogr` (reproject 4269→4326; places filtered G4110; federal Fee/FED via the
 *      manifest's -sql) — REQUIRES GDAL on PATH (`brew install gdal`).
 *   4. Ingests each layer via ingestGeoJsonFile (idempotent upsert-by-geoid; PRESERVES operator contacts),
 *      runs backfillReports (heals NULL reports.jurisdiction_geoid), and records the load in boundary_vintage.
 *   5. Tears the tunnel down + cleans the work dir.
 *
 * Re-runnable any time (annually when a new TIGER vintage drops, or after PAD-US bumps): every step is an
 * idempotent upsert. Census layers are REQUIRED (a failed census download/convert aborts the whole run);
 * only PAD-US federal is best-effort (a hiccup there just skips the federal layer). This is a `scripts/`
 * tsx tool — NEVER bundled into the API image, so it can import the DB client + ingest core directly.
 *
 * Config via env (all optional): BOUNDARIES_SSH_HOST (default "civfix"), BOUNDARIES_PG_CONTAINER
 * (compose-postgres-1), BOUNDARIES_PG_USER (civfix), BOUNDARIES_PG_DB (civfix), BOUNDARIES_LOCAL_PORT
 * (15433), DATABASE_URL (skip the tunnel + use this), BOUNDARIES_KEEP=1 (keep the work dir).
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeDb, type DbHandle } from "../src/db/client.js"
import {
  boundaryManifest,
  vintageTag,
  PADUS_VERSION,
  DEFAULT_TIGER_VINTAGE,
  type BoundaryJob,
} from "../src/db/boundaries/manifest.js"
import { ingestGeoJsonFile, ingestGeoJsonSeqFile } from "../src/db/ingest-jurisdictions-core.js"
import { backfillReports } from "../src/db/backfill-jurisdictions-core.js"

const PREFIX = "refresh-boundaries"
const log = (m: string): void => console.log(`${PREFIX}: ${m}`)
const warn = (m: string): void => console.warn(`${PREFIX}: ⚠ ${m}`)

const SSH_HOST = process.env.BOUNDARIES_SSH_HOST ?? "civfix"
const PG_CONTAINER = process.env.BOUNDARIES_PG_CONTAINER ?? "compose-postgres-1"
const PG_USER = process.env.BOUNDARIES_PG_USER ?? "civfix"
const PG_DB = process.env.BOUNDARIES_PG_DB ?? "civfix"
const LOCAL_PORT = Number(process.env.BOUNDARIES_LOCAL_PORT ?? "15433")

/** True when the federal (PAD-US) job — the one best-effort layer. */
function isFederal(job: BoundaryJob): boolean {
  return job.layer === "federal"
}

/** Run `ssh <host> <remoteCmd>` and return trimmed stdout. */
function ssh(remoteCmd: string): string {
  return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", SSH_HOST, remoteCmd], {
    encoding: "utf8",
  }).trim()
}

/** Poll until 127.0.0.1:port accepts a TCP connection (the forward is live), or throw after `tries`. */
async function waitForPort(port: number, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, "127.0.0.1")
      s.once("connect", () => {
        s.destroy()
        resolve(true)
      })
      s.once("error", () => resolve(false))
      s.setTimeout(1000, () => {
        s.destroy()
        resolve(false)
      })
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`tunnel local port ${port} never became reachable`)
}

/**
 * Open an `ssh -L` tunnel to prod Postgres and return {databaseUrl, close}. Resolves the postgres
 * container's live bridge IP (it shifts on stack recreate) + its password over ssh, then forwards
 * 127.0.0.1:LOCAL_PORT → <bridge-ip>:5432. The password lives only in the returned URL (never logged).
 */
async function openTunnel(): Promise<{ databaseUrl: string; close: () => void }> {
  log(`resolving prod Postgres on ${SSH_HOST} (${PG_CONTAINER})…`)
  const pgIp = ssh(
    `sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${PG_CONTAINER}`,
  )
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(pgIp)) throw new Error(`could not resolve postgres bridge IP (got "${pgIp}")`)
  const pgPass = ssh(`sudo -n docker exec ${PG_CONTAINER} printenv POSTGRES_PASSWORD`)
  if (!pgPass) throw new Error("could not read POSTGRES_PASSWORD from the prod container")

  log(`opening ssh -L ${LOCAL_PORT}:${pgIp}:5432 ${SSH_HOST}`)
  const child: ChildProcess = spawn(
    "ssh",
    ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", `${LOCAL_PORT}:${pgIp}:5432`, SSH_HOST],
    { stdio: ["ignore", "inherit", "inherit"] },
  )
  child.on("exit", (code) => {
    if (code !== null && code !== 0) warn(`ssh tunnel exited early (code ${code})`)
  })
  await waitForPort(LOCAL_PORT)
  log("tunnel up")

  const databaseUrl = `postgres://${PG_USER}:${encodeURIComponent(pgPass)}@127.0.0.1:${LOCAL_PORT}/${PG_DB}?sslmode=disable`
  return { databaseUrl, close: () => child.kill() }
}

/** Download + unzip one job's source archive into <outDir>/sources/. */
function fetchSource(job: BoundaryJob, outDir: string): boolean {
  const zip = join(outDir, "_download.zip")
  try {
    execFileSync("curl", ["-fsSL", job.sourceUrl, "-o", zip], { stdio: ["ignore", "inherit", "inherit"] })
    // unzip exit 1 == benign warning (extra bytes) with extraction OK; only >1 is fatal.
    try {
      execFileSync("unzip", ["-o", "-q", zip, "-d", join(outDir, "sources")], { stdio: "inherit" })
    } catch (e) {
      const code = (e as { status?: number }).status
      if (typeof code === "number" && code > 1) throw e
    }
    return true
  } catch (err) {
    if (!isFederal(job)) throw err
    warn(`PAD-US source fetch failed (${job.sourceUrl}) — federal layer will be skipped`)
    return false
  } finally {
    rmSync(zip, { force: true })
  }
}

/** Convert one job's source to GeoJSON with ogr2ogr; returns the output path or null on a (best-effort) miss. */
function convert(job: BoundaryJob, outDir: string): string | null {
  const src = join(outDir, "sources", job.sourcePath)
  if (!existsSync(src)) {
    if (isFederal(job)) return null
    throw new Error(`required source missing after download: ${src}`)
  }
  const outPath = join(outDir, job.outFile)
  log(`[${job.layer}] ogr2ogr → ${job.outFile}`)
  try {
    execFileSync("ogr2ogr", [...job.ogr2ogrArgs, outPath, src], { stdio: "inherit" })
  } catch (err) {
    if (isFederal(job)) {
      warn(`PAD-US convert failed — federal layer will be skipped`)
      return null
    }
    throw err
  }
  return outPath
}

async function main(): Promise<void> {
  // Verify GDAL up front (the whole point of running locally).
  try {
    execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" })
  } catch {
    console.error(`${PREFIX}: ogr2ogr (GDAL) not found on PATH — install it (e.g. \`brew install gdal\`) and re-run.`)
    process.exit(2)
  }

  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith("--"))
  const vintageArg = positional[0]
  const year = vintageArg ? Number(vintageArg) : DEFAULT_TIGER_VINTAGE
  if (!Number.isInteger(year)) {
    console.error(`${PREFIX}: vintage must be a 4-digit year (got "${vintageArg}")`)
    process.exit(2)
  }
  const outDir = positional[1] ?? join(tmpdir(), `civfix-boundaries-${year}`)
  const keep = argv.includes("--keep")

  const jobs = boundaryManifest(year)
  log(`vintage ${year}: ${jobs.length} layer job(s); work dir ${outDir}`)
  mkdirSync(join(outDir, "sources"), { recursive: true })

  // 1) DB connection: an explicit DATABASE_URL wins (BYO tunnel); else open an ssh -L tunnel to prod.
  let closeTunnel: (() => void) | null = null
  let databaseUrl = process.env.DATABASE_URL ?? ""
  if (databaseUrl) {
    log("using DATABASE_URL from the environment (skipping the auto SSH tunnel)")
  } else {
    const t = await openTunnel()
    databaseUrl = t.databaseUrl
    closeTunnel = t.close
  }

  let handle: DbHandle | null = null
  try {
    // 2) Download → 3) convert. Census layers are required (throw aborts the run); federal is best-effort.
    const converted: { job: BoundaryJob; path: string }[] = []
    for (const job of jobs) {
      const got = fetchSource(job, outDir)
      if (!got) continue
      const out = convert(job, outDir)
      if (out) converted.push({ job, path: out })
    }
    if (!converted.some((c) => !isFederal(c.job))) {
      throw new Error("no census layers converted — refusing to load a partial-coverage dataset")
    }

    // 4) Ingest each layer + backfill, against prod over the tunnel.
    handle = makeDb(databaseUrl, { max: 1 })
    const rowCounts: Record<string, number> = {}
    let federalLoaded = false
    for (const { job, path } of converted) {
      try {
        // The federal (PAD-US) layer is emitted as GeoJSONSeq (.geojsonl) and STREAMED — it is >512 MB,
        // which exceeds Node's max string length, so readFileSync would throw ERR_STRING_TOO_LONG. The
        // small TIGER layers are read whole.
        const { upserted, skipped, features } = path.endsWith(".geojsonl")
          ? await ingestGeoJsonSeqFile(handle.sql, path, job.layer, job.ingestGeoidPrefix ?? undefined)
          : await ingestGeoJsonFile(handle.sql, readFileSync(path, "utf8"), job.layer, job.ingestGeoidPrefix ?? undefined)
        rowCounts[job.layer] = (rowCounts[job.layer] ?? 0) + upserted
        log(`[${job.layer}] upserted ${upserted} (skipped ${skipped} of ${features})`)
        if (upserted === 0) warn(`[${job.layer}] upserted 0 rows — check the source/conversion`)
        if (isFederal(job)) federalLoaded = true
      } catch (err) {
        // Federal is best-effort: an ingest hiccup on it must NOT discard the TIGER layers already committed
        // (each layer is its own transaction). Any non-federal failure is fatal.
        if (!isFederal(job)) throw err
        warn(`[federal] ingest failed — skipping federal layer (${(err as Error).message})`)
      }
    }

    log("backfilling reports.jurisdiction_geoid (NULL → resolved)…")
    const { resolved, stayedNull } = await backfillReports(handle.sql)
    log(`backfill: ${resolved} reports resolved, ${stayedNull} still null (outside all coverage)`)

    // 5) Record the load (audit trail for this manual, ~annual process). Tag notes federal presence —
    //    "-nofed" if PAD-US was missing/failed at any of fetch, convert, OR ingest.
    const tag = federalLoaded ? vintageTag(year) : `${vintageTag(year)}-nofed`
    await handle.sql`
      INSERT INTO boundary_vintage (id, vintage_tag, tiger_vintage, padus_version, row_counts, loaded_at)
      VALUES (true, ${tag}, ${year}, ${PADUS_VERSION}, ${handle.sql.json(rowCounts as Parameters<typeof handle.sql.json>[0])}, now())
      ON CONFLICT (id) DO UPDATE SET
        vintage_tag = EXCLUDED.vintage_tag,
        tiger_vintage = EXCLUDED.tiger_vintage,
        padus_version = EXCLUDED.padus_version,
        row_counts = EXCLUDED.row_counts,
        loaded_at = now()
    `
    log(`done — loaded vintage ${tag}; row counts: ${JSON.stringify(rowCounts)}`)
  } finally {
    if (handle) await handle.close()
    if (closeTunnel) closeTunnel()
    if (!keep) rmSync(outDir, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error(`${PREFIX}: failed`)
  console.error(err)
  process.exit(1)
})
