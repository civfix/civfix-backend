/**
 * chat_polls + chat_poll_options + chat_poll_votes: P6 polls. A poll IS a chat message with
 * kind='poll'; this trio holds the poll body, keyed on the message's id. chat_polls is 1:1 with the
 * poll message, chat_poll_options is the ordered choice list (composite PK poll_id+idx), and
 * chat_poll_votes records one row per (poll, option, voter).
 *
 * messageId is a BARE uuid, NOT a Drizzle .references() to chat_messages — chat_messages is
 * PARTITIONED and an FK pointing AT the partitioned parent is impossible in postgres (same stance as
 * chat_message_reactions / chat pins). Message ids are globally unique so keying on the bare id is
 * safe. createdBy is a real users FK with no cascade (accounts soft-delete everywhere — same stance
 * as chat_groups.ownerId, schema/chat-groups.ts); vote rows, by contrast, DO cascade on user delete.
 *
 * CANONICAL DDL: drizzle/0048_chat_polls.sql. These mirrors exist for typed queries / diff
 * inspection; the poll repo + routes land in the following P6 tasks.
 */

import {
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const chatPolls = pgTable("chat_polls", {
  // Bare message id (the poll message's id). NOT an FK — see file header (partitioned parent).
  messageId: uuid("message_id").primaryKey(),
  question: text("question").notNull(),
  allowMultiple: boolean("allow_multiple").notNull().default(false),
  anonymous: boolean("anonymous").notNull().default(true),
  // NULL while the poll is open; set when the poll is closed to further voting.
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Non-cascading users FK, same stance as chat_groups.ownerId: accounts soft-delete everywhere, so
  // this can never block a deletion path; a tombstoned author renders as "Deleted User".
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const chatPollOptions = pgTable(
  "chat_poll_options",
  {
    pollId: uuid("poll_id")
      .notNull()
      .references(() => chatPolls.messageId, { onDelete: "cascade" }),
    idx: smallint("idx").notNull(),
    text: text("text").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.idx] })],
)

export const chatPollVotes = pgTable(
  "chat_poll_votes",
  {
    pollId: uuid("poll_id").notNull(),
    optionIdx: smallint("option_idx").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.pollId, t.optionIdx, t.userId] }),
    // Composite FK to the option row: a vote can only point at an option that exists on the poll;
    // deleting the option (or poll) cascades away the votes. Canonical in 0048_chat_polls.sql.
    foreignKey({
      columns: [t.pollId, t.optionIdx],
      foreignColumns: [chatPollOptions.pollId, chatPollOptions.idx],
    }).onDelete("cascade"),
    index("chat_poll_votes_user_idx").on(t.userId),
  ],
)

export type ChatPollRow = typeof chatPolls.$inferSelect
export type NewChatPollRow = typeof chatPolls.$inferInsert
export type ChatPollOptionRow = typeof chatPollOptions.$inferSelect
export type NewChatPollOptionRow = typeof chatPollOptions.$inferInsert
export type ChatPollVoteRow = typeof chatPollVotes.$inferSelect
export type NewChatPollVoteRow = typeof chatPollVotes.$inferInsert
