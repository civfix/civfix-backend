import {
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

const RD_ROOM_PREFIX = "rd:"

const REPORT_ROOM_PREFIX = "report:"

export function roomKeyFor(kind: RoomKind, id: string): string {
  if (kind === "dm") return `${DM_ROOM_PREFIX}${id}`
  if (kind === "report_discussion") return `${RD_ROOM_PREFIX}${id}`
  if (kind === "report") return `${REPORT_ROOM_PREFIX}${id}`
  return id
}

function decodeRoomKey(roomKey: string): { kind: RoomKind; id: string } {
  if (roomKey.startsWith(DM_ROOM_PREFIX)) {
    return { kind: "dm", id: roomKey.slice(DM_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(RD_ROOM_PREFIX)) {
    return { kind: "report_discussion", id: roomKey.slice(RD_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(REPORT_ROOM_PREFIX)) {
    return { kind: "report", id: roomKey.slice(REPORT_ROOM_PREFIX.length) }
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
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (kind === "cleanup") {
    const ok = await deps.isMember(id, userId)
    return ok ? { ok: true } : { ok: false, code: "FORBIDDEN", message: "You are not a member of this cleanup." }
  }
  if (kind === "report_discussion") {
    return { ok: true }
  }
  if (kind === "report") {
    if (deps.reportVisible && !(await deps.reportVisible(id, userId))) {
      return { ok: false, code: "NOT_FOUND", message: "Report not found." }
    }
    return { ok: true }
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
  if (kind !== "report_discussion" && kind !== "report" && deps.markReadOnOpen) {
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
  if (kind === "report_discussion") {
    sendError(conn, "UNSUPPORTED", "Discussion messages are posted over HTTP, not the socket.", { kind, id })
    return
  }
  if (containsSlur(frame.body)) {
    sendError(conn, "BLOCKED", "This contains language that isn't allowed.", { kind, id })
    return
  }
  if (kind === "report" && deps.reportSendLimiter && !deps.reportSendLimiter.tryConsume(`${userId}:${id}`)) {
    sendError(conn, "RATE_LIMITED", "You're sending messages too fast. Please slow down.", { kind, id })
    return
  }
  const auth = await authorizeRoom(deps, kind, id, userId)
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  const roomKey = roomKeyFor(kind, id)
  const mediaUploadIds = frame.mediaUploadIds
  let message: ChatMessageDTO
  if (kind === "dm") {
    message = await deps.dm!.persist({
      threadId: id,
      senderId: userId,
      body: frame.body,
      ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
      clientId: frame.clientId,
      ...(mediaUploadIds && mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
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
    })
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

  fireMentionBells(deps, kind, id, userId, mentions, message)
  fireThreadSignal(deps, kind, id, userId)
  fireDmBell(deps, kind, id, userId, roomKey, message)
  fireReportCityForward(deps, kind, id, message)
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
): void {
  if (!deps.chatMentions || mentions.length === 0) return
  const { chatMentions } = deps
  for (const m of mentions) {
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
  const auth = await authorizeRoom(deps, kind, id, userId)
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
  if (kind === "report_discussion" || kind === "report") return
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

export { serverFrame, sendError }
