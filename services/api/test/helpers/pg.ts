/**
 * Postgres integration-test harness.
 *
 * `withPg()` hands back a private, fully migrated + seeded database: a postgres-js tag (`sql`), a Drizzle
 * client (`db`), its `uri`, and a `teardown()`.
 *
 * The container is NOT started here. test/global-setup-pg.ts starts ONE `postgis/postgis:16-3.4`
 * container per vitest run and applies the canonical migrations + jurisdiction seed once into a TEMPLATE
 * database; this helper clones that template (`CREATE DATABASE ... TEMPLATE ...`, an in-server file copy)
 * so each test FILE still gets an isolated database (the same isolation a private container gave it),
 * without ~44 container boots and 44 × 60 migrations per run.
 *
 * CRITICAL for local dev: Docker may be absent (this repo is developed on machines with no Docker).
 * globalSetup detects that and reports it instead of throwing; withPg() then returns null, so tests can
 * `describe.skipIf(!pg)` and the suite stays green locally. That leniency is DEVELOPER-ONLY: in CI (or
 * under CIVFIX_REQUIRE_PG) assertPgSkipAllowed turns a Docker-absent run into a hard failure, because a
 * green build in which the whole integration suite silently did not run is worse than a red one. The
 * outcome is memoized per worker (a live handle OR a "skip" sentinel), so a whole file of tests shares one
 * database and never re-pays setup or re-attempts a failed Docker probe.
 *
 * `teardown()` closes this file's pools and drops its database; it never stops the shared container
 * (globalSetup owns that). A file that forgets to call it therefore leaks nothing beyond the run.
 */

import { randomUUID } from "node:crypto"
import { inject } from "vitest"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Sql } from "../../src/db/client.js"
import * as schema from "../../src/db/schema/index.js"
import type { ProvidedPg } from "../global-setup-pg.js"
import {
  assertPgSkipAllowed,
  createDatabase,
  dropDatabaseIfExists,
  startSharedPg,
  uniqueTestDbName,
  uriWithDatabase,
} from "./pg-container.js"

// The globalSetup -> worker channel. Typed here because this is the module that reads it.
declare module "vitest" {
  export interface ProvidedContext {
    civfixPg: ProvidedPg
  }
}

export interface PgHarness {
  /** Raw postgres-js tag bound to this file's database. */
  sql: Sql
  /** Drizzle client bound to the civfix schema. */
  db: ReturnType<typeof drizzle<typeof schema>>
  /** Connection URI of this file's database (pass to loadEnv as DATABASE_URL). */
  uri: string
  /** Close this file's pools and drop its database. Safe to call more than once. */
  teardown(): Promise<void>
}

/**
 * Memoized outcome. `undefined` = not attempted yet; `null` = attempted and Docker unavailable (skip);
 * otherwise the live harness. Per worker/module-registry, which is per test file under vitest's default
 * isolation; `torn` lets a file that already tore down (or a non-isolated worker running a second file)
 * get a fresh database instead of a closed pool.
 */
let memo: PgHarness | null | undefined
let torn = false
/** The in-flight setup, so two concurrent withPg() calls share one database instead of creating two. */
let pending: Promise<PgHarness | null> | undefined

/**
 * Get this file's Postgres harness, or null when Docker is unavailable (in which case the caller should
 * skip). On a developer machine the Docker-absent case never throws; in CI (or under CIVFIX_REQUIRE_PG)
 * it DOES (see assertPgSkipAllowed). A failed migration/seed/clone always throws, because that is a real
 * error and the test must fail rather than silently skip.
 */
export async function withPg(): Promise<PgHarness | null> {
  if (memo === null) return null
  if (memo !== undefined && !torn) return memo
  if (pending !== undefined) return await pending
  pending = create()
  try {
    return await pending
  } finally {
    pending = undefined
  }
}

async function create(): Promise<PgHarness | null> {
  const provided = readProvided()

  // No globalSetup in play (a bare/one-off vitest config), or it decided no pg test was selected and
  // one turned out to need it after all: fall back to this worker's own container, the pre-globalSetup
  // behavior. Correctness first: a misread of the CLI filters must never silently skip a real test.
  if (provided === undefined || provided.kind === "not-started") {
    return await bootOwnContainer()
  }

  if (provided.kind === "unavailable") {
    // Belt to globalSetup's braces: it already refuses to report `unavailable` where a skip is
    // forbidden, so reaching here in CI means the guard was bypassed, so fail rather than skip.
    assertPgSkipAllowed(provided.reason)
    console.warn(`[pg harness] skipped: docker unavailable (${firstLine(provided.reason)})`)
    memo = null
    return null
  }

  const dbName = uniqueTestDbName()
  await createDatabase(provided.adminUri, dbName, provided.templateDb)
  const harness = openHarness(uriWithDatabase(provided.adminUri, dbName), () =>
    dropDatabaseIfExists(provided.adminUri, dbName),
  )
  torn = false
  memo = harness
  return harness
}

/**
 * Build the clients + teardown for an already-created database.
 *
 * `after` runs once the pools are closed (drop the cloned database, or stop the fallback container).
 */
function openHarness(uri: string, after: () => Promise<void>): PgHarness {
  // Raw client (full postgres.js serialization) for the repositories and test-side inserts.
  const sql = postgres(uri, { max: 4, onnotice: () => {} }) as Sql
  // Drizzle gets its OWN client so it never clobbers `sql`'s value serializers (see makeDb in
  // src/db/client.ts and drizzle-orm#3108).
  const drizzleSql = postgres(uri, { max: 2, onnotice: () => {} })
  const db = drizzle(drizzleSql, { schema })

  let done = false
  return {
    sql,
    db,
    uri,
    async teardown() {
      if (done) return
      done = true
      torn = true
      await Promise.all([sql.end({ timeout: 5 }), drizzleSql.end({ timeout: 5 })]).catch(() => {})
      await after()
    },
  }
}

/**
 * Legacy path: start a container for THIS worker, migrate it, and use it directly. Only reached when no
 * shared container was provided (see withPg). teardown() stops it, so nothing outlives the file.
 */
async function bootOwnContainer(): Promise<PgHarness | null> {
  // startSharedPg has already applied the skip guard (it throws where a skip is forbidden), so an
  // !ok result here is a legitimate developer-machine skip.
  const result = await startSharedPg()
  if (!result.ok) {
    console.warn(`[pg harness] skipped: docker unavailable (${firstLine(result.reason)})`)
    memo = null
    return null
  }
  const { adminUri, templateDb, stop } = result.pg
  const dbName = uniqueTestDbName()
  try {
    await createDatabase(adminUri, dbName, templateDb)
  } catch (err) {
    await stop()
    throw err
  }
  const harness = openHarness(uriWithDatabase(adminUri, dbName), stop)
  torn = false
  memo = harness
  return harness
}

/**
 * Read the globalSetup channel. A config with no globalSetup provides nothing (inject yields undefined),
 * and outside a vitest worker inject throws while reaching for worker state; both are the same
 * "no shared container was handed to me" answer, not an error.
 */
function readProvided(): ProvidedPg | undefined {
  try {
    return inject("civfixPg") as ProvidedPg | undefined
  } catch {
    return undefined
  }
}

function firstLine(s: string): string {
  const i = s.indexOf("\n")
  return i === -1 ? s : s.slice(0, i)
}

/**
 * A valid, unique-enough @handle (matches HANDLE_REGEX ^[A-Za-z0-9_]{3,20}$) for a fixture user whose
 * handle is immaterial to the test. Use where a helper passes handle EXPLICITLY (an explicit value,
 * even null, bypasses the SET DEFAULT applied to the test template); pass a real handle instead when the
 * test asserts on it.
 */
export function testHandle(): string {
  return "u" + randomUUID().replace(/-/g, "").slice(0, 12)
}

/**
 * Seed ONE follow edge the way production does: the edge row AND the two denormalized counters
 * (drizzle/0059_users_follow_counters.sql).
 *
 * 0059 deliberately installs no trigger: "anything writing follows_people outside those two methods (a
 * psql session, a test fixture, a future bulk import) must bump the counters too". So a fixture that
 * `INSERT INTO follows_people` and nothing else leaves users.follower_count / following_count at 0 while
 * the edge exists, and every profile/roster read in that file reports `followers: 0`, a wrong-by-fixture
 * number that looks exactly like a product bug. Use this (or the repository's addFollow) instead of a raw
 * INSERT whenever the test might read a count.
 *
 * Mirrors social-repository.drizzle.ts addFollow: ON CONFLICT DO NOTHING ... RETURNING, and the counters
 * move ONLY when a row was actually inserted, so a repeated seed is a no-op rather than a double count.
 * Returns whether an edge was created. `createdAt` is for fixtures that order or window on the edge's age
 * (the column otherwise defaults to now()). Deliberately does NOT check for a soft-deleted followee
 * (addFollow refuses one; fixtures legitimately seed tombstone edges, which 0059 counts).
 */
export async function seedFollowEdge(
  sql: Sql,
  followerId: string,
  followeeId: string,
  createdAt?: Date,
): Promise<boolean> {
  return await sql.begin(async (tx) => {
    const inserted = await tx<{ follower_id: string }[]>`
      INSERT INTO follows_people (follower_id, followee_id, created_at)
      VALUES (${followerId}, ${followeeId}, ${createdAt ?? sql`now()`})
      ON CONFLICT (follower_id, followee_id) DO NOTHING
      RETURNING follower_id
    `
    if (inserted.length === 0) return false
    await tx`
      UPDATE users SET
        follower_count = follower_count + CASE WHEN id = ${followeeId} THEN 1 ELSE 0 END,
        following_count = following_count + CASE WHEN id = ${followerId} THEN 1 ELSE 0 END
      WHERE id IN (${followerId}, ${followeeId})
    `
    return true
  })
}
