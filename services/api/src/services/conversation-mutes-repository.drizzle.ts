/**
 * Task D-E1: per-conversation mute store (conversation_mutes, migration 0042).
 *
 * A user may mute notifications for a single room (a cleanup group chat, a DM thread, or a report
 * chat) without leaving/muting globally. Composite PK(user_id, room_kind, room_id) means "muted" is
 * simply "a row exists" -- no separate boolean column. See src/db/schema/conversation_mutes.ts for the
 * full column rationale (in particular why room_id is NOT a foreign key).
 *
 * Written against the raw postgres-js tag (`Sql`) to match the rest of the backend (e.g.
 * report-chat-repository.drizzle.ts).
 */

import type { Sql } from "../db/client.js"
import type { ConversationMuteRoomKind } from "../db/schema/conversation_mutes.js"

export interface ConversationMutesRepository {
  /** Whether `userId` has muted this room. */
  isMuted(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): Promise<boolean>
  /**
   * Set the mute state for a room. `muted: true` upserts the mute row (idempotent: ON CONFLICT DO
   * NOTHING, so re-muting an already-muted room is a no-op rather than an error). `muted: false`
   * deletes the row (also idempotent: deleting an absent row is a no-op).
   */
  setMuted(
    userId: string,
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    muted: boolean,
  ): Promise<void>
  /**
   * Batch lookup for a threads list: of the given `roomIds` (all the same `roomKind`), which ones has
   * `userId` muted? Returns a Set for O(1) membership checks. Empty `roomIds` short-circuits to an
   * empty Set with NO query -- callers (e.g. rendering an empty threads page) should not pay for a
   * round trip that can only ever return nothing.
   */
  mutedRoomIdsFor(
    userId: string,
    roomKind: ConversationMuteRoomKind,
    roomIds: string[],
  ): Promise<Set<string>>
}

export function makeConversationMutesRepository(sql: Sql): ConversationMutesRepository {
  return {
    async isMuted(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): Promise<boolean> {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM conversation_mutes
          WHERE user_id = ${userId} AND room_kind = ${roomKind} AND room_id = ${roomId}
        ) AS exists
      `
      return rows[0]?.exists ?? false
    },

    async setMuted(
      userId: string,
      roomKind: ConversationMuteRoomKind,
      roomId: string,
      muted: boolean,
    ): Promise<void> {
      if (muted) {
        await sql`
          INSERT INTO conversation_mutes (user_id, room_kind, room_id)
          VALUES (${userId}, ${roomKind}, ${roomId})
          ON CONFLICT (user_id, room_kind, room_id) DO NOTHING
        `
      } else {
        await sql`
          DELETE FROM conversation_mutes
          WHERE user_id = ${userId} AND room_kind = ${roomKind} AND room_id = ${roomId}
        `
      }
    },

    async mutedRoomIdsFor(
      userId: string,
      roomKind: ConversationMuteRoomKind,
      roomIds: string[],
    ): Promise<Set<string>> {
      if (roomIds.length === 0) return new Set()
      const rows = await sql<{ room_id: string }[]>`
        SELECT room_id FROM conversation_mutes
        WHERE user_id = ${userId} AND room_kind = ${roomKind} AND room_id = ANY(${roomIds}::uuid[])
      `
      return new Set(rows.map((r) => r.room_id))
    },
  }
}
