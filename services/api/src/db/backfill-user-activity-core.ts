/**
 * Keyset-paged backfill of users.last_activity_geom / last_activity_at (0102, audit H18).
 *
 * The live write paths (report create, event create, event complete) maintain the pair going forward;
 * this fills the rows that predate them. It is deliberately a POST-DEPLOY step, never migration DDL:
 * it walks every user and reads two indexed sub-selects per row, which has no business holding the
 * migration transaction open.
 *
 * SAFE TO RUN AGAINST LIVE TRAFFIC, and safe to re-run: each page is a single UPDATE whose
 * `last_activity_at IS NULL OR last_activity_at < candidate` guard is the SAME monotonic guard the live
 * writers use (db/sql/user-activity.ts), so a concurrent report create always wins over the older value
 * this backfill computed, in either commit order.
 *
 * KEYSET CURSOR: pages over users.id, advancing past the WHOLE page including rows that had nothing to
 * backfill, so no row is visited twice and the loop ends on the first empty page.
 *
 * The candidate point mirrors what suggestFollows' old per-candidate LATERAL derived: the most recent of
 * (a) a report the user filed and (b) an event they organized, by the row's own created_at. Completed
 * events move the pair forward at completion time going forward; there is no historical completion
 * timestamp for rows that predate 0103, so the backfill does not invent one.
 *
 * No `main()` and no run-as-CLI guard here, so bundled entries can import this module freely (see
 * ingest-jurisdictions-core.ts for the tsup-bundling rationale behind the guard-free cores).
 */

import type postgres from "postgres"
import type { Sql } from "./client.js"

type SqlFragment = postgres.Fragment

export const USER_ACTIVITY_BACKFILL_BATCH = 500

export async function backfillUserActivity(
  sql: Sql,
  opts: { batchSize?: number; log?: (message: string) => void } = {},
): Promise<{ scanned: number; filled: number }> {
  const batchSize = opts.batchSize ?? USER_ACTIVITY_BACKFILL_BATCH
  const log = opts.log ?? ((message: string) => console.log(`backfill-user-activity: ${message}`))
  let scanned = 0
  let filled = 0
  let cursor: string | null = null

  for (;;) {
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND id > ${cursor}`
    const page = await sql<{ id: string }[]>`
      SELECT id
      FROM users
      WHERE deleted_at IS NULL
        ${cursorFilter}
      ORDER BY id
      LIMIT ${batchSize}
    `
    if (page.length === 0) break
    const ids = page.map((r) => r.id)

    const updated = await sql<{ id: string }[]>`
      WITH candidates AS (
        SELECT u.id, act.geom, act.created_at
        FROM users u
        JOIN LATERAL (
          SELECT p.geom, p.created_at FROM (
            SELECT r.geom, r.created_at FROM reports r
              WHERE r.reporter_user_id = u.id AND r.deleted_at IS NULL
            UNION ALL
            SELECT c.geom, c.created_at FROM cleanups c
              WHERE c.organizer_user_id = u.id
          ) p
          ORDER BY p.created_at DESC NULLS LAST
          LIMIT 1
        ) act ON TRUE
        WHERE u.id IN ${sql(ids)}
          AND act.created_at IS NOT NULL
      )
      UPDATE users u
      SET last_activity_geom = c.geom,
          last_activity_at = c.created_at
      FROM candidates c
      WHERE u.id = c.id
        AND (u.last_activity_at IS NULL OR u.last_activity_at < c.created_at)
      RETURNING u.id
    `

    scanned += page.length
    filled += updated.length
    cursor = page[page.length - 1]!.id
    log(`page of ${page.length} (filled ${updated.length}); running scanned=${scanned}, filled=${filled}`)
  }

  return { scanned, filled }
}
