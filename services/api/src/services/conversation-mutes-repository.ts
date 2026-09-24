import type { ConversationMuteRoomKind } from "../db/schema/conversation_mutes.js"

export interface ConversationMutesRepository {
  isMuted(userId: string, roomKind: ConversationMuteRoomKind, roomId: string): Promise<boolean>
  /** Idempotent both ways: re-muting and unmuting an unmuted room are no-ops, not errors. */
  setMuted(
    userId: string,
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    muted: boolean,
  ): Promise<void>
  mutedRoomIdsFor(
    userId: string,
    roomKind: ConversationMuteRoomKind,
    roomIds: string[],
  ): Promise<Set<string>>
  /**
   * Optional so the offline fakes that predate it still satisfy the interface; callers must probe
   * (`repo.mutedUserIdsFor?.(...)`) and fall back to the per-user `isMuted`.
   */
  mutedUserIdsFor?(
    roomKind: ConversationMuteRoomKind,
    roomId: string,
    userIds: string[],
  ): Promise<Set<string>>
}
