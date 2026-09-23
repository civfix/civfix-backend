/**
 * The room-send permission check (the same one the WS send path runs) comes BEFORE the message lookup,
 * so a non-member probing leaked UUIDs gets the same generic 403 whether or not the message exists,
 * belongs to the room, is deleted, or is a system row. A sender-less SYSTEM row skips the sender gate
 * and fails the kind gate instead (422): "not your message" would mislead for a message nobody wrote.
 *
 * The machine subcodes ride AppError's `fields` ({ code: "..." }) because ErrorCode is a closed enum;
 * clients key off httpStatus + fields.code.
 */
import { AppError, EDIT_WINDOW_HOURS, ErrorCode } from "@civfix/shared"
import type { ChatMessageDTO, ChatMessageKind, RoomKind, WsServerMessage } from "@civfix/shared"
import { assertNoSlur } from "../abuse/slur-filter.js"
import { parseUserMentions } from "./discussion-mentions.js"
import { broadcastMessageUpdate } from "../ws/frame-handler.js"
import { neutralizeChatViewerFields } from "./chat-viewer-fields.js"
import type { GatewayChatMentions } from "../ws/types.js"
import type { ChatMessageMeta, ChatRepository } from "./chat-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"
import { MS_PER_HOUR } from "../lib/time.js"

const CHAT_EDIT_FORBIDDEN = "You can't edit this message."

const MESSAGE_DELETED = "This message was deleted."

const EDIT_WINDOW_MS = EDIT_WINDOW_HOURS * MS_PER_HOUR

const EDIT_ERROR_CODE = {
  notSender: "not_sender",
  editWindowExpired: "edit_window_expired",
} as const

export type IsRoomMemberFn = (roomId: string, userId: string) => Promise<boolean>

export interface ChatEditServiceDeps {
  chat?: ChatRepository
  dm?: DmRepository
  isCleanupMember?: IsRoomMemberFn
  isReportMember?: IsRoomMemberFn
  /**
   * Runs before the membership gate so an unlisted, held or soft-deleted report answers 404 like
   * report-chat.routes' requireVisibleReport. A membership row survives a report being held, so
   * membership alone is not the visibility gate; when this is absent the route's own pre-gate is the
   * only one.
   */
  isReportVisible?: (reportId: string, userId: string) => Promise<boolean>
  isGroupMember?: IsRoomMemberFn
  dmPeerOf?: (threadId: string, userId: string) => Promise<string | null>
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
  /** notifyChatMention is deliberately excluded: editing a message never re-fires mention bells. */
  chatMentions?: Pick<GatewayChatMentions, "resolveChatMentions" | "recordChatMentions" | "logger">
  /** Best-effort: a failure never fails the edit. */
  broadcastEvent?: (roomKey: string, frame: WsServerMessage) => Promise<void> | void
}

export interface EditMessageInput {
  roomKind: RoomKind
  roomId: string
  messageId: string
  userId: string
  body: string
  mentionedUserIds?: string[] | undefined
}

export interface ChatEditService {
  editMessage(input: EditMessageInput): Promise<ChatMessageDTO>
}

const notSender = () =>
  new AppError(ErrorCode.FORBIDDEN, CHAT_EDIT_FORBIDDEN, {
    fields: { code: EDIT_ERROR_CODE.notSender },
  })

const editWindowExpired = () =>
  new AppError(ErrorCode.FORBIDDEN, "This message can no longer be edited.", {
    fields: { code: EDIT_ERROR_CODE.editWindowExpired },
  })

function assertEditable(
  meta: { senderId: string | null; kind: ChatMessageKind; createdAt: Date; deletedAt: Date | null },
  userId: string,
): void {
  if (meta.senderId !== null && meta.senderId !== userId) throw notSender()
  if (meta.deletedAt !== null) throw AppError.conflict(MESSAGE_DELETED)
  // A sender-less SYSTEM row lands here too (kind "system"), so it 422s rather than 403s.
  if (meta.kind !== "text") {
    throw AppError.validation({ kind: "Only text messages can be edited." })
  }
  if (Date.now() - meta.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw editWindowExpired()
  }
}

function roomRefOf(
  meta: Pick<ChatMessageMeta, "cleanupId" | "reportId" | "groupId">,
  roomKind: RoomKind,
): string | null {
  if (roomKind === "report") return meta.reportId
  if (roomKind === "group") return meta.groupId
  return meta.cleanupId
}

function editInRoom(
  chat: ChatRepository,
  roomKind: RoomKind,
  roomId: string,
  messageId: string,
  userId: string,
  body: string,
): Promise<ChatMessageDTO | null> {
  if (roomKind === "report") return chat.editReportMessage(roomId, messageId, userId, body)
  if (roomKind === "group") return chat.editGroupMessage(roomId, messageId, userId, body)
  return chat.editMessage(roomId, messageId, userId, body)
}

export function makeChatEditService(deps: ChatEditServiceDeps): ChatEditService {
  async function rerecordMentions(
    kind: RoomKind,
    roomId: string,
    userId: string,
    messageId: string,
    body: string,
    mentionedUserIds: string[] | undefined,
  ): Promise<void> {
    const mentions = deps.chatMentions
    if (!mentions) return
    try {
      const resolved = await mentions.resolveChatMentions({
        handles: parseUserMentions(body),
        userIds: mentionedUserIds ?? [],
        authorUserId: userId,
        kind,
        roomId,
      })
      // Record even an EMPTY set: an edit that drops an @mention must clear the stale record.
      await mentions.recordChatMentions(
        messageId,
        resolved.map((m) => m.id),
      )
    } catch (err) {
      mentions.logger?.warn(
        { err, messageId, kind, roomId },
        "chat mentions could not be re-recorded on edit; keeping the edit",
      )
    }
  }

  function fireMessageUpdate(roomKind: RoomKind, roomId: string, message: ChatMessageDTO): void {
    broadcastMessageUpdate(
      { broadcastEvent: deps.broadcastEvent },
      roomKind,
      roomId,
      neutralizeChatViewerFields(message),
    )
  }

  async function editDmMessage(input: EditMessageInput): Promise<ChatMessageDTO> {
    const { roomId, messageId, userId, body } = input
    const dm = deps.dm
    const dmPeerOf = deps.dmPeerOf
    const isBlockedEitherWay = deps.isBlockedEitherWay
    if (!dm || !dmPeerOf || !isBlockedEitherWay) {
      throw new Error("chat-edit-service: dm deps not wired")
    }
    const peer = await dmPeerOf(roomId, userId)
    if (peer === null) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    if (await isBlockedEitherWay(userId, peer)) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    const meta = await dm.findMessageMeta(messageId)
    if (meta === null || meta.threadId !== roomId) throw AppError.notFound("Message not found")
    assertEditable(meta, userId)
    assertNoSlur(body, "body")

    // Mentions are recorded before the sender-gated edit so the re-read DTO already carries them. If
    // the row is tombstoned underneath us the edit no-ops (409) and the residue sits on a deleted
    // message no reader ever hydrates.
    await rerecordMentions("dm", roomId, userId, messageId, body, input.mentionedUserIds)
    const updated = await dm.editMessage(roomId, messageId, userId, body)
    if (updated === null) throw AppError.conflict(MESSAGE_DELETED)
    fireMessageUpdate("dm", roomId, updated)
    return updated
  }

  async function requireReportMember(reportId: string, userId: string): Promise<void> {
    // Visibility first, so a held or unlisted report answers 404 rather than leaking a 403 keyed on a
    // stale membership row.
    if (deps.isReportVisible && !(await deps.isReportVisible(reportId, userId))) {
      throw AppError.notFound("Report not found")
    }
    const isReportMember = deps.isReportMember
    if (!isReportMember) throw new Error("chat-edit-service: report deps not wired")
    if (!(await isReportMember(reportId, userId))) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
  }

  async function requireRoomMember(
    roomKind: RoomKind,
    roomId: string,
    userId: string,
  ): Promise<void> {
    if (roomKind === "report") return requireReportMember(roomId, userId)
    if (roomKind === "group") {
      const isGroupMember = deps.isGroupMember
      if (!isGroupMember) throw new Error("chat-edit-service: group deps not wired")
      if (!(await isGroupMember(roomId, userId))) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
      return
    }
    const isCleanupMember = deps.isCleanupMember
    if (!isCleanupMember) throw new Error("chat-edit-service: cleanup deps not wired")
    if (!(await isCleanupMember(roomId, userId))) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
  }

  async function editRoomMessage(input: EditMessageInput): Promise<ChatMessageDTO> {
    const { roomKind, roomId, messageId, userId, body } = input
    const chat = deps.chat
    if (!chat) throw new Error("chat-edit-service: chat deps not wired")
    await requireRoomMember(roomKind, roomId, userId)
    const meta = await chat.findMessageMeta(messageId)
    if (meta === null || roomRefOf(meta, roomKind) !== roomId) {
      throw AppError.notFound("Message not found")
    }
    assertEditable(meta, userId)
    assertNoSlur(body, "body")

    // Mentions are replaced before the sender-gated UPDATE so the re-read DTO carries them; a lost race
    // leaves the residue on a tombstoned row no reader hydrates.
    await rerecordMentions(roomKind, roomId, userId, messageId, body, input.mentionedUserIds)
    const updated = await editInRoom(chat, roomKind, roomId, messageId, userId, body)
    if (updated === null) throw AppError.conflict(MESSAGE_DELETED)
    fireMessageUpdate(roomKind, roomId, updated)
    return updated
  }

  return {
    editMessage(input: EditMessageInput): Promise<ChatMessageDTO> {
      return input.roomKind === "dm" ? editDmMessage(input) : editRoomMessage(input)
    },
  }
}
