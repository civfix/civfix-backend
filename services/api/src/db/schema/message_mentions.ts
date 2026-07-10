/**
 * User @-mentions in a chat message — cleanup group chat + 1:1 DM + report chat (chat_message_mentions,
 * one table for all, message ids being globally-unique uuids). These are keyed by the mentioned USER and
 * drive the mention notification (gated by blocks + prefs in the service).
 *
 * (The former report_message_user_mentions table — user @-mentions in a per-report DISCUSSION message —
 * was dropped with the discussion system, 0044_drop_report_discussion.sql.)
 *
 * chat_message_mentions has NO FK on message_id: chat_messages / dm_messages are RANGE-partitioned with
 * composite PK(id, created_at), so there is no single-column key to reference (exactly like
 * chat_message_reactions, schema/chat_reactions.ts). mentioned_user_id FKs users.
 *
 * CANONICAL DDL: drizzle/0023_message_mentions.sql. This mirror exists for typed queries / diff
 * inspection only; it is NOT applied to create the database.
 */

import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

/**
 * chat_message_mentions: one user @-mentioned in one CHAT message — the cleanup group chat (chat_messages)
 * OR a 1:1 DM (dm_messages). One table serves both because a message id is a globally-unique uuid across
 * both message tables. NO FK on message_id (those tables are partitioned with composite PKs); app-level
 * integrity holds. mentioned_user_id DOES FK to users.
 */
export const chatMessageMentions = pgTable(
  "chat_message_mentions",
  {
    // A chat_messages.id OR a dm_messages.id (uuids, globally unique). Intentionally NOT a FK — see header.
    messageId: uuid("message_id").notNull(),
    mentionedUserId: uuid("mentioned_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.mentionedUserId] }),
    index("chat_message_mentions_user_idx").on(t.mentionedUserId),
  ],
)

export type ChatMessageMentionRow = typeof chatMessageMentions.$inferSelect
export type NewChatMessageMentionRow = typeof chatMessageMentions.$inferInsert
