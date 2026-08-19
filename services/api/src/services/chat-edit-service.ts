/**
 * Unified chat-message EDIT service (P0 Task 0.2): one roomKind-dispatching `editMessage` behind the DM
 * edit route today and the upcoming PATCH /messages route (Task 0.3). Mirrors chat-reaction-service's
 * shape: a factory over optional per-room deps, so a DM-only caller (dm.routes) wires only the dm half.
 *
 * Gate ladder (in order):
 *   1. Resolve the message by id in the correct table (dm_messages for "dm", chat_messages otherwise)
 *      and verify its room ref matches roomId -> 404 otherwise (also plain-missing).
 *   2. Room-send permission still held (the SAME checks the WS send path runs): cleanup member, report
 *      chat member (preceded by the report VISIBILITY check when deps.isReportVisible is wired -> 404),
 *      group member (P4 4.4), dm thread peer + not blocked either way -> plain 403. This runs BEFORE the per-row
 *      state gates so a non-member probing leaked UUIDs learns nothing about a message's deleted-ness
 *      or kind — they only ever see the generic 403.
 *   3. Sender-only -> 403 (machine code "not_sender" in the error envelope's `fields.code`). A
 *      sender-less SYSTEM row skips this gate and fails the kind gate below instead (422) — "not your
 *      message" would be misleading for a message nobody authored.
 *   4. Not soft-deleted -> 409.
 *   5. kind === "text" only -> 422.
 *   6. Within EDIT_WINDOW_HOURS of created_at -> 403 (code "edit_window_expired").
 * Then: slur filter (App Store 1.2a, same helper as WS send / the old DM edit), the sender-gated UPDATE
 * (body + edited_at = now()), mention re-resolution under the existing scope rules (report rooms stay
 * mention-free; the recorded set is REPLACED so dropped @mentions clear), a {type:"message_update"}
 * broadcast to the room key, and the refreshed fully-hydrated ChatMessageDTO back to the caller.
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
import type { ChatRepository } from "./chat-repository.drizzle.js"
import type { DmRepository } from "./dm-repository.drizzle.js"

export const CHAT_EDIT_FORBIDDEN = "You can't edit this message."

export type IsRoomMemberFn = (roomId: string, userId: string) => Promise<boolean>

export interface ChatEditServiceDeps {
  chat?: ChatRepository
  dm?: DmRepository
  isCleanupMember?: IsRoomMemberFn
  isReportMember?: IsRoomMemberFn
  /**
   * Report VISIBILITY (isReportVisibleTo: a publicly-visible status + public, or the reporter's own).
   * Optional; when wired it runs BEFORE the membership gate so an unlisted / held / soft-deleted report
   * answers 404 exactly like report-chat.routes' requireVisibleReport — the same shape and ordering
   * chat-reaction-service's report lane uses. Absent = not enforced in-service, which is why the route
   * keeps its own requireVisibleReport pre-gate; wiring this closes the gap for any OTHER caller (a
   * membership row survives a report being held, so membership alone is not the visibility gate).
   */
  isReportVisible?: (reportId: string, userId: string) => Promise<boolean>
  /** P4 4.4 group lane: chat_group_members membership (the SAME gate the WS group send runs). */
  isGroupMember?: IsRoomMemberFn
  dmPeerOf?: (threadId: string, userId: string) => Promise<string | null>
  isBlockedEitherWay?: (a: string, b: string) => Promise<boolean>
  /**
   * Optional mention seam (resolve + record). Absent -> the edit leaves the recorded mentions as-is.
   * notifyChatMention is deliberately excluded: editing a message never re-fires mention bells.
   */
  chatMentions?: Pick<GatewayChatMentions, "resolveChatMentions" | "recordChatMentions">
  /** Room fan-out seam (chatService.broadcastEvent). Best-effort: a failure never fails the edit. */
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
  new AppError(ErrorCode.FORBIDDEN, CHAT_EDIT_FORBIDDEN, { fields: { code: "not_sender" } })

const editWindowExpired = () =>
  new AppError(ErrorCode.FORBIDDEN, "This message can no longer be edited.", {
    fields: { code: "edit_window_expired" },
  })

/** Gates 2-5 over the resolved row metadata (shared by the dm and chat flows). */
function assertEditable(
  meta: { senderId: string | null; kind: ChatMessageKind; createdAt: Date; deletedAt: Date | null },
  userId: string,
): void {
  if (meta.senderId !== null && meta.senderId !== userId) throw notSender()
  if (meta.deletedAt !== null) throw AppError.conflict("This message was deleted.")
  // A sender-less SYSTEM row lands here too (kind "system"), so it 422s rather than 403s.
  if (meta.kind !== "text") {
    throw AppError.validation({ kind: "Only text messages can be edited." })
  }
  if (Date.now() - meta.createdAt.getTime() > EDIT_WINDOW_HOURS * 3_600_000) {
    throw editWindowExpired()
  }
}

export function makeChatEditService(deps: ChatEditServiceDeps): ChatEditService {
  /**
   * Re-resolve + REPLACE the message's recorded mention set from the edited body (existing scope rules:
   * the resolver filters to the dm peer / cleanup members; report rooms stay mention-free so they skip
   * entirely). Best-effort like the WS send path — a mention failure never fails the edit.
   */
  async function rerecordMentions(
    kind: RoomKind,
    roomId: string,
    userId: string,
    messageId: string,
    body: string,
    mentionedUserIds: string[] | undefined,
  ): Promise<void> {
    const mentions = deps.chatMentions
    if (!mentions || kind === "report") return
    try {
      const resolved = await mentions.resolveChatMentions({
        handles: parseUserMentions(body),
        userIds: mentionedUserIds ?? [],
        authorUserId: userId,
        kind,
        roomId,
      })
      // Record even an EMPTY set: an edit that drops an @mention must clear the stale record.
      await mentions.recordChatMentions(messageId, resolved.map((m) => m.id))
    } catch {
      // Best-effort, like the WS send path: a mention failure never fails the edit.
    }
  }

  /** Fire-and-forget the {type:"message_update"} frame to the room key (SAME helper the delete routes use). */
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
    const meta = await dm.findMessageMeta(messageId)
    if (meta === null || meta.threadId !== roomId) throw AppError.notFound("Message not found")
    // Room-send permission still held: thread peer + not blocked either way (the WS dm gate). BEFORE the
    // per-row state gates so a non-participant learns nothing beyond the generic 403 (no info leak).
    const peer = await dmPeerOf(roomId, userId)
    if (peer === null) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    if (await isBlockedEitherWay(userId, peer)) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    assertEditable(meta, userId)
    assertNoSlur(body, "body")

    // Record mentions BEFORE the sender-gated edit so the returned (re-read) DTO already carries them.
    // Lost-race residue is harmless: if the row is tombstoned underneath us the edit below no-ops (409)
    // and the replaced mention set sits on a deleted message no reader ever hydrates.
    await rerecordMentions("dm", roomId, userId, messageId, body, input.mentionedUserIds)
    const updated = await dm.editMessage(roomId, messageId, userId, body)
    // The gate ladder passed above, so a null here is a lost race (e.g. deleted underneath us).
    if (updated === null) throw AppError.conflict("This message was deleted.")
    fireMessageUpdate("dm", roomId, updated)
    return updated
  }

  async function editRoomMessage(input: EditMessageInput): Promise<ChatMessageDTO> {
    const { roomKind, roomId, messageId, userId, body } = input
    const chat = deps.chat
    if (!chat) throw new Error("chat-edit-service: chat deps not wired")
    const isReport = roomKind === "report"
    const isGroup = roomKind === "group"
    const meta = await chat.findMessageMeta(messageId)
    const roomMatches =
      meta !== null &&
      (isReport
        ? meta.reportId === roomId
        : isGroup
          ? meta.groupId === roomId
          : meta.cleanupId === roomId)
    if (meta === null || !roomMatches) throw AppError.notFound("Message not found")
    // Room-send permission still held: the SAME membership checks the WS send path runs. BEFORE the
    // per-row state gates so a non-member probing leaked UUIDs learns nothing about a message's
    // deleted-ness/kind — they only ever see the generic 403.
    if (isReport) {
      // Visibility first (when wired), so a report that went held/unlisted answers 404 like the routes'
      // requireVisibleReport rather than leaking a 403 keyed on a stale membership row.
      if (deps.isReportVisible && !(await deps.isReportVisible(roomId, userId))) {
        throw AppError.notFound("Report not found")
      }
      const isReportMember = deps.isReportMember
      if (!isReportMember) throw new Error("chat-edit-service: report deps not wired")
      if (!(await isReportMember(roomId, userId))) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    } else if (isGroup) {
      const isGroupMember = deps.isGroupMember
      if (!isGroupMember) throw new Error("chat-edit-service: group deps not wired")
      if (!(await isGroupMember(roomId, userId))) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    } else {
      const isCleanupMember = deps.isCleanupMember
      if (!isCleanupMember) throw new Error("chat-edit-service: cleanup deps not wired")
      if (!(await isCleanupMember(roomId, userId))) throw AppError.forbidden(CHAT_EDIT_FORBIDDEN)
    }
    assertEditable(meta, userId)
    assertNoSlur(body, "body")

    // Mentions are REPLACED before the sender-gated UPDATE (so the re-read DTO carries them); a lost
    // race leaves the residue on a tombstoned row, which is harmless — no reader hydrates it.
    await rerecordMentions(roomKind, roomId, userId, messageId, body, input.mentionedUserIds)
    const updated = isReport
      ? await chat.editReportMessage(roomId, messageId, userId, body)
      : isGroup
        ? await chat.editGroupMessage(roomId, messageId, userId, body)
        : await chat.editMessage(roomId, messageId, userId, body)
    if (updated === null) throw AppError.conflict("This message was deleted.")
    fireMessageUpdate(roomKind, roomId, updated)
    return updated
  }

  return {
    editMessage(input: EditMessageInput): Promise<ChatMessageDTO> {
      return input.roomKind === "dm" ? editDmMessage(input) : editRoomMessage(input)
    },
  }
}
