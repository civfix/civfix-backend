import type { ChatMessageDTO } from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"

export interface RoomMessagesRepository {
  history(
    before: string | undefined,
    limit: number,
    viewerUserId: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  historyAround(
    around: string,
    limit: number,
    viewerUserId: string | null,
  ): Promise<ChatHistoryPage>
  findMessage(messageId: string, viewerUserId: string | null): Promise<ChatMessageDTO | null>
  setPinned(messageId: string, userId: string, pinned: boolean): Promise<ChatMessageDTO | null>
  listPins(viewerUserId: string | null): Promise<ChatMessageDTO[]>
}
