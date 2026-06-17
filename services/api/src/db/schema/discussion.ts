/**
 * report discussion: the per-report public comment thread, its lightweight emoji reactions, and the
 * jurisdiction/city @mentions a message can carry (and optionally forward to the authority).
 *
 * DELIBERATELY NON-PARTITIONED, plain uuid PK tables (unlike chat_messages, which is RANGE-partitioned
 * with a composite PK so it is intentionally NOT copied here). Comment volume per report is bounded and
 * the reaction/reply foreign keys must point at a single column, so a flat uuid PK keeps the child FKs
 * trivial: `report_discussion_messages.parent_id` self-references for one level of replies, and the
 * reaction/mention tables use composite PKs to de-dupe.
 *
 * CANONICAL DDL: drizzle/0017_report_discussion.sql. These mirrors exist for typed queries / diff
 * inspection only; they are NOT applied to create the database.
 */

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

/**
 * report_discussion_messages: one comment, or one reply (when `parentId` is set). `authorUserId` is
 * NULL for system-authored entries; `deletedAt` is a soft-delete tombstone (kept so reply subtrees +
 * reaction counts survive moderation). The DB enforces the self-reference + cascades; see the SQL.
 */
export const reportDiscussionMessages = pgTable(
  "report_discussion_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    // Self-reference: NULL = top-level comment, non-NULL = reply. Cascade removes a subtree. The
    // thunk resolves lazily, so referencing the table being declared is safe (no TDZ).
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
    // Thread render + reply pagination, matching report_discussion_messages_report_parent_created_idx.
    index("report_discussion_messages_report_parent_created_idx").on(
      t.reportId,
      t.parentId,
      t.createdAt,
    ),
  ],
)

/**
 * report_message_reactions: one user's one emoji on one message. Composite PK (message, user, emoji)
 * makes a reaction idempotent and the toggle a single DELETE / INSERT. `emoji` is an ASCII reaction
 * enum name (REACTION_EMOJIS), never a raw glyph; the allowed set is enforced in the application layer.
 */
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
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
)

/**
 * report_message_mentions: a jurisdiction/city @mentioned in a message. Composite PK (message, geoid)
 * de-dupes a geoid mentioned twice. `forwardedAt` stamps when the mention was relayed (NULL = not yet).
 */
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
  (t) => [primaryKey({ columns: [t.messageId, t.geoid] })],
)

export type ReportDiscussionMessageRow = typeof reportDiscussionMessages.$inferSelect
export type NewReportDiscussionMessageRow = typeof reportDiscussionMessages.$inferInsert
export type ReportMessageReactionRow = typeof reportMessageReactions.$inferSelect
export type NewReportMessageReactionRow = typeof reportMessageReactions.$inferInsert
export type ReportMessageMentionRow = typeof reportMessageMentions.$inferSelect
export type NewReportMessageMentionRow = typeof reportMessageMentions.$inferInsert
