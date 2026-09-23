import type { ChatMessageDTO, ChatMessageKind, ReactionEmoji } from "@civfix/shared"
import type { ChatHistoryPage } from "@civfix/shared/interfaces"
import type { TimeCursor } from "../db/cursor-helpers.js"

export interface DmThread {
  id: string
  userLo: string
  userHi: string
  createdAt: Date
}

export interface DmThreadAggregate {
  threadId: string
  createdAt: Date
  peer: {
    id: string
    displayName: string
    handle: string | null
    bio: string | null
    avatarUrl: string | null
    deleted: boolean
  }
  last: {
    body: string | null
    createdAt: Date
    senderId: string
  } | null
  unread: number
}

export interface DmPersistInput {
  threadId: string
  senderId: string
  body: string
  kind?: ChatMessageKind
  clientId?: string
  attachments?: unknown[] | null
  mediaUploadIds?: string[]
  replyToId?: string
}

export interface DmMessageMeta {
  id: string
  threadId: string
  senderId: string
  kind: ChatMessageKind
  createdAt: Date
  deletedAt: Date | null
}

export interface DmRepository {
  openOrCreateThread(userA: string, userB: string): Promise<DmThread>
  getThreadForPair(userA: string, userB: string): Promise<DmThread | null>
  getThread(threadId: string): Promise<DmThread | null>
  isParticipant(threadId: string, userId: string): Promise<boolean>
  persist(input: DmPersistInput): Promise<ChatMessageDTO>
  editMessage(
    threadId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  findMessageMeta(messageId: string): Promise<DmMessageMeta | null>
  softDelete(threadId: string, messageId: string, senderId: string): Promise<ChatMessageDTO | null>
  setPinned(
    threadId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  listPins(threadId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  history(
    threadId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findMessage(
    threadId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  markRead(threadId: string, userId: string, at: Date): Promise<void>
  lastReadAt(threadId: string, userId: string): Promise<Date | null>
  countUnread(threadId: string, userId: string): Promise<number>
  resolveMessageCreatedAt(threadId: string, messageId: string): Promise<Date | null>
  listThreadsForUser(
    userId: string,
    limit?: number,
    cursor?: TimeCursor | null,
  ): Promise<DmThreadAggregate[]>
}
