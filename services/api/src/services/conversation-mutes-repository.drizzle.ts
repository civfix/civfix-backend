// "Muted" means a row exists; there is no boolean column. src/db/schema/conversation_mutes.ts records
// why room_id is NOT a foreign key.

import type { FastifyBaseLogger } from "fastify"
import type { Sql } from "../db/client.js"
import type { ConversationMuteRoomKind } from "../db/schema/conversation_mutes.js"
import type { ConversationMutesRepository } from "./conversation-mutes-repository.js"

export type FailOpenMuteCheck = (
  userId: string,
  roomKind: ConversationMuteRoomKind,
  roomId: string,
) => Promise<boolean>

export function makeFailOpenMuteCheck(
  repo: Pick<ConversationMutesRepository, "isMuted"> | undefined,
  logger?: Pick<FastifyBaseLogger, "warn">,
): FailOpenMuteCheck {
  return async (userId, roomKind, roomId) => {
    if (!repo) return false
    try {
      return await repo.isMuted(userId, roomKind, roomId)
    } catch (err) {
      // A mute is a comfort setting: a lookup outage must not silence the room for everyone.
      logger?.warn({ err, kind: roomKind }, "conversation mute lookup failed; notifying anyway")
      return false
    }
  }
}

/**
 * Probed, never bound to an empty-Set default: the fan-out treats a present `mutedUserIdsFor` as
 * authoritative and skips the per-user `isMuted`, so a `new Set()` fallback would silently unmute the
 * whole room over a mutes store without the batch method.
 */
export function bindMutedUserIdsFor(
  repo: ConversationMutesRepository | undefined,
  roomKind: ConversationMuteRoomKind,
): ((roomId: string, userIds: string[]) => Promise<Set<string>>) | undefined {
  const batch = repo?.mutedUserIdsFor
  if (!repo || !batch) return undefined
  return (roomId, userIds) => batch.call(repo, roomKind, roomId, userIds)
}

export function makeConversationMutesRepository(sql: Sql): ConversationMutesRepository {
  return {
    async isMuted(
      userId: string,
      roomKind: ConversationMuteRoomKind,
      roomId: string,
    ): Promise<boolean> {
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

    async mutedUserIdsFor(
      roomKind: ConversationMuteRoomKind,
      roomId: string,
      userIds: string[],
    ): Promise<Set<string>> {
      if (userIds.length === 0) return new Set()
      const rows = await sql<{ user_id: string }[]>`
        SELECT user_id FROM conversation_mutes
        WHERE room_kind = ${roomKind} AND room_id = ${roomId} AND user_id = ANY(${userIds}::uuid[])
      `
      return new Set(rows.map((r) => r.user_id))
    },
  }
}
