/**
 * Per-user, per-conversation mute. room_id is a plain uuid, not a foreign key, because it points into
 * whichever table room_kind selects (cleanups | dm_threads | reports | chat_groups); integrity is
 * app-level, like the no-FK message_id columns elsewhere.
 *
 * room_kind is deliberately not the shared `RoomKind` (the ws-frame kind, which includes
 * 'report_discussion'): mute targets are a different, backend-internal set, hence the distinct name.
 */

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

export type ConversationMuteRoomKind = "cleanup" | "dm" | "report" | "group"

export const conversationMutes = pgTable(
  "conversation_mutes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roomKind: text("room_kind").$type<ConversationMuteRoomKind>().notNull(),
    roomId: uuid("room_id").notNull(),
    mutedAt: timestamp("muted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roomKind, t.roomId] })],
)

export type ConversationMuteRow = typeof conversationMutes.$inferSelect
export type NewConversationMuteRow = typeof conversationMutes.$inferInsert
