import type postgres from "postgres"
import type { Sql } from "./client.js"

type SqlFragment = postgres.Fragment

export const POST_GEOM_BACKFILL_BATCH = 1000

export async function backfillPostGeom(
  sql: Sql,
  opts: { batchSize?: number; log?: (message: string) => void } = {},
): Promise<{ scanned: number; filled: number }> {
  const batchSize = opts.batchSize ?? POST_GEOM_BACKFILL_BATCH
  const log = opts.log ?? ((message: string) => console.log(`backfill-post-geom: ${message}`))
  let scanned = 0
  let filled = 0
  let cursor: string | null = null

  for (;;) {
    const cursorFilter: SqlFragment = cursor === null ? sql`` : sql`AND id > ${cursor}`
    const page = await sql<{ id: string }[]>`
      SELECT id
      FROM posts
      WHERE geom IS NULL
        AND (report_id IS NOT NULL OR event_id IS NOT NULL)
        ${cursorFilter}
      ORDER BY id
      LIMIT ${batchSize}
    `
    if (page.length === 0) break
    const ids = page.map((r) => r.id)

    const updated = await sql<{ id: string }[]>`
      WITH candidates AS (
        SELECT s.id, COALESCE(r.geom, c.geom) AS geom
        FROM posts s
        LEFT JOIN reports r ON r.id = s.report_id
        LEFT JOIN cleanups c ON c.id = s.event_id
        WHERE s.id IN ${sql(ids)}
          AND s.geom IS NULL
      )
      UPDATE posts p
      SET geom = cand.geom
      FROM candidates cand
      WHERE p.id = cand.id
        AND p.geom IS NULL
        AND cand.geom IS NOT NULL
      RETURNING p.id
    `

    scanned += page.length
    filled += updated.length
    cursor = page[page.length - 1]!.id
    log(
      `page of ${page.length} (filled ${updated.length}); running scanned=${scanned}, filled=${filled}`,
    )
  }

  return { scanned, filled }
}
