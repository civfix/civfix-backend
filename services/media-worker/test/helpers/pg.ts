/**
 * Postgres integration harness for the worker (Docker-gated; SKIPS when Docker is unavailable).
 *
 * Mirrors the API's withPg: starts a throwaway postgis container, applies the SAME canonical migrations
 * via the shared @civfix/api/migrate runner (single source of DDL), and hands back a RAW postgres-js tag
 * (`sql`, full value serialization) plus a Drizzle client on its OWN separate connection. On machines
 * with no Docker it returns null so the integration suite is skipped, keeping the local run green; CI
 * runs it for real and REFUSES to skip there (see assertSkipAllowed).
 *
 * ONE CONTAINER PER FILE, deliberately, unlike the API side. The API harness boots a single container in
 * a vitest globalSetup, migrates a TEMPLATE database once and clones it per file, because it has ~44
 * Docker-gated files and was paying 44 boots + 44 x 60 migrations. This package has TWO, so the shared
 * design would save one boot (~3s) at the price of duplicating globalSetup + the template-clone
 * primitives here: the API's copies live in its private test tree (services/api/test/helpers/pg-container.ts)
 * and are NOT reachable from another package: @civfix/api exports src entrypoints only, and exporting test
 * helpers from a service package to share 70 lines of container plumbing is the worse trade. What IS shared
 * is everything that affects OUTCOMES rather than speed: the same migrate runner, the same image pin, the
 * same throwaway-database server settings below, and the same CI skip guard. Revisit if this package grows
 * a third Docker-gated file.
 *
 * TWO CLIENTS, like the API harness and makeDb (drizzle-orm#3108): `drizzle(client)` overwrites that
 * client's postgres.js value serializers with identity passthroughs, so drizzle gets its OWN client and
 * the raw `sql` keeps full serialization. Sharing one client would make any raw `sql` query that binds a
 * JS Date/object/array throw ERR_INVALID_ARG_TYPE.
 */

import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { schema, type Db, type Sql } from "@civfix/api/db"
import { applyMigrations } from "@civfix/api/migrate"

const POSTGIS_IMAGE = "postgis/postgis:16-3.4"

/**
 * Server knobs for a THROWAWAY database, matching the API harness's POSTGRES_TUNING: durability is
 * worthless when the container is destroyed at the end of the run, and every file here pays all ~60 API
 * migrations. Adopted for PARITY with the API harness rather than on a measured win: on a dev box
 * (colima, ~10s for the two files) tuned and untuned runs were inside run-to-run noise; the fsync cost it
 * removes is a CI/overlayfs effect. max_connections is left at the default: unlike the API's shared
 * container, only one file at a time connects here (4 + 2 connections).
 */
const POSTGRES_TUNING = [
  "-c",
  "fsync=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "full_page_writes=off",
]

/** Values an environment variable uses to mean "on" (providers disagree). */
const TRUTHY = new Set(["1", "true", "yes", "on"])

function isOn(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase())
}

/**
 * Refuse to turn "no Docker" into "no tests" where a skip is not legitimate.
 *
 * The skip exists so a developer on a Docker-less machine gets a green unit suite. In CI the same leniency
 * would let a broken Docker socket delete this package's ENTIRE integration coverage (the only thing that
 * runs the worker's SQL against the canonical schema) while the job still reports success. Same contract
 * and same variable names as the API harness's assertPgSkipAllowed (services/api/test/helpers/pg-container.ts);
 * duplicated rather than imported because that module is private to the API's test tree.
 */
function assertSkipAllowed(reason: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isOn(env.CIVFIX_ALLOW_PG_SKIP)) return
  const required = isOn(env.CIVFIX_REQUIRE_PG) || isOn(env.CI)
  if (!required) return
  const because = isOn(env.CIVFIX_REQUIRE_PG) ? "CIVFIX_REQUIRE_PG is set" : `CI=${env.CI ?? ""}`
  throw new Error(
    `[worker pg harness] Postgres is REQUIRED in this environment (${because}), but the PostGIS ` +
      `container could not start, which would have SILENTLY SKIPPED the worker integration suite. ` +
      `Fix Docker, or set CIVFIX_ALLOW_PG_SKIP=1 to accept a run with no integration coverage. ` +
      `Underlying failure: ${reason}`,
  )
}

export interface WorkerPgHarness {
  sql: Sql
  db: Db
  /** The container's connection URI, for code under test that takes a DATABASE_URL (e.g. makeSeams). */
  uri: string
  teardown(): Promise<void>
}

let memo: WorkerPgHarness | null | undefined

export async function withWorkerPg(): Promise<WorkerPgHarness | null> {
  if (memo !== undefined) return memo

  let started: import("@testcontainers/postgresql").StartedPostgreSqlContainer
  try {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql")
    started = await new PostgreSqlContainer(POSTGIS_IMAGE).withCommand(POSTGRES_TUNING).start()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Developer machine: skip. CI: fail loudly rather than run zero integration tests.
    assertSkipAllowed(reason)
    console.warn(`[worker pg harness] skipped: docker unavailable (${reason.split("\n")[0]})`)
    memo = null
    return null
  }

  const uri = started.getConnectionUri()
  // Raw client (full postgres.js serialization) for raw `sql` queries + migrations.
  const sql = postgres(uri, { max: 4, onnotice: () => {} })
  // Drizzle gets its OWN client so it never clobbers `sql`'s value serializers (see makeDb in
  // @civfix/api src/db/client.ts and drizzle-orm#3108). Mirrors the API test harness.
  const drizzleSql = postgres(uri, { max: 2, onnotice: () => {} })
  const db = drizzle(drizzleSql, { schema })

  const closeClients = () =>
    Promise.all([sql.end({ timeout: 5 }), drizzleSql.end({ timeout: 5 })]).catch(() => {})

  try {
    // Apply the EXACT canonical migrations the production runner applies (default dir resolves to the
    // API package's drizzle/ folder via the runner's own module-relative path).
    await applyMigrations(sql)
  } catch (err) {
    await closeClients()
    await started.stop().catch(() => {})
    throw err
  }

  let torn = false
  const harness: WorkerPgHarness = {
    sql,
    db: db,
    uri,
    async teardown() {
      if (torn) return
      torn = true
      // DROP THE MEMO. Without this, a second integration file (or any caller after the first file's
      // afterAll) got this same harness back with both postgres clients already closed - failing with
      // "write CONNECTION_ENDED" instead of starting its own container. Clearing it makes withWorkerPg
      // re-provision on the next call, which is the only correct answer once this one is gone.
      if (memo === harness) memo = undefined
      await closeClients()
      await started.stop().catch(() => {})
    },
  }
  memo = harness
  return harness
}
