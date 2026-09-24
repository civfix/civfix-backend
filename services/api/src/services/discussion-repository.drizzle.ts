// The only read left from the retired discussion system (report chat replaced it); it backs report-chat
// visibility and the @city forward.

import type { Sql } from "../db/client.js"
import { firstUsableLegacyContactExpr, usableContactRowExpr } from "./admin/sql-fragments.js"
import type {
  DiscussionReportView,
  DiscussionRepository,
  ReportJurisdictionView,
} from "./discussion-types.js"
import type { ReportCategory } from "@civfix/shared"

export function makeDrizzleDiscussionRepository(sql: Sql): DiscussionRepository {
  return {
    async findReportForDiscussion(reportId: string): Promise<DiscussionReportView | null> {
      // Same contact precedence and bounce rule as admin getRouting, so a city forward never goes to an
      // address the admin screen already reports as unusable.
      const rows = await sql<
        {
          id: string
          reporter_user_id: string | null
          status: string
          visibility: string
          deleted_at: Date | null
          category: ReportCategory
          place: string | null
          geoid: string | null
          j_name: string | null
          j_handle: string | null
          cat_email: string | null
          default_email: string | null
          legacy_email: string | null
        }[]
      >`
        SELECT
          r.id,
          r.reporter_user_id,
          r.status,
          r.visibility,
          r.deleted_at,
          r.category,
          r.addr AS place,
          j.geoid,
          j.name AS j_name,
          j.handle AS j_handle,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category = r.category
               AND ${usableContactRowExpr(sql, "jc")} LIMIT 1) AS cat_email,
          (SELECT jc.email FROM jurisdiction_contacts jc
             WHERE jc.geoid = j.geoid AND jc.category IS NULL
               AND ${usableContactRowExpr(sql, "jc")} LIMIT 1) AS default_email,
          ${firstUsableLegacyContactExpr(sql, "j")} AS legacy_email
        FROM reports r
        LEFT JOIN jurisdictions j ON j.geoid = r.jurisdiction_geoid
        WHERE r.id = ${reportId}
        LIMIT 1
      `
      const row = rows[0]
      if (!row) return null
      const jurisdiction: ReportJurisdictionView | null =
        row.geoid !== null
          ? {
              geoid: row.geoid,
              name: row.j_name ?? row.geoid,
              handle: row.j_handle,
              contactEmail: row.cat_email ?? row.default_email ?? row.legacy_email ?? null,
            }
          : null
      return {
        id: row.id,
        reporterUserId: row.reporter_user_id,
        status: row.status,
        visibility: row.visibility,
        deletedAt: row.deleted_at,
        jurisdiction,
        category: row.category,
        place: row.place,
      }
    },
  }
}
