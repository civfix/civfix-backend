
import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { jurisdictions } from "./jurisdictions.js"
import { reports } from "./reports.js"
import { users } from "./users.js"

export const reportDiscussionMessages = pgTable(
  "report_discussion_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => reportDiscussionMessages.id, {
      onDelete: "cascade",
    }),
    authorUserId: uuid("author_user_id").references(() => users.id),
    body: text("body").notNull(),
    forwardedToCity: boolean("forwarded_to_city").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("report_discussion_messages_report_parent_created_idx").on(
      t.reportId,
      t.parentId,
      t.createdAt,
    ),
    index("report_discussion_messages_author_created_idx")
      .on(t.authorUserId, t.createdAt.desc())
      .where(sql`${t.authorUserId} is not null`),
  ],
)

export const reportMessageReactions = pgTable(
  "report_message_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => reportDiscussionMessages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index("report_message_reactions_user_idx").on(t.userId),
  ],
)

export const reportMessageMentions = pgTable(
  "report_message_mentions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => reportDiscussionMessages.id, { onDelete: "cascade" }),
    geoid: text("geoid")
      .notNull()
      .references(() => jurisdictions.geoid),
    forwardedAt: timestamp("forwarded_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.geoid] }),
    index("report_message_mentions_geoid_idx").on(t.geoid),
  ],
)

export type ReportDiscussionMessageRow = typeof reportDiscussionMessages.$inferSelect
export type NewReportDiscussionMessageRow = typeof reportDiscussionMessages.$inferInsert
export type ReportMessageReactionRow = typeof reportMessageReactions.$inferSelect
export type NewReportMessageReactionRow = typeof reportMessageReactions.$inferInsert
export type ReportMessageMentionRow = typeof reportMessageMentions.$inferSelect
export type NewReportMessageMentionRow = typeof reportMessageMentions.$inferInsert
