import type { ConversationHideRoomKind } from "../db/schema/conversation_hides.js"
import type { ConversationHidesRepository } from "./conversation-hides-repository.js"

export function makeMemoryConversationHidesRepository(
  now: () => Date = () => new Date(),
): ConversationHidesRepository {
  const rows = new Map<string, Date>()
  const keyOf = (userId: string, roomKind: ConversationHideRoomKind, roomId: string): string =>
    `${userId}|${roomKind}|${roomId}`

  return {
    setHidden(
      userId: string,
      roomKind: ConversationHideRoomKind,
      roomId: string,
      hidden: boolean,
    ): Promise<void> {
      const key = keyOf(userId, roomKind, roomId)
      if (hidden) rows.set(key, now())
      else rows.delete(key)
      return Promise.resolve()
    },

    hiddenAtFor(
      userId: string,
      roomKind: ConversationHideRoomKind,
      roomIds: string[],
    ): Promise<Map<string, Date>> {
      const found = new Map<string, Date>()
      for (const roomId of roomIds) {
        const at = rows.get(keyOf(userId, roomKind, roomId))
        if (at !== undefined) found.set(roomId, at)
      }
      return Promise.resolve(found)
    },
  }
}

export async function visibleAfterHides<T>(
  hides: ConversationHidesRepository | undefined,
  userId: string,
  roomKind: ConversationHideRoomKind,
  rows: T[],
  roomIdOf: (row: T) => string,
  activityOf: (row: T) => number,
): Promise<T[]> {
  if (hides === undefined || rows.length === 0) return [...rows]
  const hiddenAt = await hides.hiddenAtFor(userId, roomKind, rows.map(roomIdOf))
  if (hiddenAt.size === 0) return [...rows]
  return rows.filter((row) => {
    const at = hiddenAt.get(roomIdOf(row))
    return at === undefined || activityOf(row) > at.getTime()
  })
}
