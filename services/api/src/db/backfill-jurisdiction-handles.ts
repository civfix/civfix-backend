/**
 * The read path derives a handle on the fly when the column is NULL, so mentions resolve without this
 * backfill; persisting a stable, deduplicated handle lets the directory show the canonical @handle. Slugs
 * come from the same jurisdictionHandle() the read path uses, so a stored handle matches a derived one.
 *
 * COLLISIONS: two jurisdictions can derive the same slug (two "Springfield"s), so later claimants get a
 * deterministic "_<geoidTail>" suffix. The UPDATE is guarded `WHERE handle IS NULL`, so an existing handle
 * is never clobbered and re-running is safe.
 *
 * TERMINATION: a row whose name yields no slug keeps its NULL handle but the cursor moves past it, so
 * every row is visited at most once.
 */

import type { Sql, SqlFragment } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"
import { jurisdictionHandle } from "../services/discussion-mentions.js"
import { isUniqueViolation } from "./pg-errors.js"

const BATCH_SIZE = 1000

const GEOID_TAIL_LENGTH = 4

const FIRST_NUMBERED_SUFFIX = 2

async function backfillHandles(sql: Sql): Promise<{ assigned: number; skipped: number }> {
  let assigned = 0
  let skipped = 0
  // Catches two rows of the same run deriving the same slug before the DB sees them; the UNIQUE index is
  // the real guard.
  const claimed = new Set<string>()
  let cursor: string | null = null

  for (;;) {
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND geoid > ${cursor}`
    const batch = await sql<{ geoid: string; name: string }[]>`
      SELECT geoid, name
      FROM jurisdictions
      WHERE handle IS NULL
        ${cursorFilter}
      ORDER BY geoid
      LIMIT ${BATCH_SIZE}
    `
    if (batch.length === 0) break

    for (const row of batch) {
      const base = jurisdictionHandle(row.name)
      if (base === null) {
        skipped += 1
        continue
      }
      if (await assignHandle(sql, base, row.geoid, claimed)) assigned += 1
      else skipped += 1
    }

    cursor = batch[batch.length - 1]!.geoid
    console.log(
      `backfill-handles: batch of ${batch.length}; running total assigned=${assigned}, skipped=${skipped}`,
    )
  }

  return { assigned, skipped }
}

/**
 * Returns false when a concurrent run won the row.
 *
 * The probe in claimHandle and this UPDATE are not atomic: a concurrent run can take the same slug in
 * between and the partial UNIQUE raises 23505, which would otherwise abort the whole run over one
 * collision. The candidate is marked taken and the next one tried; this terminates because every attempt
 * permanently removes one candidate from an infinite deterministic sequence.
 */
async function assignHandle(
  sql: Sql,
  base: string,
  geoid: string,
  claimed: Set<string>,
): Promise<boolean> {
  for (;;) {
    const handle = await claimHandle(sql, base, geoid, claimed)
    try {
      const updated = await sql<{ geoid: string }[]>`
        UPDATE jurisdictions
        SET handle = ${handle}
        WHERE geoid = ${geoid} AND handle IS NULL
        RETURNING geoid
      `
      if (updated.length === 0) return false
      claimed.add(handle.toLowerCase())
      return true
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      claimed.add(handle.toLowerCase())
    }
  }
}

/**
 * Tries the bare slug, then "<slug>_<geoid tail>", then numbered suffixes until one is free. The loop is
 * required: with three jurisdictions sharing a slug and geoid tail, or on a re-run, both fixed candidates
 * can already be taken. Deterministic per geoid, so a re-run lands the same handle.
 */
async function claimHandle(
  sql: Sql,
  base: string,
  geoid: string,
  claimed: Set<string>,
): Promise<string> {
  const taken = async (h: string): Promise<boolean> => {
    if (claimed.has(h.toLowerCase())) return true
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM jurisdictions WHERE lower(handle) = lower(${h}) LIMIT 1
    `
    return rows.length > 0
  }
  if (!(await taken(base))) return base
  const tail = geoid.slice(-GEOID_TAIL_LENGTH)
  const withTail = `${base}_${tail}`
  if (!(await taken(withTail))) return withTail
  for (let n = FIRST_NUMBERED_SUFFIX; ; n++) {
    const candidate = `${withTail}_${n}`
    if (!(await taken(candidate))) return candidate
  }
}

async function main(): Promise<void> {
  await runDbCli(async (_db, sql) => {
    const { assigned, skipped } = await backfillHandles(sql)
    console.log(
      `backfill-handles: done - ${assigned} jurisdictions got a handle, ${skipped} skipped (no usable slug)`,
    )
  })
}

runIfMain(import.meta.url, "backfill-handles", main)
