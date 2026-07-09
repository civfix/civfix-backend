/**
 * report_chat_members: join table of users who have JOINED a report's group chat, with a
 * per-report role (owner|member). Mirrors cleanup_members (schema/cleanup_members.ts) but scoped
 * to a report instead of a cleanup. Composite PK(report_id, user_id) means a user joins a report's
 * chat at most once. Deleting the report cascades; deleting the user cascades (unlike
 * cleanup_members, which intentionally leaves the user FK non-cascading).
 *
 * CANONICAL DDL: drizzle/0041_report_chat_members.sql. This mirror exists for typed queries / diff
 * inspection only; nothing reads/writes it yet (membership repo lands in D-C1).
 */

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
    // Chat read watermark, same convention as cleanup_members.lastReadAt: NULL = never read;
    // unread baseline falls back to joined_at.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.userId] }),
    index("report_chat_members_user_idx").on(t.userId),
  ],
)

export type ReportChatMemberRow = typeof reportChatMembers.$inferSelect
export type NewReportChatMemberRow = typeof reportChatMembers.$inferInsert
