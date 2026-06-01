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
import { makeDb } from "./client.js"
import { loadEnv } from "../env.js"
import { orderMigrationFiles } from "./migrate-files.js"

/** Absolute path to services/api/drizzle, resolved relative to this module (cwd-independent). */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")

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
 */
export async function applyMigrations(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await ensureBookkeeping(sql)
  const already = await appliedSet(sql)

  const entries = await readdir(dir)
  const ordered = orderMigrationFiles(entries)

  const applied: string[] = []
  for (const name of ordered) {
    if (already.has(name)) continue
    const text = await readFile(join(dir, name), "utf8")
    // Transaction-per-file: the DDL and its bookkeeping row commit together or not at all.
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`INSERT INTO _civfix_migrations (name) VALUES (${name})`
    })
    applied.push(name)
  }
  return applied
}

async function main(): Promise<void> {
  const env = loadEnv()
  const handle = makeDb(env.DATABASE_URL, { max: 1 })
  try {
    const applied = await applyMigrations(handle.sql)
    if (applied.length === 0) {
      console.log("migrate: up to date, nothing to apply")
    } else {
      console.log(`migrate: applied ${applied.length} migration(s):`)
      for (const name of applied) console.log(`  - ${name}`)
    }
  } finally {
    await handle.close()
  }
}

// Run only when executed directly (tsx src/db/migrate.ts), not when imported by the harness/tests.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("migrate: failed")
    console.error(err)
    process.exit(1)
  })
}
