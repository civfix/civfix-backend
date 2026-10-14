/**
 * A poll is a chat message with kind='poll'; these tables hold its body, keyed on the message id.
 *
 * messageId is a bare uuid, not a .references() to chat_messages: Postgres cannot point an FK at a
 * partitioned parent. Message ids are globally unique, so keying on the bare id is safe.
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
  messageId: uuid("message_id").primaryKey(),
  question: text("question").notNull(),
  allowMultiple: boolean("allow_multiple").notNull().default(false),
  anonymous: boolean("anonymous").notNull().default(true),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // Non-cascading: accounts soft-delete, so this never blocks a deletion path; a tombstoned author
  // renders as "Deleted User". Vote rows, by contrast, cascade.
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
    // A vote can only point at an option that exists on its own poll.
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
