/**
 * Postgres integration-test harness.
 *
 * `withPg()` starts a throwaway `postgis/postgis:16-3.4` container (via @testcontainers/postgresql),
 * applies the canonical hand SQL migrations + the jurisdiction seed, and hands back a postgres-js tag
 * (`sql`), a Drizzle client (`db`), and a `teardown()`.
 *
 * CRITICAL for local dev: Docker may be absent (this repo is developed on machines with no Docker).
 * Starting a container then throws. We DETECT that and return null instead of failing, so tests can
 * `describe.skipIf(!pg)` and the suite stays green locally. In CI (Docker present) the same tests run
 * for real. We probe/start exactly once and memoize the outcome (a started handle OR a "skip"
 * sentinel) so a whole file of tests shares one container and we never re-pay startup or re-attempt a
 * failed Docker probe.
 */

import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import type { Sql } from "../../src/db/client.js"
import * as schema from "../../src/db/schema/index.js"
import { applyMigrations } from "../../src/db/migrate.js"
import { seedJurisdictions } from "../../src/db/seed.js"

/** The PostGIS image we run. Pinned so spatial behavior is reproducible. */
export const POSTGIS_IMAGE = "postgis/postgis:16-3.4"

/** Absolute path to the canonical migrations directory (services/api/drizzle), cross-platform. */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle/", import.meta.url))

export interface PgHarness {
  /** Raw postgres-js tag bound to the container. */
  sql: Sql
  /** Drizzle client bound to the civfix schema. */
  db: ReturnType<typeof drizzle<typeof schema>>
  /** Connection URI of the container (for diagnostics). */
  uri: string
  /** Stop the container and close the pool. Safe to call once. */
  teardown(): Promise<void>
}

/**
 * Memoized start outcome. `undefined` = not attempted yet; `null` = attempted and Docker unavailable
 * (skip); otherwise the live harness. Shared process-wide so multiple test files reuse one container.
 */
let memo: PgHarness | null | undefined

/** Reason captured when Docker is unavailable, surfaced once so the skip is visible in output. */
let skipReason: string | undefined

/**
 * Try to bring up Postgres for tests. Returns a harness, or null when Docker is unavailable (in which
 * case the caller should skip). Never throws for the Docker-absent case.
 */
export async function withPg(): Promise<PgHarness | null> {
  if (memo !== undefined) return memo

  let started: StartedPostgreSqlContainer
  try {
    started = await new PostgreSqlContainer(POSTGIS_IMAGE).start()
  } catch (err) {
    // Docker not installed / daemon not running / image unavailable: skip, do not fail.
    skipReason = err instanceof Error ? err.message : String(err)

    console.warn(`[pg harness] skipped: docker unavailable (${firstLine(skipReason)})`)
    memo = null
    return null
  }

  const uri = started.getConnectionUri()
  // Raw client (full postgres.js serialization) for the repositories, test-side inserts, and migrations.
  const sql = postgres(uri, { max: 4, onnotice: () => {} }) as Sql
  // Drizzle gets its OWN client so it never clobbers `sql`'s value serializers (see makeDb in
  // src/db/client.ts and drizzle-orm#3108).
  const drizzleSql = postgres(uri, { max: 2, onnotice: () => {} })
  const db = drizzle(drizzleSql, { schema })

  const closeClients = () =>
    Promise.all([sql.end({ timeout: 5 }), drizzleSql.end({ timeout: 5 })]).catch(() => {})

  try {
    // Apply the EXACT canonical SQL the production runner applies, then the shared seed.
    await applyMigrations(sql, MIGRATIONS_DIR)
    await seedJurisdictions(sql)
  } catch (err) {
    // A migration/seed failure is a real error: clean up and rethrow so the test FAILS (not skips).
    await closeClients()
    await started.stop().catch(() => {})
    throw err
  }

  let torn = false
  const harness: PgHarness = {
    sql,
    db,
    uri,
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

/** True if a prior withPg() attempt found Docker unavailable. */
export function pgSkipped(): boolean {
  return memo === null
}

/** The captured Docker-unavailable reason, if any (for test diagnostics). */
export function pgSkipReason(): string | undefined {
  return skipReason
}

function firstLine(s: string): string {
  const i = s.indexOf("\n")
  return i === -1 ? s : s.slice(0, i)
}
