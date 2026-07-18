import {
  AppError,
  WsClientMessageSchema,
  type RoomKind,
  type WsClientMessage,
  type WsServerMessage,
  type ChatMessageDTO,
  type UserMentionDTO,
} from "@civfix/shared"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import { parseUserMentions } from "../services/discussion-mentions.js"
import { containsSlur } from "../abuse/slur-filter.js"
import { type GatewayDeps, type GatewaySession, TYPING_MIN_INTERVAL_MS } from "./types.js"

type ClientFrame = WsClientMessage
type ExtractFrame<T extends ClientFrame["type"]> = Extract<ClientFrame, { type: T }>

function serverFrame(frame: WsServerMessage): string {
  return JSON.stringify(frame)
}

function sendError(
  conn: ChatConnection,
  code: string,
  message: string,
  room?: { kind: RoomKind; id: string },
): void {
  conn.send(
    serverFrame({
      type: "error",
      code,
      message,
      ...(room ? { cleanupId: room.id, ...stampRoomKind(room.kind) } : {}),
    }),
  )
}

function stampRoomKind(kind: RoomKind): { roomKind: RoomKind } | Record<string, never> {
  return kind === "cleanup" ? {} : { roomKind: kind }
}

const DM_ROOM_PREFIX = "dm:"

const REPORT_ROOM_PREFIX = "report:"

const GROUP_ROOM_PREFIX = "group:"

export function roomKeyFor(kind: RoomKind, id: string): string {
  if (kind === "dm") return `${DM_ROOM_PREFIX}${id}`
  if (kind === "report") return `${REPORT_ROOM_PREFIX}${id}`
  if (kind === "group") return `${GROUP_ROOM_PREFIX}${id}`
  return id
}

/**
 * Fire-and-forget a {type:"message_update"} frame (edited or tombstoned DTO — clients upsert/drop by
 * id) to the room's key. Best-effort: a fan-out failure never fails the calling mutation. ONE shape
 * for the P0 edit/delete realtime path — used by chat-edit-service and the three delete routes.
 * `chat` is anything carrying the optional broadcastEvent seam (container.chatService, or the edit
 * service's injected fn wrapped in an object literal).
 */
export function broadcastMessageUpdate(
  chat: { broadcastEvent?: ((roomKey: string, frame: WsServerMessage) => Promise<void> | void) | undefined },
  roomKind: RoomKind,
  roomId: string,
  message: ChatMessageDTO,
): void {
  const frame: WsServerMessage = { type: "message_update", roomKind, roomId, message }
  void Promise.resolve(chat.broadcastEvent?.(roomKeyFor(roomKind, roomId), frame)).catch(() => {})
}

function decodeRoomKey(roomKey: string): { kind: RoomKind; id: string } {
  if (roomKey.startsWith(DM_ROOM_PREFIX)) {
    return { kind: "dm", id: roomKey.slice(DM_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(REPORT_ROOM_PREFIX)) {
    return { kind: "report", id: roomKey.slice(REPORT_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(GROUP_ROOM_PREFIX)) {
    return { kind: "group", id: roomKey.slice(GROUP_ROOM_PREFIX.length) }
  }
  return { kind: "cleanup", id: roomKey }
}

export async function leaveRoomAndAnnounce(session: GatewaySession, roomKey: string): Promise<void> {
  const { conn, deps, userId } = session
  const { kind, id } = decodeRoomKey(roomKey)
  await deps.chat.leaveRoom(roomKey, conn)
  session.joined.delete(roomKey)
  session.typingThrottle.delete(roomKey)
  if (deps.presence) {
    const { userGone } = await deps.presence.leave(roomKey, conn.id, userId)
    if (userGone) {
      await deps.chat.broadcastEvent?.(roomKey, {
        type: "presence",
        cleanupId: id,
        ...stampRoomKind(kind),
        userId,
        state: "leave",
      })
    }
  }
}

async function authorizeRoom(
  deps: GatewayDeps,
  kind: RoomKind,
  id: string,
  userId: string,
  requireMember = false,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (kind === "cleanup") {
    const ok = await deps.isMember(id, userId)
    return ok ? { ok: true } : { ok: false, code: "FORBIDDEN", message: "You are not a member of this cleanup." }
  }
  if (kind === "report") {
    // Join is public: any authed socket that can SEE the report may open the room read-only.
    if (deps.reportVisible && !(await deps.reportVisible(id, userId))) {
      return { ok: false, code: "NOT_FOUND", message: "Report not found." }
    }
    // Posting / typing / presence require actual membership (Join button in the client).
    if (requireMember && deps.reportChat && !(await deps.reportChat.isMember(id, userId))) {
      return { ok: false, code: "FORBIDDEN", message: "Join this report chat to send messages." }
    }
    return { ok: true }
  }
  if (kind === "group") {
    // P4 Task 4.3: the group HTTP surface is live but the WS join/send lane lands in Task 4.4.
    // FAIL CLOSED explicitly so a group frame can never fall through to the dm lane below.
    return { ok: false, code: "FORBIDDEN", message: "Group chat realtime is not available yet." }
  }
  if (!deps.dm) {
    return { ok: false, code: "FORBIDDEN", message: "Direct messages are not available." }
  }
  const peer = await deps.dm.peerOf(id, userId)
  if (peer === null) {
    return { ok: false, code: "FORBIDDEN", message: "You can't message in this conversation." }
  }
  if (deps.isBlockedEitherWay && (await deps.isBlockedEitherWay(userId, peer))) {
    return { ok: false, code: "FORBIDDEN", message: "You can't message in this conversation." }
  }
  return { ok: true }
}

function selfSignalThreads(channel: UserChannel | undefined, userId: string, id: string): void {
  void channel?.publishToUser(userId, { topic: "threads", id }).catch(() => {})
}

async function handleJoin(session: GatewaySession, frame: ExtractFrame<"join">): Promise<void> {
  const { conn, deps, userId } = session
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const id = frame.cleanupId
  const auth = await authorizeRoom(deps, kind, id, userId)
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  const roomKey = roomKeyFor(kind, id)
  await deps.chat.joinRoom(roomKey, conn, userId)
  session.joined.add(roomKey)
  if (deps.presence) {
    const { online, userJoined } = await deps.presence.join(roomKey, conn.id, userId)
    conn.send(
      serverFrame({ type: "presence_snapshot", cleanupId: id, ...stampRoomKind(kind), userIds: online }),
    )
    if (userJoined) {
      await deps.chat.broadcastEvent?.(
        roomKey,
        { type: "presence", cleanupId: id, ...stampRoomKind(kind), userId, state: "join" },
        { excludeConnId: conn.id },
      )
    }
  }
  if (kind !== "report" && deps.markReadOnOpen) {
    const { markReadOnOpen, userChannel } = deps
    void markReadOnOpen(kind, id, userId)
      .then(() => selfSignalThreads(userChannel, userId, id))
      .catch(() => {})
  }
}

async function handleLeave(session: GatewaySession, frame: ExtractFrame<"leave">): Promise<void> {
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  await leaveRoomAndAnnounce(session, roomKeyFor(kind, frame.cleanupId))
}

async function handleSend(session: GatewaySession, frame: ExtractFrame<"send">): Promise<void> {
  const { conn, deps, userId } = session
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const id = frame.cleanupId
  if (containsSlur(frame.body)) {
    sendError(conn, "BLOCKED", "This contains language that isn't allowed.", { kind, id })
    return
  }
  const roomKey = roomKeyFor(kind, id)
  if (deps.reportSendLimiter && !deps.reportSendLimiter.tryConsume(`${userId}:${roomKey}`)) {
    sendError(conn, "RATE_LIMITED", "You're sending messages too fast. Please slow down.", { kind, id })
    return
  }
  const auth = await authorizeRoom(deps, kind, id, userId, /* requireMember */ true)
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  const mediaUploadIds = frame.mediaUploadIds
  let message: ChatMessageDTO
  try {
    if (kind === "dm") {
      message = await deps.dm!.persist({
        threadId: id,
        senderId: userId,
        body: frame.body,
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
        clientId: frame.clientId,
        ...(mediaUploadIds && mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
        ...(frame.replyToId !== undefined ? { replyToId: frame.replyToId } : {}),
      })
    } else {
      message = await deps.chat.persist({
        cleanupId: id,
        roomKind: kind === "report" ? "report" : "cleanup",
        userId,
        body: frame.body,
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
        clientId: frame.clientId,
        ...(mediaUploadIds && mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
        ...(frame.replyToId !== undefined ? { replyToId: frame.replyToId } : {}),
      })
    }
  } catch (err) {
    // Domain rejections from persist (e.g. P2 reply validation: reply_wrong_room /
    // reply_deleted_target) surface as a room-stamped error frame carrying the machine subcode
    // (fields.code when present, the coarse ErrorCode otherwise) instead of a generic INTERNAL.
    if (err instanceof AppError) {
      sendError(conn, err.fields?.code ?? err.code, err.message, { kind, id })
      return
    }
    throw err
  }
  let mentions: UserMentionDTO[] = []
  if (deps.chatMentions) {
    const { chatMentions } = deps
    const handles = parseUserMentions(frame.body)
    const userIds = frame.mentionedUserIds ?? []
    if (handles.length > 0 || userIds.length > 0) {
      try {
        mentions = await chatMentions.resolveChatMentions({ handles, userIds, authorUserId: userId, kind, roomId: id })
        if (mentions.length > 0) {
          await chatMentions.recordChatMentions(message.id, mentions.map((m) => m.id))
        }
      } catch {
        mentions = []
      }
    }
  }
  if (mentions.length > 0) message = { ...message, mentions }

  await deps.chat.broadcast(roomKey, message, { excludeConnId: conn.id })
  conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message }))

  const replyTargetUserId = replyBellTarget(message, userId)
  fireMentionBells(deps, kind, id, userId, mentions, message, replyTargetUserId)
  fireThreadSignal(deps, kind, id, userId)
  fireDmBell(deps, kind, id, userId, roomKey, message)
  fireReplyBell(deps, kind, id, userId, replyTargetUserId, message)
  fireReportCityForward(deps, kind, id, message)
}

/**
 * The reply-bell target (P2 2.5): the replied-to message's SENDER, read off the hydrated replyTo
 * preview the persist path returned — null when the message is not a reply, when the target is a
 * sender-less SYSTEM message or a deleted account (both hydrate from:null), or when the author
 * replied to their own message.
 */
function replyBellTarget(message: ChatMessageDTO, authorUserId: string): string | null {
  const target = message.replyTo?.from?.id
  return target !== undefined && target !== authorUserId ? target : null
}

/**
 * Fire the P2 2.5 reply bell for GROUP rooms (dm replies ride fireDmBell -> onDmDelivered, the single
 * dm bell site). Fire-and-forget like every other post-send bell.
 */
function fireReplyBell(
  deps: GatewayDeps,
  kind: RoomKind,
  roomId: string,
  actorUserId: string,
  targetUserId: string | null,
  message: ChatMessageDTO,
): void {
  if (kind === "dm" || targetUserId === null || !deps.onChatReply) return
  void deps.onChatReply({ kind, roomId, actorUserId, targetUserId, message }).catch(() => {})
}

function fireReportCityForward(
  deps: GatewayDeps,
  kind: RoomKind,
  reportId: string,
  message: ChatMessageDTO,
): void {
  if (kind !== "report" || !deps.onReportMessage) return
  void deps.onReportMessage(reportId, message).catch(() => {})
}

function fireMentionBells(
  deps: GatewayDeps,
  kind: RoomKind,
  roomId: string,
  actorUserId: string,
  mentions: UserMentionDTO[],
  message: ChatMessageDTO,
  replyTargetUserId: string | null,
): void {
  if (!deps.chatMentions || mentions.length === 0) return
  const { chatMentions } = deps
  for (const m of mentions) {
    // MENTION-vs-REPLY DEDUPE POINT (P2 2.5): when the replied-to user is ALSO @-mentioned in the same
    // message, only the (mute-piercing) REPLY bell fires — chosen here because this is the one place
    // that sees both the resolved mentions and the reply target. The mention ROW was still recorded and
    // broadcast above; only the duplicate bell is dropped. Gated on the reply seam being wired so a
    // deployment without onChatReply keeps its mention bell.
    if (deps.onChatReply && kind !== "dm" && m.id === replyTargetUserId) continue
    void chatMentions
      .notifyChatMention({ kind, roomId, actorUserId, mentionedUserId: m.id, message })
      .catch(() => {})
  }
}

function fireThreadSignal(deps: GatewayDeps, kind: RoomKind, id: string, senderId: string): void {
  if (!deps.userChannel || !deps.threadRecipientsOf) return
  const { userChannel, threadRecipientsOf } = deps
  void (async () => {
    const recipients = await threadRecipientsOf(kind, id, senderId)
    if (recipients.length === 0) return
    await userChannel.publishToUsers(recipients, { topic: "threads", id })
  })().catch(() => {})
}

function fireDmBell(
  deps: GatewayDeps,
  kind: RoomKind,
  id: string,
  senderId: string,
  roomKey: string,
  message: ChatMessageDTO,
): void {
  if (kind !== "dm" || !deps.dm || !deps.onDmDelivered) return
  const { dm, onDmDelivered, presence } = deps
  void (async () => {
    const peer = await dm.peerOf(id, senderId)
    if (peer === null) return
    if (presence) {
      const online = await presence.online(roomKey)
      if (online.includes(peer)) return
    }
    await onDmDelivered(id, peer, message)
  })().catch(() => {})
}

async function handleTyping(session: GatewaySession, frame: ExtractFrame<"typing">): Promise<void> {
  const { conn, deps, userId } = session
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const id = frame.cleanupId
  const auth = await authorizeRoom(deps, kind, id, userId, /* requireMember */ kind === "report")
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  const roomKey = roomKeyFor(kind, id)
  const now = Date.now()
  const last = session.typingThrottle.get(roomKey) ?? 0
  if (now - last < TYPING_MIN_INTERVAL_MS) return
  session.typingThrottle.set(roomKey, now)
  await deps.chat.broadcastEvent?.(
    roomKey,
    { type: "typing", cleanupId: id, ...stampRoomKind(kind), userId },
    { excludeConnId: conn.id },
  )
}

async function handleAck(session: GatewaySession, frame: ExtractFrame<"ack">): Promise<void> {
  const { deps, userId } = session
  let kind: RoomKind
  let id: string | undefined
  if (frame.cleanupId !== undefined) {
    kind = frame.roomKind ?? "cleanup"
    id = frame.cleanupId
  } else {
    const firstKey: string | undefined = session.joined.values().next().value
    if (firstKey === undefined) return
    const decoded = decodeRoomKey(firstKey)
    kind = decoded.kind
    id = decoded.id
  }
  if (id === undefined) return
  if (kind === "report") {
    if (deps.reportChat) await deps.reportChat.advanceReadWatermark(id, userId, frame.upToId)
    return
  }
  if (kind === "dm") {
    if (deps.dm && (await deps.dm.peerOf(id, userId)) !== null) {
      await deps.dm.markRead(id, userId, frame.upToId)
      selfSignalThreads(deps.userChannel, userId, id)
    }
  } else if (deps.markRead) {
    await deps.markRead(id, userId, frame.upToId)
    selfSignalThreads(deps.userChannel, userId, id)
  }
}

const dispatch: {
  [K in ClientFrame["type"]]: (session: GatewaySession, frame: ExtractFrame<K>) => Promise<void>
} = {
  join: handleJoin,
  leave: handleLeave,
  send: handleSend,
  typing: handleTyping,
  ack: handleAck,
}

export async function handleClientFrame(session: GatewaySession, raw: string): Promise<void> {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    sendError(session.conn, "BAD_FRAME", "Malformed frame: not JSON.")
    return
  }
  const result = WsClientMessageSchema.safeParse(parsedJson)
  if (!result.success) {
    sendError(session.conn, "BAD_FRAME", "Frame failed schema validation.")
    return
  }
  const frame = result.data
  await (dispatch[frame.type] as (s: GatewaySession, f: ClientFrame) => Promise<void>)(session, frame)
}

export { serverFrame, sendError, decodeRoomKey }
