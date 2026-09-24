import {
  AppError,
  ErrorCode,
  WsClientMessageSchema,
  type RoomKind,
  type WsClientMessage,
  type WsServerMessage,
  type ChatMessageDTO,
  type UserMentionDTO,
} from "@civfix/shared"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import { resolveAndRecordChatMentions } from "../services/chat-mention-resolver.js"
import { mapWithLimit } from "../lib/concurrency.js"
import { neutralizeChatViewerFields } from "../services/chat-viewer-fields.js"
import { containsSlur } from "../abuse/slur-filter.js"
import { SUSPENDED_MESSAGE, socketWriteVerdict } from "../auth/account-status.js"
import {
  type GatewayDeps,
  type GatewaySession,
  TYPING_MIN_INTERVAL_MS,
  TYPING_THROTTLE_MAX_ROOMS,
  WS_FRAME_LIMIT,
  WS_FRAME_RATE_LIMITED_MESSAGE,
  WS_MAX_JOINED_ROOMS,
  WS_SESSION_ENDED_MESSAGE,
} from "./types.js"
import { makeTokenBucketLimiter } from "./report-rate-limit.js"
import {
  makeSendResilience,
  sendDedupeKey,
  type SendReservation,
  type SendResilience,
} from "./send-resilience.js"

const PASSTHROUGH_SEND_RESILIENCE: SendResilience = makeSendResilience()

const DEFAULT_ROOM_KIND: RoomKind = "cleanup"

const BAD_FRAME_CODE = "BAD_FRAME"

const BLOCKED_CODE = "BLOCKED"

const CHANNEL_READ_ONLY_CODE = "channel_read_only"

const NOT_GROUP_MEMBER_MESSAGE = "You are not a member of this group."

const DM_NOT_ALLOWED_MESSAGE = "You can't message in this conversation."

type ClientFrame = WsClientMessage
type ExtractFrame<T extends ClientFrame["type"]> = Extract<ClientFrame, { type: T }>

interface FrameRoom {
  kind: RoomKind
  id: string
}

function frameRoomKind(frame: { roomKind?: RoomKind | undefined }): RoomKind {
  return frame.roomKind ?? DEFAULT_ROOM_KIND
}

function serverFrame(frame: WsServerMessage): string {
  return JSON.stringify(frame)
}

function sendError(conn: ChatConnection, code: string, message: string, room?: FrameRoom): void {
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

export function broadcastMessageUpdate(
  chat: {
    broadcastEvent?: ((roomKey: string, frame: WsServerMessage) => Promise<void> | void) | undefined
  },
  roomKind: RoomKind,
  roomId: string,
  message: ChatMessageDTO,
): void {
  const frame: WsServerMessage = { type: "message_update", roomKind, roomId, message }
  void Promise.resolve(chat.broadcastEvent?.(roomKeyFor(roomKind, roomId), frame)).catch(() => {})
}

function decodeRoomKey(roomKey: string): FrameRoom {
  if (roomKey.startsWith(DM_ROOM_PREFIX)) {
    return { kind: "dm", id: roomKey.slice(DM_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(REPORT_ROOM_PREFIX)) {
    return { kind: "report", id: roomKey.slice(REPORT_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(GROUP_ROOM_PREFIX)) {
    return { kind: "group", id: roomKey.slice(GROUP_ROOM_PREFIX.length) }
  }
  return { kind: DEFAULT_ROOM_KIND, id: roomKey }
}

export async function leaveRoomAndAnnounce(
  session: GatewaySession,
  roomKey: string,
): Promise<void> {
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

type RoomAuthorization = { ok: true; peer?: string } | { ok: false; code: string; message: string }

async function authorizeRoom(
  deps: GatewayDeps,
  kind: RoomKind,
  id: string,
  userId: string,
  requireMember = false,
): Promise<RoomAuthorization> {
  if (kind === "cleanup") {
    const ok = await deps.isMember(id, userId)
    return ok
      ? { ok: true }
      : { ok: false, code: ErrorCode.FORBIDDEN, message: "You are not a member of this cleanup." }
  }
  if (kind === "report") {
    if (deps.reportVisible && !(await deps.reportVisible(id, userId))) {
      return { ok: false, code: ErrorCode.NOT_FOUND, message: "Report not found." }
    }
    if (requireMember) {
      if (!deps.reportChat) {
        return { ok: false, code: ErrorCode.FORBIDDEN, message: "Report chat is not available." }
      }
      if (!(await deps.reportChat.isMember(id, userId))) {
        return {
          ok: false,
          code: ErrorCode.FORBIDDEN,
          message: "Join this report chat to send messages.",
        }
      }
    }
    return { ok: true }
  }
  if (kind === "group") {
    if (!deps.groupChat) {
      return { ok: false, code: ErrorCode.FORBIDDEN, message: "Group chat is not available." }
    }
    const access = await deps.groupChat.access(id, userId)
    if (access === null) {
      return { ok: false, code: ErrorCode.FORBIDDEN, message: NOT_GROUP_MEMBER_MESSAGE }
    }
    if (!requireMember) {
      if (access.isMember || access.visibility === "public") return { ok: true }
      return { ok: false, code: ErrorCode.FORBIDDEN, message: NOT_GROUP_MEMBER_MESSAGE }
    }
    if (!access.isMember) {
      return { ok: false, code: ErrorCode.FORBIDDEN, message: NOT_GROUP_MEMBER_MESSAGE }
    }
    if (!access.canPost) {
      return {
        ok: false,
        code: CHANNEL_READ_ONLY_CODE,
        message: "Only owners and admins can post in this channel.",
      }
    }
    return { ok: true }
  }
  if (!deps.dm) {
    return { ok: false, code: ErrorCode.FORBIDDEN, message: "Direct messages are not available." }
  }
  const peer = await deps.dm.peerOf(id, userId)
  if (peer === null) {
    return { ok: false, code: ErrorCode.FORBIDDEN, message: DM_NOT_ALLOWED_MESSAGE }
  }
  if (deps.isBlockedEitherWay && (await deps.isBlockedEitherWay(userId, peer))) {
    return { ok: false, code: ErrorCode.FORBIDDEN, message: DM_NOT_ALLOWED_MESSAGE }
  }
  return { ok: true, peer }
}

export async function canStillRead(session: GatewaySession, roomKey: string): Promise<boolean> {
  const { deps, userId } = session
  const { kind, id } = decodeRoomKey(roomKey)
  try {
    const auth = await authorizeRoom(deps, kind, id, userId)
    return auth.ok
  } catch {
    // A lookup outage keeps the socket in its rooms; the next reauthorization pass decides again.
    return true
  }
}

export async function reauthorizeJoinedRooms(session: GatewaySession): Promise<void> {
  for (const roomKey of [...session.joined]) {
    if (session.closed) return
    if (!session.joined.has(roomKey)) continue
    if (await canStillRead(session, roomKey)) continue
    const room = decodeRoomKey(roomKey)
    sendError(
      session.conn,
      ErrorCode.FORBIDDEN,
      "You no longer have access to this conversation.",
      room,
    )
    await leaveRoomAndAnnounce(session, roomKey).catch(() => {})
  }
}

function selfSignalThreads(channel: UserChannel | undefined, userId: string, id: string): void {
  void channel?.publishToUser(userId, { topic: "threads", id }).catch(() => {})
}

async function handleJoin(session: GatewaySession, frame: ExtractFrame<"join">): Promise<void> {
  const { conn, deps, userId } = session
  const kind = frameRoomKind(frame)
  const id = frame.cleanupId
  const roomKey = roomKeyFor(kind, id)
  if (session.joined.has(roomKey)) {
    if (deps.presence) {
      const online = await deps.presence.online(roomKey)
      if (session.closed) return
      conn.send(
        serverFrame({
          type: "presence_snapshot",
          cleanupId: id,
          ...stampRoomKind(kind),
          userIds: online,
        }),
      )
    }
    return
  }
  if (session.joined.size >= WS_MAX_JOINED_ROOMS) {
    sendError(conn, ErrorCode.RATE_LIMITED, "You've joined too many rooms. Leave one first.", {
      kind,
      id,
    })
    return
  }
  const auth = await authorizeRoom(deps, kind, id, userId)
  if (session.closed) return
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  await deps.chat.joinRoom(roomKey, conn, userId)
  if (session.closed) {
    await deps.chat.leaveRoom(roomKey, conn)
    return
  }
  session.joined.add(roomKey)
  if (deps.presence) {
    const { online, userJoined } = await deps.presence.join(roomKey, conn.id, userId)
    if (session.closed) {
      session.joined.delete(roomKey)
      await deps.presence.leave(roomKey, conn.id, userId)
      await deps.chat.leaveRoom(roomKey, conn)
      return
    }
    conn.send(
      serverFrame({
        type: "presence_snapshot",
        cleanupId: id,
        ...stampRoomKind(kind),
        userIds: online,
      }),
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
  const kind = frameRoomKind(frame)
  const roomKey = roomKeyFor(kind, frame.cleanupId)
  if (!session.joined.has(roomKey)) return
  await leaveRoomAndAnnounce(session, roomKey)
}

const CLIENT_AUTHORABLE_KINDS: ReadonlySet<string> = new Set([
  "text",
  "share_pin",
  "task_complete",
  "rsvp_change",
])

export const MENTION_BELL_CONCURRENCY = 8

type SendFrame = ExtractFrame<"send">

async function rejectSendFrame(
  session: GatewaySession,
  frame: SendFrame,
  body: string,
  room: FrameRoom,
): Promise<boolean> {
  const { conn } = session
  const verdict = await socketWriteVerdict(session)
  if (verdict === "revoked") {
    if (session.closeForAuth) session.closeForAuth()
    else sendError(conn, ErrorCode.UNAUTHORIZED, WS_SESSION_ENDED_MESSAGE, room)
    return true
  }
  if (verdict === "suspended") {
    sendError(conn, ErrorCode.FORBIDDEN, SUSPENDED_MESSAGE, room)
    return true
  }
  if (frame.kind !== undefined && !CLIENT_AUTHORABLE_KINDS.has(frame.kind)) {
    sendError(conn, BAD_FRAME_CODE, "That message kind can't be sent by a client.", room)
    return true
  }
  if (containsSlur(frame.body)) {
    sendError(conn, BLOCKED_CODE, "This contains language that isn't allowed.", room)
    return true
  }
  const carriesMedia = (frame.mediaUploadIds?.length ?? 0) > 0
  const isTextFrame = frame.kind === undefined || frame.kind === "text"
  if (body.length === 0 && !carriesMedia && isTextFrame) {
    sendError(conn, BAD_FRAME_CODE, "A message needs text or an attachment.", room)
    return true
  }
  return false
}

function optionalSendFields(frame: SendFrame): {
  kind?: NonNullable<SendFrame["kind"]>
  clientId: string
  mediaUploadIds?: string[]
  replyToId?: string
} {
  const { mediaUploadIds } = frame
  return {
    ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
    clientId: frame.clientId,
    ...(mediaUploadIds && mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
    ...(frame.replyToId !== undefined ? { replyToId: frame.replyToId } : {}),
  }
}

function persistSendFrame(
  deps: GatewayDeps,
  room: FrameRoom,
  userId: string,
  frame: SendFrame,
  body: string,
): Promise<ChatMessageDTO> {
  if (room.kind === "dm") {
    return deps.dm!.persist({
      threadId: room.id,
      senderId: userId,
      body,
      ...optionalSendFields(frame),
    })
  }
  return deps.chat.persist({
    cleanupId: room.id,
    roomKind: room.kind,
    userId,
    body,
    ...optionalSendFields(frame),
  })
}

function fireSendSideEffects(
  deps: GatewayDeps,
  room: FrameRoom,
  userId: string,
  peer: string | null,
  roomKey: string,
  message: ChatMessageDTO,
  mentions: UserMentionDTO[],
): void {
  const { kind, id } = room
  const replyTargetUserId = replyBellTarget(message, userId)
  fireMentionBells(deps, kind, id, userId, mentions, message, replyTargetUserId)
  fireThreadSignal(deps, kind, id, userId)
  fireDmBell(deps, kind, id, peer, roomKey, message)
  fireReplyBell(deps, kind, id, userId, replyTargetUserId, message)
  fireReportCityForward(deps, kind, id, userId, message)
  fireGroupFanOut(deps, kind, id, message)
}

async function handleSend(session: GatewaySession, frame: SendFrame): Promise<void> {
  const { conn, deps, userId } = session
  const room: FrameRoom = { kind: frameRoomKind(frame), id: frame.cleanupId }
  const { kind, id } = room
  const body = frame.body.trim()
  if (await rejectSendFrame(session, frame, body, room)) return
  const roomKey = roomKeyFor(kind, id)
  const auth = await authorizeRoom(deps, kind, id, userId, true)
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, room)
    return
  }
  if (deps.reportSendLimiter && !deps.reportSendLimiter.tryConsume(`${userId}:${roomKey}`)) {
    sendError(
      conn,
      ErrorCode.RATE_LIMITED,
      "You're sending messages too fast. Please slow down.",
      room,
    )
    return
  }
  const resilience = deps.chat.sendResilience ?? PASSTHROUGH_SEND_RESILIENCE
  const dedupeKey = sendDedupeKey(userId, roomKey, frame.clientId)
  const reservation: SendReservation = await resilience.reserve(dedupeKey)
  if (reservation.state === "duplicate") {
    const already = await resilience.findRoomMessage(kind, id, reservation.messageId, userId)
    if (already !== null) {
      conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message: already }))
      return
    }
  }
  let message: ChatMessageDTO
  try {
    message = await persistSendFrame(deps, room, userId, frame, body)
  } catch (err) {
    if (reservation.state === "reserved") void resilience.release(dedupeKey)
    if (err instanceof AppError) {
      sendError(conn, err.fields?.code ?? err.code, err.message, room)
      return
    }
    throw err
  }
  // Committed before the mention lookup so a client retrying this clientId re-acks instead of inserting.
  void resilience.commit(dedupeKey, message.id)
  const mentions: UserMentionDTO[] = await resolveAndRecordChatMentions(deps.chatMentions, {
    body,
    mentionedUserIds: frame.mentionedUserIds ?? [],
    authorUserId: userId,
    kind,
    roomId: id,
    messageId: message.id,
  })
  if (mentions.length > 0) message = { ...message, mentions }

  conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message }))

  await resilience.broadcastMessage(
    deps.chat,
    roomKey,
    neutralizeChatViewerFields(message),
    conn.id,
  )

  fireSendSideEffects(deps, room, userId, auth.peer ?? null, roomKey, message, mentions)
}

function replyBellTarget(message: ChatMessageDTO, authorUserId: string): string | null {
  const target = message.replyTo?.from?.id
  return target !== undefined && target !== authorUserId ? target : null
}

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

function fireGroupFanOut(
  deps: GatewayDeps,
  kind: RoomKind,
  groupId: string,
  message: ChatMessageDTO,
): void {
  if (kind !== "group" || !deps.onGroupMessage) return
  void deps.onGroupMessage(groupId, message).catch(() => {})
}

function fireReportCityForward(
  deps: GatewayDeps,
  kind: RoomKind,
  reportId: string,
  actorUserId: string,
  message: ChatMessageDTO,
): void {
  if (kind !== "report" || !deps.onReportMessage) return
  void deps.onReportMessage(reportId, message, actorUserId).catch(() => {})
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
  const targets = mentions.filter(
    (m) => !(deps.onChatReply && kind !== "dm" && m.id === replyTargetUserId),
  )
  if (targets.length === 0) return
  void mapWithLimit(targets, MENTION_BELL_CONCURRENCY, (m) =>
    chatMentions
      .notifyChatMention({ kind, roomId, actorUserId, mentionedUserId: m.id, message })
      .catch(() => {}),
  ).catch(() => {})
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
  peer: string | null,
  roomKey: string,
  message: ChatMessageDTO,
): void {
  if (kind !== "dm" || peer === null || !deps.onDmDelivered) return
  const { onDmDelivered, presence } = deps
  void (async () => {
    if (presence) {
      const online = await presence.online(roomKey)
      if (online.includes(peer)) return
    }
    await onDmDelivered(id, peer, message)
  })().catch(() => {})
}

async function handleTyping(session: GatewaySession, frame: ExtractFrame<"typing">): Promise<void> {
  const { conn, deps, userId } = session
  const kind = frameRoomKind(frame)
  const id = frame.cleanupId
  const roomKey = roomKeyFor(kind, id)
  const now = Date.now()
  const last = session.typingThrottle.get(roomKey) ?? 0
  if (now - last < TYPING_MIN_INTERVAL_MS) return
  session.typingThrottle.delete(roomKey)
  if (session.typingThrottle.size >= TYPING_THROTTLE_MAX_ROOMS) {
    const oldest: string | undefined = session.typingThrottle.keys().next().value
    if (oldest !== undefined) session.typingThrottle.delete(oldest)
  }
  session.typingThrottle.set(roomKey, now)
  const auth = await authorizeRoom(deps, kind, id, userId, kind === "report" || kind === "group")
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  await deps.chat.broadcastEvent?.(
    roomKey,
    { type: "typing", cleanupId: id, ...stampRoomKind(kind), userId },
    { excludeConnId: conn.id },
  )
}

async function handleAck(session: GatewaySession, frame: ExtractFrame<"ack">): Promise<void> {
  const { deps, userId } = session
  let kind: RoomKind
  let id: string
  if (frame.cleanupId !== undefined) {
    kind = frameRoomKind(frame)
    id = frame.cleanupId
  } else {
    if (session.joined.size !== 1) return
    const firstKey: string | undefined = session.joined.values().next().value
    if (firstKey === undefined) return
    const decoded = decodeRoomKey(firstKey)
    kind = decoded.kind
    id = decoded.id
  }
  if (!session.joined.has(roomKeyFor(kind, id))) return
  if (kind === "report") {
    if (deps.reportChat) await deps.reportChat.advanceReadWatermark(id, userId, frame.upToId)
    return
  }
  if (kind === "group") {
    if (deps.groupChat) {
      await deps.groupChat.advanceReadWatermark(id, userId, frame.upToId)
      selfSignalThreads(deps.userChannel, userId, id)
    }
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
  if (session.closed) return
  const limiter = (session.frameLimiter ??= makeTokenBucketLimiter(WS_FRAME_LIMIT))
  if (!limiter.tryConsume(session.conn.id)) {
    sendError(session.conn, ErrorCode.RATE_LIMITED, WS_FRAME_RATE_LIMITED_MESSAGE)
    return
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    sendError(session.conn, BAD_FRAME_CODE, "Malformed frame: not JSON.")
    return
  }
  const result = WsClientMessageSchema.safeParse(parsedJson)
  if (!result.success) {
    sendError(session.conn, BAD_FRAME_CODE, "Frame failed schema validation.")
    return
  }
  const frame = result.data
  await (dispatch[frame.type] as (s: GatewaySession, f: ClientFrame) => Promise<void>)(
    session,
    frame,
  )
}

export { serverFrame, sendError, decodeRoomKey }
