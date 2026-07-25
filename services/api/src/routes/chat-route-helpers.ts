/**
 * Shared assembly for the per-room chat routes (cleanup / report / group / dm).
 *
 * Two shapes were copy-pasted once per room kind, so every fix to either had to land three or four
 * times: the history+pins response assembly (with its "pins only on the initial page" and "prevCursor
 * present only in around-mode" invariants) and the sender-then-powers delete ladder. Both live here now;
 * the route files keep only the per-room repo/gate wiring.
 */

import { AppError, type ChatHistoryResponse, type ChatMessageDTO } from "@civfix/shared"
import type { ChatHistoryPage, ChatService } from "@civfix/shared/interfaces"
import { broadcastMessageUpdate, roomKeyFor } from "../ws/gateway.js"
import type { ChatMessageMeta, SoftDeleteOpts } from "../services/chat-repository.drizzle.js"
import type { ResolveChatPowers } from "../services/chat-room-roles.js"

/** The room kinds whose messages live in chat_messages (dm rows live in dm_messages). */
export type ChatRoomKind = "cleanup" | "report" | "group"

/** One generic 403 for every delete refusal: a caller learns nothing about the row they can't touch. */
export const DELETE_MESSAGE_FORBIDDEN = "You can't delete this message."

export interface ChatHistorySource {
  /** The room's page — the repo's history method with the room id (and viewer) already bound. */
  history(
    before: string | undefined,
    limit: number,
    around: string | undefined,
  ): Promise<ChatHistoryPage>
  /** The room's pin rail. Omitted when no pin source is reachable (the offline cleanup-chat path). */
  listPins?: () => Promise<ChatMessageDTO[]>
}

/**
 * Assemble a room-history response.
 *
 * Pins (P3) ride ONLY the initial page (no before, no around): pagination/around pages stay lean and the
 * client refreshes its pin rail exactly when it (re)opens the room. prevCursor is ABSENT on before-mode
 * pages (byte-identical to pre-2.4 responses) and always present — possibly null (the window reaches the
 * live head) — on around-mode pages. `limit` stays the caller's business: each room owns its own default
 * and cap.
 */
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

/**
 * Does this message row belong to the given room? (chat_messages sets exactly one room ref.) A missing
 * row answers false, so callers get one 404 for "unknown message" and "wrong room" alike — the narrowing
 * predicate lets them read the row afterwards.
 */
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
  /**
   * Whether the caller may attempt the SENDER-gated delete at all (cleanup: member; report: member;
   * group: any role). False skips straight to the powers ladder — a platform operator holds
   * delete-others in a public report room WITHOUT a membership row.
   */
  senderPath: boolean
  /** The room-scoped soft delete (`opts.bypassSenderGate` drops the sender predicate). */
  softDelete(opts?: SoftDeleteOpts): Promise<ChatMessageDTO | null>
  /** Row-state read, used only on the failure path to tell a retry from a row the caller can't touch. */
  findMessageMeta(messageId: string): Promise<ChatMessageMeta | null>
  resolveChatPowers: ResolveChatPowers
  chat: ChatService
  /**
   * Whether to also fan the LEGACY {type:"message"} tombstone frame (pre-P0 clients reconcile the
   * bubble from it). True for cleanup/report rooms, which shipped before message_update; group rooms
   * never emitted it, and a stray `message` frame there would re-insert the deleted bubble.
   */
  legacyBroadcast: boolean
}

/**
 * The delete ladder shared by the cleanup / report / group message-delete routes.
 *
 * Sender self-delete first (the common path — no role lookups). When the sender-gated UPDATE matches
 * nothing, consult the chat-powers resolver (P3 Task 3.5): a cleanup organizer/cohost, a group
 * owner/admin, or a platform operator in a report room may tombstone someone else's message (system rows
 * stay untouchable in the repo). Broadcasts the tombstone, then returns it for the 200.
 */
export async function deleteMessageWithPowers(
  input: DeleteMessageWithPowersInput,
): Promise<ChatMessageDTO> {
  const { roomKind, roomId, messageId, userId } = input

  /** The row's state IN THIS ROOM, or null when it is missing or belongs to another room. */
  const stateInRoom = async (): Promise<ChatMessageMeta | null> => {
    const meta = await input.findMessageMeta(messageId)
    return messageRoomMatches(meta, roomKind, roomId) ? meta : null
  }

  let tombstone: ChatMessageDTO | null = input.senderPath ? await input.softDelete() : null
  if (tombstone === null) {
    // An already-tombstoned row means an earlier delete DID land (a client that retried after a timeout
    // is the common case), so the honest answer is 409 rather than "you may not" — but only for callers
    // entitled to delete it (the row's own sender below, a delete-others holder further down). Everyone
    // else keeps the generic 403, so this never becomes an existence oracle.
    const state = input.senderPath ? await stateInRoom() : null
    if (state !== null && state.deletedAt !== null && state.senderId === userId) {
      throw AppError.conflict("This message was already deleted.")
    }
    const powers = await input.resolveChatPowers({ roomKind, roomId, userId })
    if (!powers.canDeleteOthers) throw AppError.forbidden(DELETE_MESSAGE_FORBIDDEN)
    const current = state ?? (await stateInRoom())
    if (current !== null && current.deletedAt !== null) {
      throw AppError.conflict("This message was already deleted.")
    }
    tombstone = await input.softDelete({ bypassSenderGate: true })
    // Still nothing: a system row (never deletable), or the row vanished from the room underneath us.
    if (tombstone === null) throw AppError.forbidden(DELETE_MESSAGE_FORBIDDEN)
  }

  if (input.legacyBroadcast) {
    void Promise.resolve(input.chat.broadcast(roomKeyFor(roomKind, roomId), tombstone)).catch(() => {})
  }
  // P0: {type:"message_update"} with the tombstoned DTO so connected clients drop the bubble live
  // (previously they only learned of a delete on refetch). Best-effort, alongside the legacy frame.
  broadcastMessageUpdate(input.chat, roomKind, roomId, tombstone)
  return tombstone
}
