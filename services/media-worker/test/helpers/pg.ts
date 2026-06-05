/**
 * Postgres integration harness for the worker (Docker-gated; SKIPS when Docker is unavailable).
 *
 * Mirrors the API's withPg: starts a throwaway postgis container, applies the SAME canonical migrations
 * via the shared @civfix/api/migrate runner (single source of DDL), and hands back a RAW postgres-js tag
 * (`sql`, full value serialization) plus a Drizzle client on its OWN separate connection. On machines
 * with no Docker (like this dev box) it returns null so the integration suite is skipped, keeping the
 * local run green; CI runs it for real.
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

export const POSTGIS_IMAGE = "postgis/postgis:16-3.4"

export interface WorkerPgHarness {
  sql: Sql
  db: Db
  teardown(): Promise<void>
}

let memo: WorkerPgHarness | null | undefined

export async function withWorkerPg(): Promise<WorkerPgHarness | null> {
  if (memo !== undefined) return memo

  let started: import("@testcontainers/postgresql").StartedPostgreSqlContainer
  try {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql")
    started = await new PostgreSqlContainer(POSTGIS_IMAGE).start()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[worker pg harness] skipped: docker unavailable (${reason.split("\n")[0]})`)
    memo = null
    return null
  }

  const uri = started.getConnectionUri()
  // Raw client (full postgres.js serialization) for raw `sql` queries + migrations.
  const sql = postgres(uri, { max: 4, onnotice: () => {} }) as Sql
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
    db: db as unknown as Db,
    async teardown() {
      if (torn) return
      torn = true
      await closeClients()
      await started.stop().catch(() => {})
    },
  }
  memo = harness
  return harness
}
