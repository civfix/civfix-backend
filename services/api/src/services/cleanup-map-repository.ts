import type { CleanupPinDTO } from "@civfix/shared"
import type { Sql } from "../db/client.js"
import type { CleanupBBox } from "./cleanup-repository.types.js"
import {
  buildBboxFilter,
  buildVisibilityFilter,
  buildWhenFilter,
  goingScalar,
} from "./cleanup-sql.js"

export const MAP_CLEANUPS_LIMIT = 500

export interface CleanupMapRepository {
  listCleanupPins(
    bbox: CleanupBBox,
    when: "upcoming" | "past" | undefined,
  ): Promise<CleanupPinDTO[]>
}

export function makeCleanupMapRepository(sql: Sql): CleanupMapRepository {
  return {
    async listCleanupPins(bbox, when): Promise<CleanupPinDTO[]> {
      const whenFilter = buildWhenFilter(sql, when ?? "upcoming")
      const bboxFilter = buildBboxFilter(sql, bbox)
      const visibilityFilter = buildVisibilityFilter(sql, null)

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
          ${goingScalar(sql)} AS going
        FROM cleanups c
        WHERE TRUE
          ${bboxFilter}
          ${whenFilter}
          ${visibilityFilter}
        ORDER BY c.scheduled_at ASC
        LIMIT ${MAP_CLEANUPS_LIMIT}
      `

      return rows.map((r) => ({
        id: r.id,
        lat: r.lat,
        lng: r.lng,
        scheduledAt: r.scheduled_at.toISOString(),
        going: r.going,
        eventKind: r.event_kind,
      }))
    },
  }
}
