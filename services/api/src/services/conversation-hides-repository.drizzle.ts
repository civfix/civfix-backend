import type { Sql } from "../db/client.js"
import type { ConversationHideRoomKind } from "../db/schema/conversation_hides.js"
import type { ConversationHidesRepository } from "./conversation-hides-repository.js"

export function makeConversationHidesRepository(sql: Sql): ConversationHidesRepository {
  return {
    async setHidden(
      userId: string,
      roomKind: ConversationHideRoomKind,
      roomId: string,
      hidden: boolean,
    ): Promise<void> {
      if (hidden) {
        await sql`
          INSERT INTO conversation_hides (user_id, room_kind, room_id, hidden_at)
          VALUES (${userId}, ${roomKind}, ${roomId}, now())
          ON CONFLICT (user_id, room_kind, room_id) DO UPDATE SET hidden_at = now()
        `
      } else {
        await sql`
          DELETE FROM conversation_hides
          WHERE user_id = ${userId} AND room_kind = ${roomKind} AND room_id = ${roomId}
        `
      }
    },

    async hiddenAtFor(
      userId: string,
      roomKind: ConversationHideRoomKind,
      roomIds: string[],
    ): Promise<Map<string, Date>> {
      if (roomIds.length === 0) return new Map()
      const rows = await sql<{ room_id: string; hidden_at: Date }[]>`
        SELECT room_id, hidden_at FROM conversation_hides
        WHERE user_id = ${userId} AND room_kind = ${roomKind} AND room_id = ANY(${roomIds}::uuid[])
      `
      return new Map(rows.map((r) => [r.room_id, r.hidden_at]))
    },
  }
}
