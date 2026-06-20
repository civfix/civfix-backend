/**
 * chat_message_reactions: lightweight emoji reactions on CHAT messages — both the cleanup group chat
 * (chat_messages) AND 1:1 direct messages (dm_messages). One table serves both because a message id is a
 * globally-unique uuid across both message tables.
 *
 * Mirrors report_message_reactions (schema/discussion.ts): composite PK (message_id, user_id, emoji) makes
 * a reaction idempotent and the toggle a single DELETE / INSERT. `emoji` is an ASCII reaction enum name
 * (REACTION_EMOJIS), never a raw glyph; the allowed set is enforced in the application layer.
 *
 * NO FK ON message_id: chat_messages / dm_messages are RANGE-partitioned with composite PK(id, created_at)
 * (0002_chat_partitioning.sql / 0009_dm_and_privacy.sql), so there is no single-column key to reference and
 * nothing else FKs into them either. App-level integrity holds. user_id DOES FK to users (a plain uuid PK).
 *
 * CANONICAL DDL: drizzle/0022_chat_reactions.sql. This mirror exists for typed queries / diff inspection
 * only; it is NOT applied to create the database.
 */

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const chatMessageReactions = pgTable(
  "chat_message_reactions",
  {
    // A chat_messages.id OR a dm_messages.id (uuids, globally unique). Intentionally NOT a FK — see header.
    messageId: uuid("message_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
)

export type ChatMessageReactionRow = typeof chatMessageReactions.$inferSelect
export type NewChatMessageReactionRow = typeof chatMessageReactions.$inferInsert
