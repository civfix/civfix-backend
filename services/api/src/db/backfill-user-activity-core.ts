
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
