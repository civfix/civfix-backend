/**
 * Event <-> report junction. UNIQUE(cleanup_id, report_id) makes a re-link a single ON CONFLICT DO
 * NOTHING. The event gallery scans by cleanup_id and the report's linked-events hydration by report_id,
 * hence both indexes.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { cleanups } from "./cleanups.js"
import { reports } from "./reports.js"
import { users } from "./users.js"

export const cleanupReports = pgTable(
  "cleanup_reports",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cleanupId: uuid("cleanup_id")
      .notNull()
      .references(() => cleanups.id, { onDelete: "cascade" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    // No cascade: the link survives a soft-deleted actor.
    linkedByUserId: uuid("linked_by_user_id").references(() => users.id),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("cleanup_reports_cleanup_id_report_id_key").on(t.cleanupId, t.reportId),
    index("cleanup_reports_cleanup_idx").on(t.cleanupId),
    index("cleanup_reports_report_idx").on(t.reportId),
  ],
)

export type CleanupReportRow = typeof cleanupReports.$inferSelect
export type NewCleanupReportRow = typeof cleanupReports.$inferInsert
