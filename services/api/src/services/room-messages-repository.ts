import type { ChatMessageDTO } from "@civfix/contract"
import type { ChatHistoryPage } from "@civfix/seams"

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
