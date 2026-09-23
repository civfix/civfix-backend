import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from "node:fs"
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
import {
  backfillReports,
  pruneNonAuthoritativeJurisdictions,
} from "../src/db/backfill-jurisdictions-core.js"
import { backfillPopulation } from "../src/db/backfill-population-core.js"

const PREFIX = "refresh-boundaries"
const log = (m: string): void => console.log(`${PREFIX}: ${m}`)
const warn = (m: string): void => console.warn(`${PREFIX}: ⚠ ${m}`)

const SSH_HOST = process.env.BOUNDARIES_SSH_HOST ?? "civfix"
const PG_CONTAINER = process.env.BOUNDARIES_PG_CONTAINER ?? "compose-postgres-1"
const PG_USER = process.env.BOUNDARIES_PG_USER ?? "civfix"
const PG_DB = process.env.BOUNDARIES_PG_DB ?? "civfix"
const LOCAL_PORT = Number(process.env.BOUNDARIES_LOCAL_PORT ?? "15433")
const PRUNE_CONFIRMED = process.argv.slice(2).includes("--yes")

function isFederal(job: BoundaryJob): boolean {
  return job.layer === "federal"
}

function ssh(remoteCmd: string): string {
  return execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", SSH_HOST, remoteCmd],
    {
      encoding: "utf8",
    },
  ).trim()
}

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

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/

function resolvePostgresIp(): string {
  const raw = ssh(
    `sudo -n docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.IPAddress}}{{"\\n"}}{{end}}' ${PG_CONTAINER}`,
  )
  const attached = raw
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && IPV4.test(parts[1]!))
    .map(([network, ip]) => ({ network, ip }))
  const picked =
    attached.find((a) => a.network.endsWith("_default")) ??
    (attached.length === 1 ? attached[0] : undefined)
  if (!picked) {
    throw new Error(
      `could not pick the postgres bridge IP for ${PG_CONTAINER}; networks reported: ${raw || "(none)"}`,
    )
  }
  log(`postgres bridge IP ${picked.ip} on network ${picked.network}`)
  return picked.ip
}

async function openTunnel(): Promise<{ databaseUrl: string; close: () => void }> {
  log(`resolving prod Postgres on ${SSH_HOST} (${PG_CONTAINER})…`)
  const pgIp = resolvePostgresIp()
  const pgPass = ssh(`sudo -n docker exec ${PG_CONTAINER} printenv POSTGRES_PASSWORD`)
  if (!pgPass) throw new Error("could not read POSTGRES_PASSWORD from the prod container")

  log(`opening ssh -L ${LOCAL_PORT}:${pgIp}:5432 ${SSH_HOST}`)
  const child: ChildProcess = spawn(
    "ssh",
    [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${LOCAL_PORT}:${pgIp}:5432`,
      SSH_HOST,
    ],
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

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const DOWNLOAD_ATTEMPTS = 3

function looksLikeZip(path: string): boolean {
  const fd = openSync(path, "r")
  try {
    const head = Buffer.alloc(ZIP_MAGIC.length)
    const n = readSync(fd, head, 0, head.length, 0)
    return n === head.length && head.equals(ZIP_MAGIC)
  } finally {
    closeSync(fd)
  }
}

function responseSummary(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
}

function downloadZip(url: string, zip: string): void {
  let lastResponse = ""
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const attemptUrl =
      attempt === 1 ? url : `${url}${url.includes("?") ? "&" : "?"}attempt=${attempt}`
    execFileSync("curl", ["-fsSL", attemptUrl, "-o", zip], {
      stdio: ["ignore", "inherit", "inherit"],
    })
    if (looksLikeZip(zip)) return
    lastResponse = responseSummary(zip)
    warn(
      `${url}: response is not a zip archive (attempt ${attempt}/${DOWNLOAD_ATTEMPTS}): ${lastResponse}`,
    )
  }
  throw new Error(
    `${url}: never returned a zip archive after ${DOWNLOAD_ATTEMPTS} attempts; last response: ${lastResponse}`,
  )
}

function fetchSource(job: BoundaryJob, outDir: string): boolean {
  if (existsSync(join(outDir, "sources", job.sourcePath))) {
    log(`[${job.layer}] reusing already-extracted ${job.sourcePath}`)
    return true
  }
  const zip = join(outDir, "_download.zip")
  try {
    downloadZip(job.sourceUrl, zip)
    try {
      execFileSync("unzip", ["-o", "-q", zip, "-d", join(outDir, "sources")], { stdio: "inherit" })
    } catch (e) {
      const code = (e as { status?: number }).status
      if (typeof code === "number" && code > 1) throw e
    }
    return true
  } catch (err) {
    if (!isFederal(job)) throw err
    warn(`PAD-US source fetch failed (${job.sourceUrl}); federal layer will be skipped`)
    return false
  } finally {
    rmSync(zip, { force: true })
  }
}

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
      warn(`PAD-US convert failed; federal layer will be skipped`)
      return null
    }
    throw err
  }
  return outPath
}

type Sql = Parameters<typeof backfillReports>[0]

async function countLoadedLayers(
  sql: Sql,
): Promise<{ rowCounts: Record<string, number>; federalLoaded: boolean }> {
  const rows = await sql<{ layer: string; n: number }[]>`
    SELECT layer, count(*)::int AS n FROM jurisdictions GROUP BY layer
  `
  const rowCounts: Record<string, number> = {}
  for (const r of rows) rowCounts[r.layer] = r.n
  return { rowCounts, federalLoaded: (rowCounts.federal ?? 0) > 0 }
}

async function prune(sql: Sql): Promise<void> {
  const result = await pruneNonAuthoritativeJurisdictions(sql, { apply: PRUNE_CONFIRMED })
  if (result.staleGeoids.length === 0) return
  log(
    `${result.staleGeoids.length} non-authoritative (dev-seed) federal/tribal jurisdiction(s); ` +
      `rows pointing at them: ${JSON.stringify(result.affected)}`,
  )
  if (!result.applied) {
    throw new Error("re-run with --yes to prune the rows counted above (nothing was changed)")
  }
  log(`pruned; re-resolved in the same transaction: ${JSON.stringify(result.reresolved)}`)
  if (result.affected.gov_claims > 0 || result.affected.mail_threads > 0) {
    warn(
      `left without a jurisdiction (no geometry to re-derive from): ` +
        `${result.affected.gov_claims} gov_claims, ${result.affected.mail_threads} mail_threads`,
    )
  }
}

async function stampVintage(
  sql: Sql,
  tag: string,
  year: number,
  rowCounts: Record<string, number>,
): Promise<void> {
  await sql`
    INSERT INTO boundary_vintage (id, vintage_tag, tiger_vintage, padus_version, row_counts, loaded_at)
    VALUES (true, ${tag}, ${year}, ${PADUS_VERSION}, ${sql.json(rowCounts)}, now())
    ON CONFLICT (id) DO UPDATE SET
      vintage_tag = EXCLUDED.vintage_tag,
      tiger_vintage = EXCLUDED.tiger_vintage,
      padus_version = EXCLUDED.padus_version,
      row_counts = EXCLUDED.row_counts,
      loaded_at = now()
  `
}

async function main(): Promise<void> {
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
  const backfillOnly = argv.includes("--backfill-only")

  if (!backfillOnly) {
    try {
      execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" })
    } catch {
      console.error(
        `${PREFIX}: ogr2ogr (GDAL) not found on PATH; install it (e.g. \`brew install gdal\`) and re-run.`,
      )
      process.exit(2)
    }
  }

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
  let completed = false
  try {
    handle = makeDb(databaseUrl, { max: 1, statementTimeoutMs: 0, idleInTxTimeoutMs: 0 })

    let rowCounts: Record<string, number>
    let federalLoaded: boolean

    if (backfillOnly) {
      await prune(handle.sql)
      log("--backfill-only: skipping download/convert/ingest; reading layers already in the DB")
      ;({ rowCounts, federalLoaded } = await countLoadedLayers(handle.sql))
      const total = Object.values(rowCounts).reduce((a, b) => a + b, 0)
      if (total === 0)
        warn(
          "no jurisdictions in the DB; run a full load first (this backfill will resolve nothing)",
        )
    } else {
      log(`vintage ${year}: ${boundaryManifest(year).length} layer job(s); work dir ${outDir}`)
      mkdirSync(join(outDir, "sources"), { recursive: true })

      const converted: { job: BoundaryJob; path: string }[] = []
      for (const job of boundaryManifest(year)) {
        const got = fetchSource(job, outDir)
        if (!got) continue
        const out = convert(job, outDir)
        if (out) converted.push({ job, path: out })
      }
      if (!converted.some((c) => !isFederal(c.job))) {
        throw new Error("no census layers converted; refusing to load a partial-coverage dataset")
      }

      rowCounts = {}
      federalLoaded = false
      for (const { job, path } of converted) {
        try {
          const { upserted, skipped, features } = path.endsWith(".geojsonl")
            ? await ingestGeoJsonSeqFile(
                handle.sql,
                path,
                job.layer,
                job.ingestGeoidPrefix ?? undefined,
              )
            : await ingestGeoJsonFile(
                handle.sql,
                readFileSync(path, "utf8"),
                job.layer,
                job.ingestGeoidPrefix ?? undefined,
              )
          rowCounts[job.layer] = (rowCounts[job.layer] ?? 0) + upserted
          log(`[${job.layer}] upserted ${upserted} (skipped ${skipped} of ${features})`)
          if (upserted === 0) warn(`[${job.layer}] upserted 0 rows; check the source/conversion`)
          if (isFederal(job)) federalLoaded = true
        } catch (err) {
          if (!isFederal(job)) throw err
          warn(`[federal] ingest failed; skipping federal layer (${(err as Error).message})`)
        }
      }

      await prune(handle.sql)
    }

    log("backfilling reports.jurisdiction_geoid (NULL → resolved)…")
    const { resolved, stayedNull } = await backfillReports(handle.sql)
    log(`backfill: ${resolved} reports resolved, ${stayedNull} still null (outside all coverage)`)

    try {
      log("backfilling jurisdictions.population from Census ACS…")
      const pop = await backfillPopulation(handle.sql, { log: (m) => log(`population: ${m}`) })
      log(`population: ${pop.updated} jurisdictions updated from ${pop.fetched} ACS rows`)
    } catch (err) {
      warn(`population backfill failed (boundaries unaffected): ${(err as Error).message}`)
    }

    const tag = federalLoaded ? vintageTag(year) : `${vintageTag(year)}-nofed`
    await stampVintage(handle.sql, tag, year, rowCounts)
    log(`done: vintage ${tag}; row counts: ${JSON.stringify(rowCounts)}`)
    completed = true
  } finally {
    if (handle) await handle.close()
    if (closeTunnel) closeTunnel()
    if (!keep && !backfillOnly && completed) {
      rmSync(outDir, { recursive: true, force: true })
    } else if (!keep && !backfillOnly && !completed) {
      warn(`run did not complete; keeping the work dir for retry/inspection: ${outDir}`)
    }
  }
}

main().catch((err: unknown) => {
  console.error(`${PREFIX}: failed`)
  console.error(err)
  process.exit(1)
})
