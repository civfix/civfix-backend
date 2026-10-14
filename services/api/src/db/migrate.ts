/**
 * drizzle-kit's generated-migration journal is not used: the hand SQL is the source of truth because
 * drizzle-kit cannot express PostGIS geometry, GiST indexes or declarative partitioning.
 *
 * Each file runs through `unsafe(text)` in simple-query mode (no bind params) so it may hold several
 * statements, and its bookkeeping row commits in the same transaction, so a file is only ever marked
 * applied if it fully succeeded.
 */

import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Sql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"
import { orderMigrationFiles } from "./migrate-files.js"

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")

/**
 * Serializes concurrent runners: a non-idempotent statement applied twice would abort the deploy.
 * Arbitrary constant, unique to this runner.
 */
const MIGRATE_ADVISORY_LOCK_KEY = 4747120626

async function ensureBookkeeping(sql: Sql): Promise<void> {
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS _civfix_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

async function appliedSet(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _civfix_migrations`
  return new Set(rows.map((r) => r.name))
}

/**
 * Exported so the Testcontainers harness applies exactly the SQL the runner does. The session-level
 * advisory lock and every per-file transaction run on one reserved connection, so the whole
 * read-applied -> apply-pending sequence is serialized.
 *
 * GOTCHA: CREATE INDEX CONCURRENTLY cannot run in a transaction, so a plain CREATE INDEX here takes a
 * SHARE lock that blocks writes on a big table during the deploy. Build such an index out-of-band with
 * CONCURRENTLY first and make the migration's CREATE INDEX IF NOT EXISTS a no-op.
 */
export async function applyMigrations(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const reserved = await sql.reserve()
  let sessionClean = true
  let backendPid: number | null = null
  try {
    const pidRows = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
    backendPid = pidRows[0]?.pid ?? null
    await reserved`SELECT pg_advisory_lock(${MIGRATE_ADVISORY_LOCK_KEY})`
    await ensureBookkeeping(reserved)
    const already = await appliedSet(reserved)

    const entries = await readdir(dir)
    const ordered = orderMigrationFiles(entries)

    const applied: string[] = []
    for (const name of ordered) {
      if (already.has(name)) continue
      const text = await readFile(join(dir, name), "utf8")
      // A reserved connection has no `.begin()` in postgres 3.4 (only the pool does), so BEGIN/COMMIT
      // are driven explicitly on the pinned connection.
      await reserved.unsafe("begin")
      try {
        await reserved.unsafe(text)
        await reserved`INSERT INTO _civfix_migrations (name) VALUES (${name})`
        await reserved.unsafe("commit")
      } catch (err) {
        await reserved.unsafe("rollback").catch((rollbackErr: unknown) => {
          sessionClean = false
          console.error(`migrate: rollback after ${name} failed`, rollbackErr)
        })
        throw err
      }
      applied.push(name)
    }
    return applied
  } finally {
    await reserved`SELECT pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_KEY})`.catch(
      (unlockErr: unknown) => {
        sessionClean = false
        console.error("migrate: releasing the migration advisory lock failed", unlockErr)
      },
    )
    if (sessionClean) {
      reserved.release()
    } else {
      await discardSession(sql, backendPid)
    }
  }
}

// postgres.js cannot close a single reserved connection, and releasing it would park a session that
// may be mid-transaction and may still hold the session-level migration lock in the pool, where the
// next applyMigrations would wait on that lock forever. Ending the backend from another pooled
// connection frees the lock server-side; the reserved slot is deliberately never returned.
async function discardSession(sql: Sql, backendPid: number | null): Promise<void> {
  if (backendPid === null) return
  await sql`SELECT pg_terminate_backend(${backendPid})`.catch((terminateErr: unknown) => {
    console.error(`migrate: terminating backend ${backendPid} failed`, terminateErr)
  })
}

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const applied = await applyMigrations(sql)
    if (applied.length === 0) {
      console.log("migrate: up to date, nothing to apply")
    } else {
      console.log(`migrate: applied ${applied.length} migration(s):`)
      for (const name of applied) console.log(`  - ${name}`)
    }
  })
}

runIfMain(import.meta.url, "migrate", main)
