/**
 * cleanup_reports: the event <-> report junction. One row = one report linked to one cleanup (event),
 * and the durable source of truth for that link (linked_by_user_id + linked_at). The event-detail
 * "Reports we'll handle" gallery scans by cleanup_id; the report-detail "Cleanup events" gallery (and the
 * batched ANY(report_id) hydration on ReportDTO.linkedEvents) scans by report_id.
 *
 * A report links to a cleanup at most once: UNIQUE(cleanup_id, report_id) makes a re-link a single
 * ON CONFLICT DO NOTHING. Deleting either the cleanup or the report cascades the junction row away;
 * linked_by_user_id has NO cascade (the link survives a soft-deleted actor). Mirrors the
 * cleanup_members composite-uniqueness + reverse-index pattern; canonical DDL: drizzle/0018.
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
    // The actor who made the link (nullable; no cascade so the link survives a soft-deleted actor).
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
