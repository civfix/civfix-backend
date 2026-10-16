/**
 * A resident's "Me too" on someone else's report. The composite PK makes the toggle a single
 * INSERT ... ON CONFLICT DO NOTHING or DELETE; the denormalized reports.confirm_count is moved in the same
 * transaction. No read lists the users behind a report's count.
 */

import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core"
import { reports } from "./reports.js"
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.userId] }),
    index("report_confirmations_user_created_idx").on(t.userId, t.createdAt),
  ],
)

export type ReportConfirmationRow = typeof reportConfirmations.$inferSelect
export type NewReportConfirmationRow = typeof reportConfirmations.$inferInsert
