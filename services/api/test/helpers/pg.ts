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
import { randomUUID } from "node:crypto"
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
    await applyTestFixtureDefaults(sql)
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

/**
 * Test-harness-only column defaults for two NOT-NULL columns the PRODUCTION app always supplies but
 * that raw fixture inserts here would otherwise have to hand-roll at ~30 call sites:
 *
 *   - users.handle   — made NOT NULL (no default) by 0026_user_handle_required.sql. The app assigns a
 *                      handle during registration; fixtures that insert a bare user don't care about it.
 *   - reports.type   — 0021_report_type.sql adds it with a default 'other' then DROPS the default, so
 *                      the app must send a type. Fixtures that set up a report to exercise a read query
 *                      don't care about the fine type.
 *
 * These defaults change ONLY the throwaway test container (never the canonical migrations / production
 * schema) and weaken NO assertion: the suite has no test that a bare insert of these columns is rejected,
 * and every place that actually cares supplies an explicit value (which overrides the default). A fixture
 * that must pin a handle passes one; one that doesn't get a unique generated placeholder.
 */
async function applyTestFixtureDefaults(sql: Sql): Promise<void> {
  await sql`ALTER TABLE users ALTER COLUMN handle SET DEFAULT 'u' || substr(md5(random()::text), 1, 12)`
  await sql`ALTER TABLE reports ALTER COLUMN type SET DEFAULT 'other'`
}

/**
 * A valid, unique-enough @handle (matches HANDLE_REGEX ^[A-Za-z0-9_]{3,20}$) for a fixture user whose
 * handle is immaterial to the test. Use where a helper passes handle EXPLICITLY (an explicit value —
 * even null — bypasses the SET DEFAULT above); pass a real handle instead when the test asserts on it.
 */
export function testHandle(): string {
  return "u" + randomUUID().replace(/-/g, "").slice(0, 12)
}
