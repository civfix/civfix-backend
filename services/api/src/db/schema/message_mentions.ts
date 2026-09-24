import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

/**
 * One user @-mentioned in one chat message, across every chat kind: message ids are globally unique
 * uuids, so one table serves chat_messages and dm_messages. There is no FK on message_id because those
 * tables are range-partitioned with composite PK(id, created_at), leaving no single-column key to
 * reference; integrity is app-level.
 */
export const chatMessageMentions = pgTable(
  "chat_message_mentions",
  {
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
