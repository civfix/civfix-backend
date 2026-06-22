/**
 * Backfill CLI: populate `jurisdictions.handle` (the @handle used to @mention a jurisdiction in a report
 * discussion) for rows where it IS NULL, deriving the slug from the jurisdiction NAME.
 *
 * WHY THIS EXISTS. The 0017 migration added a nullable `jurisdictions.handle` column with a partial UNIQUE
 * index on lower(handle). Most jurisdictions ship with NULL handle. The discussion read path derives a
 * handle on the fly (jurisdictionHandle(name)) when the column is NULL, so mentions still RESOLVE without a
 * backfill - but persisting a stable, deduplicated handle lets the directory show the canonical @handle and
 * keeps the on-the-fly derivation and the stored value in agreement.
 *
 * SLUG SOURCE = the SHARED pure helper. We derive each handle with jurisdictionHandle() from
 * discussion-mentions.ts - the SAME function the read path uses - so a backfilled handle is byte-identical
 * to what a read-time derivation would produce. DB-free + unit-tested in discussion-mentions.test.ts.
 *
 * COLLISIONS. lower(handle) is UNIQUE (partial, WHERE handle IS NOT NULL). Two jurisdictions can derive the
 * same slug (e.g. two "Springfield"s). We claim the bare slug for the first writer and disambiguate later
 * collisions by appending "_<geoidTail>" (the last 4 chars of the geoid) so every write succeeds and stays
 * deterministic. The UPDATE is guarded `WHERE handle IS NULL` so an already-set handle is never clobbered
 * and re-running is safe.
 *
 * KEYSET-CURSOR LOOP & TERMINATION. We page over `jurisdictions.geoid` (text PK, total order) with a
 * strictly-advancing cursor, BATCH_SIZE rows at a time, selecting only `handle IS NULL` rows. A row whose
 * name yields a null slug (all-punctuation) KEEPS its NULL handle but the cursor moves past it, so it is
 * visited at most once and the loop terminates when a SELECT returns zero rows.
 *
 * Requires DATABASE_URL + live Postgres; not exercised by the offline unit suite (the slug helper is, the
 * keyset loop is covered by the Docker-gated integration harness). Mirrors backfill-jurisdictions.ts.
 */

import type postgres from "postgres"
import type { Sql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"
import { jurisdictionHandle } from "../services/discussion-mentions.js"

type SqlFragment = postgres.Fragment

const BATCH_SIZE = 1000

/**
 * Assign `jurisdictions.handle` for every NULL-handle row, deriving the slug from the name and resolving
 * collisions deterministically. Returns a summary: `assigned` = rows that got a handle, `skipped` = rows
 * whose name yielded no usable slug (left NULL).
 *
 * Factored out of main() (raw `sql` tag in, counts out) so the integration harness can drive the same loop.
 */
export async function backfillHandles(sql: Sql): Promise<{ assigned: number; skipped: number }> {
  let assigned = 0
  let skipped = 0
  // In-process claim set so two rows in the SAME run that derive the same slug do not collide before the
  // DB sees them; the DB UNIQUE index is the ultimate guard (we re-check + disambiguate on conflict).
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
      const handle = await claimHandle(sql, base, row.geoid, claimed)
      const updated = await sql<{ geoid: string }[]>`
        UPDATE jurisdictions
        SET handle = ${handle}
        WHERE geoid = ${row.geoid} AND handle IS NULL
        RETURNING geoid
      `
      if (updated.length > 0) {
        assigned += 1
        claimed.add(handle.toLowerCase())
      } else {
        // A concurrent run set it first; leave it.
        skipped += 1
      }
    }

    cursor = batch[batch.length - 1]!.geoid
    console.log(
      `backfill-handles: batch of ${batch.length}; running total assigned=${assigned}, skipped=${skipped}`,
    )
  }

  return { assigned, skipped }
}

/**
 * Pick a free handle for a geoid: the bare slug when unclaimed (in-process + in-DB), else "<slug>_<tail>"
 * (the geoid's last 4 chars), then "<slug>_<tail>_2", "_3", … LOOPING until an unclaimed candidate is
 * found. Looping (vs trying only the bare slug + one tail candidate) is required: with ≥3 jurisdictions
 * sharing a slug AND trailing-4 geoid, or a re-run, both prior candidates could be taken — returning an
 * already-claimed value would violate the partial UNIQUE on lower(handle) and abort the whole backfill.
 * Deterministic per geoid so a re-run lands the same handle.
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
  const tail = geoid.slice(-4)
  const withTail = `${base}_${tail}`
  if (!(await taken(withTail))) return withTail
  for (let n = 2; ; n++) {
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
