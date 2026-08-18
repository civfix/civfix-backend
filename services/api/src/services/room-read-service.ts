
import type { RoomKind } from "@civfix/shared"
import type { ConversationBellKind } from "./conversation-bell.js"

export type AdvanceReadAt = (roomId: string, userId: string, at: Date) => Promise<void>

export type MarkRoomRead = (kind: RoomKind, roomId: string, userId: string) => Promise<void>

export interface RoomReadDeps {
  cleanup?: AdvanceReadAt
  dm?: AdvanceReadAt
  report?: AdvanceReadAt
  group?: AdvanceReadAt
  clearBell?: (kind: ConversationBellKind, roomId: string, userId: string) => Promise<void>
  now?: () => Date
}

export function makeMarkRoomRead(deps: RoomReadDeps): MarkRoomRead {
  const now = deps.now ?? (() => new Date())
  const advanceFor = (kind: RoomKind): AdvanceReadAt | undefined =>
    kind === "cleanup"
      ? deps.cleanup
      : kind === "dm"
        ? deps.dm
        : kind === "report"
          ? deps.report
          : deps.group

  return async (kind, roomId, userId) => {
    const advance = advanceFor(kind)
    if (advance) await advance(roomId, userId, now())
    if (deps.clearBell) await deps.clearBell(kind, roomId, userId)
  }
}
