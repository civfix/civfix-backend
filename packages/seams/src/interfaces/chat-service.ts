import type { RoomKind, ChatMessageDTO, ChatMessageKind, WsServerMessage } from "@civfix/contract"

export interface ChatConnection {
  readonly id: string
  send(data: string): void
}

export interface PersistChatInput {
  cleanupId: string
  roomKind?: RoomKind
  userId: string
  body: string
  kind?: ChatMessageKind
  clientId?: string
  attachments?: unknown[] | null
  mediaUploadIds?: string[]
  /** Id of the message this one replies to, in any room kind. */
  replyToId?: string
}

export interface ChatHistoryPage {
  items: ChatMessageDTO[]
  nextCursor: string | null
  /** Around-mode only: cursor toward NEWER messages; null/absent in plain before-mode pages. */
  prevCursor?: string | null
}

export interface ChatService {
  joinRoom(cleanupId: string, conn: ChatConnection, userId: string): Promise<void>
  leaveRoom(cleanupId: string, conn: ChatConnection): Promise<void>
  broadcast(cleanupId: string, msg: ChatMessageDTO): Promise<void>
  persist(input: PersistChatInput): Promise<ChatMessageDTO>
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    /** Around-mode: center the page on this message id; mutually exclusive with `before`. */
    around?: string,
  ): Promise<ChatHistoryPage>
  broadcastEvent?(
    cleanupId: string,
    frame: WsServerMessage,
    opts?: { excludeConnId?: string },
  ): Promise<void>
}
