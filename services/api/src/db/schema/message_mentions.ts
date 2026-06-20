/**
 * User @-mentions in messages: a user tagged by @handle in a per-report discussion message
 * (report_message_user_mentions) OR in a chat message — cleanup group chat + 1:1 DM
 * (chat_message_mentions, one table for both, message ids being globally-unique uuids).
 *
 * SEPARATE from the existing jurisdiction/city @mention (report_message_mentions, schema/discussion.ts),
 * which is keyed by geoid and forwards to the authority. These are keyed by the mentioned USER and drive
 * the mention notification (gated by blocks + prefs in the service).
 *
 * report_message_user_mentions FKs report_discussion_messages (a plain uuid PK) ON DELETE CASCADE, parallel
 * to report_message_reactions. chat_message_mentions has NO FK on message_id: chat_messages / dm_messages
 * are RANGE-partitioned with composite PK(id, created_at), so there is no single-column key to reference
 * (exactly like chat_message_reactions, schema/chat_reactions.ts). mentioned_user_id FKs users in both.
 *
 * CANONICAL DDL: drizzle/0023_message_mentions.sql. These mirrors exist for typed queries / diff
 * inspection only; they are NOT applied to create the database.
 */

import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core"
import { reportDiscussionMessages } from "./discussion.js"
import { users } from "./users.js"

/**
 * report_message_user_mentions: one user @-mentioned in one DISCUSSION message. Composite PK
 * (message_id, mentioned_user_id) de-dupes a user named twice. message_id cascades from the discussion
 * message; mentioned_user_id cascades from the user.
 */
export const reportMessageUserMentions = pgTable(
  "report_message_user_mentions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => reportDiscussionMessages.id, { onDelete: "cascade" }),
    mentionedUserId: uuid("mentioned_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.mentionedUserId] }),
    index("report_message_user_mentions_user_idx").on(t.mentionedUserId),
  ],
)

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

export type ReportMessageUserMentionRow = typeof reportMessageUserMentions.$inferSelect
export type NewReportMessageUserMentionRow = typeof reportMessageUserMentions.$inferInsert
export type ChatMessageMentionRow = typeof chatMessageMentions.$inferSelect
export type NewChatMessageMentionRow = typeof chatMessageMentions.$inferInsert
