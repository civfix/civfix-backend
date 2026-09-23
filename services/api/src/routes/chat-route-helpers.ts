import { AppError, type ChatHistoryResponse, type ChatMessageDTO } from "@civfix/shared"
import type { ChatHistoryPage, ChatService } from "@civfix/shared/interfaces"
import { broadcastMessageUpdate, roomKeyFor } from "../ws/gateway.js"
import type { ChatMessageMeta, SoftDeleteOpts } from "../services/chat-repository.js"
import type { ResolveChatPowers } from "../services/chat-room-roles.js"
import { neutralizeChatViewerFields } from "../services/chat-viewer-fields.js"
import { clampPageLimit } from "../lib/page-limit.js"

export { neutralizeChatViewerFields }

export type ChatRoomKind = "cleanup" | "report" | "group"

export const DELETE_MESSAGE_FORBIDDEN = "You can't delete this message."
export const MESSAGE_ALREADY_DELETED = "This message was already deleted."
export const REPORT_NOT_FOUND = "Report not found"

const CHAT_HISTORY_DEFAULT_LIMIT = 30
const CHAT_HISTORY_MAX_LIMIT = 50

export function clampChatHistoryLimit(requested: number | undefined): number {
  return clampPageLimit(requested, CHAT_HISTORY_DEFAULT_LIMIT, CHAT_HISTORY_MAX_LIMIT)
}

export interface ChatHistorySource {
  history(
    before: string | undefined,
    limit: number,
    around: string | undefined,
  ): Promise<ChatHistoryPage>
  listPins?: () => Promise<ChatMessageDTO[]>
}

export async function chatHistoryPayload(
  source: ChatHistorySource,
  q: { before?: string | undefined; around?: string | undefined },
  limit: number,
): Promise<ChatHistoryResponse> {
  const isInitialPage = q.before === undefined && q.around === undefined
  const listPins = isInitialPage ? source.listPins : undefined
  const [page, pins] = await Promise.all([
    source.history(q.before, limit, q.around),
    listPins ? listPins() : Promise.resolve(undefined),
  ])
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    ...(page.prevCursor !== undefined ? { prevCursor: page.prevCursor } : {}),
    ...(pins !== undefined ? { pins } : {}),
  }
}

export function messageRoomMatches(
  meta: ChatMessageMeta | null,
  roomKind: ChatRoomKind,
  roomId: string,
): meta is ChatMessageMeta {
  if (meta === null) return false
  return roomKind === "report"
    ? meta.reportId === roomId
    : roomKind === "group"
      ? meta.groupId === roomId
      : meta.cleanupId === roomId
}

export interface DeleteMessageWithPowersInput {
  roomKind: ChatRoomKind
  roomId: string
  messageId: string
  userId: string
  senderPath: boolean
  softDelete(opts?: SoftDeleteOpts): Promise<ChatMessageDTO | null>
  findMessageMeta(messageId: string): Promise<ChatMessageMeta | null>
  resolveChatPowers: ResolveChatPowers
  chat: ChatService
  legacyBroadcast: boolean
}

export async function deleteMessageWithPowers(
  input: DeleteMessageWithPowersInput,
): Promise<ChatMessageDTO> {
  const { roomKind, roomId, messageId, userId } = input

  const stateInRoom = async (): Promise<ChatMessageMeta | null> => {
    const meta = await input.findMessageMeta(messageId)
    return messageRoomMatches(meta, roomKind, roomId) ? meta : null
  }

  let tombstone: ChatMessageDTO | null = input.senderPath ? await input.softDelete() : null
  if (tombstone === null) {
    const state = input.senderPath ? await stateInRoom() : null
    if (state !== null && state.deletedAt !== null && state.senderId === userId) {
      throw AppError.conflict(MESSAGE_ALREADY_DELETED)
    }
    const powers = await input.resolveChatPowers({ roomKind, roomId, userId })
    if (!powers.canDeleteOthers) throw AppError.forbidden(DELETE_MESSAGE_FORBIDDEN)
    const current = state ?? (await stateInRoom())
    if (current !== null && current.deletedAt !== null) {
      throw AppError.conflict(MESSAGE_ALREADY_DELETED)
    }
    tombstone = await input.softDelete({ bypassSenderGate: true })
    if (tombstone === null) throw AppError.forbidden(DELETE_MESSAGE_FORBIDDEN)
  }

  const roomView = neutralizeChatViewerFields(tombstone)
  if (input.legacyBroadcast) {
    void Promise.resolve(input.chat.broadcast(roomKeyFor(roomKind, roomId), roomView)).catch(
      () => {},
    )
  }
  broadcastMessageUpdate(input.chat, roomKind, roomId, roomView)
  return tombstone
}
