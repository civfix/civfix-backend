import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { ConversationMuteRoomKind } from "./conversation_mutes.js"
import { users } from "./users.js"

export type ConversationHideRoomKind = ConversationMuteRoomKind

export const conversationHides = pgTable(
  "conversation_hides",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomKind: text("room_kind").$type<ConversationHideRoomKind>().notNull(),
    roomId: uuid("room_id").notNull(),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roomKind, t.roomId] })],
)

export type ConversationHideRow = typeof conversationHides.$inferSelect
export type NewConversationHideRow = typeof conversationHides.$inferInsert
