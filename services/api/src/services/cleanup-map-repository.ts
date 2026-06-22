import type { CleanupPinDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type { CleanupBBox } from "./cleanup-repository.types.js"
import { buildBboxFilter, buildWhenFilter } from "./cleanup-sql.js"

/** Max cleanup pins returned for a single bbox query. Bounds the payload for a wide bbox. */
export const MAP_CLEANUPS_LIMIT = 500

export interface CleanupMapRepository {
  listCleanupPins(bbox: CleanupBBox, when: "upcoming" | "past" | undefined): Promise<CleanupPinDTO[]>
}

/**
 * Lightweight map-pin reads for cleanups. Lives in the repository layer (not the route) so map.routes
 * only validates + delegates. Reuses the cleanup-sql.ts when/bbox fragments so the list + map feeds
 * agree on the time/status predicate.
 */
export function makeCleanupMapRepository(sql: Sql): CleanupMapRepository {
  return {
    async listCleanupPins(bbox, when): Promise<CleanupPinDTO[]> {
      const whenFilter = buildWhenFilter(sql, when)
      const bboxFilter = buildBboxFilter(sql, bbox)

      // The going count is a LATERAL aggregate (one grouped scan per matched cleanup) rather than a
      // correlated COUNT subquery in the SELECT list, so a wide bbox up to MAP_CLEANUPS_LIMIT doesn't
      // fire a per-pin subquery. COALESCE keeps zero-member cleanups at 0.
      const rows = await sql<
        {
          id: string
          lng: number
          lat: number
          scheduled_at: Date
          going: number
          event_kind: CleanupPinDTO["eventKind"]
        }[]
      >`
        SELECT
          c.id,
          ST_X(c.geom) AS lng,
          ST_Y(c.geom) AS lat,
          c.scheduled_at,
          c.event_kind,
          COALESCE(g.going, 0) AS going
        FROM cleanups c
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS going FROM cleanup_members m WHERE m.cleanup_id = c.id
        ) g ON true
        WHERE TRUE
          ${bboxFilter}
          ${whenFilter}
        ORDER BY c.scheduled_at ASC
        LIMIT ${MAP_CLEANUPS_LIMIT}
      `

      return rows.map((r) => ({
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        scheduledAt: r.scheduled_at.toISOString(),
        going: r.going,
        // The map branches the marker by kind (cleanup vs other_volunteer); carried per-pin (0018).
        eventKind: r.event_kind,
      }))
    },
  }
}
