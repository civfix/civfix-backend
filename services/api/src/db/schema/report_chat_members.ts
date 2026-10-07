import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { reports } from "./reports.js"
import { users } from "./users.js"
import type { REPORT_CHAT_ROLE_VALUES } from "./types.js"

type ReportChatRole = (typeof REPORT_CHAT_ROLE_VALUES)[number]

export const reportChatMembers = pgTable(
  "report_chat_members",
  {
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<ReportChatRole>().notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    // NULL = never read; the unread baseline falls back to joined_at.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.userId] }),
    index("report_chat_members_user_idx").on(t.userId),
  ],
)

export type ReportChatMemberRow = typeof reportChatMembers.$inferSelect
export type NewReportChatMemberRow = typeof reportChatMembers.$inferInsert
