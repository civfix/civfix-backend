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
    // `note` stays the short collapsed preview while `body` carries the full inbound text; legacy rows
    // have neither kind nor body.
    kind: text("kind"),
    body: text("body"),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("report_timeline_report_idx").on(t.reportId, t.createdAt),
    // Backs the jurisdiction-directory last_routed_at subquery.
    index("report_timeline_acknowledged_idx")
      .on(t.reportId, t.createdAt)
      .where(sql`status = 'acknowledged'`),
  ],
)

export type ReportTimelineRow = typeof reportTimeline.$inferSelect
export type NewReportTimelineRow = typeof reportTimeline.$inferInsert
