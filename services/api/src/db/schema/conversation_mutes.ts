/**
 * conversation_mutes: per-user, per-conversation mute. A user can mute notifications for a single
 * room (cleanup group chat, a DM thread, or a report chat) without leaving/muting globally.
 * room_kind + room_id together identify the room; room_id is plain `uuid` (NOT a foreign key)
 * because it points into whichever table room_kind selects (cleanups.id | dm_threads.id |
 * reports.id) -- app-level integrity, same reasoning as the no-FK message_id columns in
 * chat_message_reactions / chat_message_mentions / report_message_forwards.
 *
 * Composite PK(user_id, room_kind, room_id) means a user mutes a given room at most once.
 *
 * NOTE: @civfix/shared already exports a `RoomKind` type (ws-frame room kind: 'cleanup' | 'dm' |
 * 'report' | 'report_discussion') used by src/ws/*. This table's room_kind is a DIFFERENT,
 * backend-internal enumeration (mute targets only: no 'report_discussion') so it is named
 * `ConversationMuteRoomKind` here to avoid colliding with / being confused for the shared type.
 *
 * CANONICAL DDL: drizzle/0042_conversation_mutes.sql. This mirror exists for typed queries / diff
 * inspection only; nothing reads/writes it yet (mute repo lands in D-E1).
 */

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./users.js"

/** conversation_mutes.room_kind: which table room_id points into. */
export type ConversationMuteRoomKind = "cleanup" | "dm" | "report"

export const conversationMutes = pgTable(
  "conversation_mutes",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'cleanup' | 'dm' | 'report'. Kept as plain text (not a DB enum) since it only selects which
    // table room_id logically points into -- see header.
    roomKind: text("room_kind").$type<ConversationMuteRoomKind>().notNull(),
    // Points into cleanups.id | dm_threads.id | reports.id depending on room_kind. Intentionally
    // NOT a FK -- see header.
    roomId: uuid("room_id").notNull(),
    mutedAt: timestamp("muted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roomKind, t.roomId] })],
)

export type ConversationMuteRow = typeof conversationMutes.$inferSelect
export type NewConversationMuteRow = typeof conversationMutes.$inferInsert
