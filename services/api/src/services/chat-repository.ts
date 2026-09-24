import type { ChatMessageDTO, ChatMessageKind, ReactionEmoji } from "@civfix/shared"
import type { ChatHistoryPage, PersistChatInput } from "@civfix/shared/interfaces"
import type { Queryable } from "../db/client.js"

export interface ChatMessageMeta {
  id: string
  cleanupId: string | null
  reportId: string | null
  groupId: string | null
  senderId: string | null
  kind: ChatMessageKind
  createdAt: Date
  deletedAt: Date | null
}

export interface InsertedChatRow {
  id: string
  createdAt: Date
}

export interface InsertMessageOptions {
  inTx?: (tx: Queryable, row: InsertedChatRow) => Promise<void>
}

export interface ChatRepository {
  insertMessage(
    input: PersistChatInput,
    id: string,
    options?: InsertMessageOptions,
  ): Promise<ChatMessageDTO>
  findMessageMeta(messageId: string): Promise<ChatMessageMeta | null>
  history(
    cleanupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findMessage(
    cleanupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  toggleReaction(messageId: string, userId: string, emoji: ReactionEmoji): Promise<boolean>
  editMessage(
    cleanupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  softDelete(
    cleanupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  setPinned(
    cleanupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  setReportPinned(
    reportId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  listPins(cleanupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  listReportPins(reportId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
  reportHistory(
    reportId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findReportMessage(
    reportId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  editReportMessage(
    reportId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  softDeleteReport(
    reportId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  countReportMessages(reportId: string): Promise<number>
  groupHistory(
    groupId: string,
    before: string | undefined,
    limit: number,
    viewerUserId?: string | null,
    around?: string,
  ): Promise<ChatHistoryPage>
  findGroupMessage(
    groupId: string,
    messageId: string,
    viewerUserId: string | null,
  ): Promise<ChatMessageDTO | null>
  editGroupMessage(
    groupId: string,
    messageId: string,
    senderId: string,
    body: string,
  ): Promise<ChatMessageDTO | null>
  softDeleteGroup(
    groupId: string,
    messageId: string,
    senderId: string,
    opts?: SoftDeleteOpts,
  ): Promise<ChatMessageDTO | null>
  setGroupPinned(
    groupId: string,
    messageId: string,
    userId: string,
    pinned: boolean,
  ): Promise<ChatMessageDTO | null>
  listGroupPins(groupId: string, viewerUserId: string | null): Promise<ChatMessageDTO[]>
}

export interface SoftDeleteOpts {
  bypassSenderGate?: boolean
}
