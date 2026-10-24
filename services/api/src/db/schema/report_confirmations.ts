/**
 * A resident's vote on someone else's report: "I see this too" (kind 'seen', a confirmation) or "This is
 * fixed" (kind 'fixed'). The composite PK holds one vote per account per report; adding, moving and removing
 * a vote is a single INSERT ... ON CONFLICT or DELETE, and the denormalized reports.confirm_count and
 * reports.fixed_count are moved in the same transaction. No read lists the users behind a report's counts.
 */

import { sql } from "drizzle-orm"
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { reports } from "./reports.js"
import type { REPORT_VOTE_KIND_VALUES } from "./types.js"
import { users } from "./users.js"

export const reportConfirmations = pgTable(
  "report_confirmations",
  {
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** When the vote took its current kind: a move rewrites it. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").$type<(typeof REPORT_VOTE_KIND_VALUES)[number]>().notNull().default("seen"),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.userId] }),
    index("report_confirmations_user_created_idx").on(t.userId, t.createdAt),
    index("report_confirmations_report_created_idx").on(t.reportId, t.createdAt.desc()),
    check("report_confirmations_kind_check", sql`${t.kind} IN ('seen', 'fixed')`),
  ],
)

export type ReportConfirmationRow = typeof reportConfirmations.$inferSelect
export type NewReportConfirmationRow = typeof reportConfirmations.$inferInsert
