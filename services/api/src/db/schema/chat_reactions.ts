
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export const chatMessageReactions = pgTable(
  "chat_message_reactions",
  {
    messageId: uuid("message_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index("chat_message_reactions_user_idx").on(t.userId),
  ],
)

export type ChatMessageReactionRow = typeof chatMessageReactions.$inferSelect
export type NewChatMessageReactionRow = typeof chatMessageReactions.$inferInsert
