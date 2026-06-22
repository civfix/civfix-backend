/**
 * report_timeline: append-only status history for a report (submitted -> held -> published -> ...).
 * Each row is one transition with an optional human note and the acting user (`actor_id` null for
 * system transitions). Deleting the report cascades. Indexed by (report_id, created_at) for the
 * ordered timeline render.
 */

import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { reports } from "./reports.js"
import { users } from "./users.js"
import type { REPORT_STATUS_VALUES } from "./types.js"

type ReportStatus = (typeof REPORT_STATUS_VALUES)[number]

export const reportTimeline = pgTable(
  "report_timeline",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    status: text("status").$type<ReportStatus>().notNull(),
    note: text("note"),
    // Issue #56 (D13): `note` stays the short collapsed preview; `kind` tags the entry type and `body`
    // carries the full (untruncated) inbound text. Both NULLABLE (0031); legacy rows have neither.
    kind: text("kind"),
    body: text("body"),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("report_timeline_report_idx").on(t.reportId, t.createdAt),
    // Partial index for the jurisdiction-directory last_routed_at subquery
    // (MAX(created_at) WHERE status = 'acknowledged'). Added in drizzle/0013_perf_indexes.sql.
    index("report_timeline_acknowledged_idx")
      .on(t.reportId, t.createdAt)
      .where(sql`status = 'acknowledged'`),
  ],
)

export type ReportTimelineRow = typeof reportTimeline.$inferSelect
export type NewReportTimelineRow = typeof reportTimeline.$inferInsert
