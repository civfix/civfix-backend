import type { ConversationHideRoomKind } from "../db/schema/conversation_hides.js"

export interface ConversationHidesRepository {
  setHidden(
    userId: string,
    roomKind: ConversationHideRoomKind,
    roomId: string,
    hidden: boolean,
  ): Promise<void>
  hiddenAtFor(
    userId: string,
    roomKind: ConversationHideRoomKind,
    roomIds: string[],
  ): Promise<Map<string, Date>>
}
