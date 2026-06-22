/**
 * Migration runner for the hand-authored, canonical civfix DDL.
 *
 * Applies every .sql file in services/api/drizzle in lexical order, each inside its OWN transaction,
 * and records applied files in a bookkeeping table `_civfix_migrations(name text primary key,
 * applied_at timestamptz)`. A file that is already recorded is skipped, so re-running is safe.
 *
 * Design notes:
 *   - We do NOT use drizzle-kit's generated-migration journal: the hand SQL is the source of truth
 *     (PostGIS geometry, GiST indexes, declarative partitioning cannot be expressed by drizzle-kit).
 *   - Each file runs via `sql.unsafe(text)` in simple-query mode (no bind params), which lets a file
 *     contain multiple statements. Wrapping each file in `sql.begin()` makes a failed file roll back
 *     atomically; the bookkeeping insert is in the same transaction so a file is only ever marked
 *     applied if it fully succeeded.
 *   - Most statements are themselves idempotent (CREATE ... IF NOT EXISTS), so even a half-recorded
 *     state recovers cleanly.
 *   - Requires DATABASE_URL and a reachable Postgres. Exits non-zero on any error. Because it needs a
 *     live database, it is exercised in CI (Docker) and by the Testcontainers harness, not by the
 *     offline unit suite. The pure file-ordering logic lives in migrate-files.ts and IS unit-tested.
 */

import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Sql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"
import { orderMigrationFiles } from "./migrate-files.js"

/** Absolute path to services/api/drizzle, resolved relative to this module (cwd-independent). */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")

/**
 * Fixed advisory-lock key so two instances/CI jobs booting concurrently serialize the apply loop instead
 * of racing the same file (a non-IF-NOT-EXISTS statement applied twice would abort the deploy, and deploys
 * are NOT health-gated). Arbitrary constant, unique to this runner.
 */
const MIGRATE_ADVISORY_LOCK_KEY = 4747120626

/** Ensure the bookkeeping table exists. Idempotent. */
async function ensureBookkeeping(sql: Sql): Promise<void> {
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS _civfix_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
}

/** Fetch the set of already-applied migration file names. */
async function appliedSet(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _civfix_migrations`
  return new Set(rows.map((r) => r.name))
}

/**
 * Apply all pending migrations from `dir` using `sql`. Returns the list of files that were applied
 * (in order). Exported for reuse by the Testcontainers harness so tests apply the EXACT same SQL the
 * runner does.
 *
 * Concurrency: a reserved (connection-pinned) session-level `pg_advisory_lock` serializes the whole
 * read-applied -> apply-pending sequence, so two instances booting at once don't both try to apply the
 * same file. The lock + every per-file transaction run on the SAME reserved connection.
 *
 * GOTCHA: each file is one `tx.unsafe(text)` in a transaction, so a large-table `CREATE INDEX`
 * (non-CONCURRENTLY — CONCURRENTLY can't run in a tx) takes a SHARE lock that blocks writes on
 * reports/chat_messages during the deploy. For a big table, add the index out-of-band with
 * `CREATE INDEX CONCURRENTLY` BEFORE the migration and make the migration's `CREATE INDEX ... IF NOT
 * EXISTS` a no-op.
 */
export async function applyMigrations(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const reserved = await sql.reserve()
  try {
    await reserved`SELECT pg_advisory_lock(${MIGRATE_ADVISORY_LOCK_KEY})`
    await ensureBookkeeping(reserved)
    const already = await appliedSet(reserved)

    const entries = await readdir(dir)
    const ordered = orderMigrationFiles(entries)

    const applied: string[] = []
    for (const name of ordered) {
      if (already.has(name)) continue
      const text = await readFile(join(dir, name), "utf8")
      // Transaction-per-file: the DDL and its bookkeeping row commit together or not at all.
      await reserved.begin(async (tx) => {
        await tx.unsafe(text)
        await tx`INSERT INTO _civfix_migrations (name) VALUES (${name})`
      })
      applied.push(name)
    }
    return applied
  } finally {
    await reserved`SELECT pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_KEY})`.catch(() => {})
    reserved.release()
  }
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
