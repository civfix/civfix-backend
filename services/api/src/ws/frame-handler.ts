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

/**
 * Send a `{type:"error"}` frame. Pass `room` for a room-scoped error so a client multiplexing several
 * rooms over one socket applies it (and any "stop re-joining" logic) only to the matching room. Omit
 * `room` for connection-level errors (auth / malformed frame). roomKind is stamped for any NON-cleanup
 * kind (absent ⇒ cleanup).
 */
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

/**
 * Stamp the optional `roomKind` discriminator on an outbound room-scoped frame. Cleanup is the implicit
 * default (omitted for backward compatibility); dm and report_discussion are stamped explicitly so a
 * client multiplexing several rooms over one socket routes the frame to the right room.
 */
function stampRoomKind(kind: RoomKind): { roomKind: RoomKind } | Record<string, never> {
  return kind === "cleanup" ? {} : { roomKind: kind }
}

const DM_ROOM_PREFIX = "dm:"

/**
 * Prefix that namespaces a report-discussion room key. A report discussion is a PUBLIC room (any
 * authenticated user may join to receive the live `{type:"discussion"}` signal); its writes go over HTTP,
 * never the socket.
 */
const RD_ROOM_PREFIX = "rd:"

/**
 * Map a frame's (roomKind, id) to the internal fan-out room key. Cleanup ids stay bare (backward
 * compatible); dm ids are namespaced `dm:<id>` and report-discussion ids `rd:<id>` so the three id spaces
 * can never collide in the presence/pubsub key space. EXPORTED so the discussion service computes the SAME
 * room key for its HTTP-side broadcast fan-out (single source of truth for the prefix).
 */
export function roomKeyFor(kind: RoomKind, id: string): string {
  if (kind === "dm") return `${DM_ROOM_PREFIX}${id}`
  if (kind === "report_discussion") return `${RD_ROOM_PREFIX}${id}`
  return id
}

function decodeRoomKey(roomKey: string): { kind: RoomKind; id: string } {
  if (roomKey.startsWith(DM_ROOM_PREFIX)) {
    return { kind: "dm", id: roomKey.slice(DM_ROOM_PREFIX.length) }
  }
  if (roomKey.startsWith(RD_ROOM_PREFIX)) {
    return { kind: "report_discussion", id: roomKey.slice(RD_ROOM_PREFIX.length) }
  }
  return { kind: "cleanup", id: roomKey }
}

/**
 * Leave a room AND announce a presence(leave) delta to the remaining members when this was the user's LAST
 * connection in the room. Shared by the explicit `leave` frame and socket `close`. Order: drop from the
 * message fan-out first (so the leave delta reaches only the OTHERS), then deregister presence and
 * broadcast the delta.
 */
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

/**
 * Authorize a room for a (kind, id). Cleanup: cleanup membership. DM: the user must be a thread participant
 * AND not blocked either way w.r.t. the peer (and the dm/block seams must be wired); the failure message
 * is the generic "can't message" copy so block and not-a-participant are not distinguished. Report
 * discussion: a PUBLIC room — any authenticated socket may join (the handshake already proved auth).
 */
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

/**
 * Self-signal `userId`'s inbox so the unread badge refetches AFTER the read watermark is applied. The
 * client's own post-ack /threads invalidation otherwise races the markRead and refetches the stale count,
 * re-sticking the badge (#42). Best-effort and fire-and-forget. Used by the mark-read-on-open and ack
 * read-state paths.
 */
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
  // Presence: register this connection, send the joiner the current online snapshot, and broadcast a join
  // DELTA to the OTHER members only on the user's FIRST connection in the room (a second tab/device must
  // not spam a redundant join). Frames carry the BARE id + roomKind so clients route them correctly.
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
  // Mark-read-on-open (#42): opening a conversation advances the joiner's read watermark to now, then
  // self-signals their inbox so the badge clears. The robust backstop for the stuck badge — the client
  // read-ack can be dropped on a quick/cold open, but `join` always fires on open (and on auto-rejoin).
  // report_discussion has no per-user read-state. Fully best-effort; the signal is chained AFTER
  // markReadOnOpen so the /threads refetch only fires once the watermark is applied (else it re-sticks).
  if (kind !== "report_discussion" && deps.markReadOnOpen) {
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
  // Report discussion is read-only over the socket: its writes go over HTTP, and there is no persist seam
  // here. Refuse a `send` for it explicitly so it never falls through to the cleanup persist branch.
  if (kind === "report_discussion") {
    sendError(conn, "UNSUPPORTED", "Discussion messages are posted over HTTP, not the socket.", { kind, id })
    return
  }
  // Hate-slur content gate (App Store 1.2a). A hit REJECTS the send (never persisted/broadcast/acked) with
  // a room-scoped error frame — the WS analogue of the discussion-service 422 (a thrown AppError here would
  // be swallowed into a generic INTERNAL frame). Body-less media-only sends (body === "") pass.
  if (containsSlur(frame.body)) {
    sendError(conn, "BLOCKED", "This contains language that isn't allowed.", { kind, id })
    return
  }
  const auth = await authorizeRoom(deps, kind, id, userId)
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  const roomKey = roomKeyFor(kind, id)
  // Persist first so the broadcast + ack carry the durable id/createdAt. Route by kind: cleanup → chat
  // seam; dm → dm seam (the block re-check already ran in authorizeRoom). The persist seam binds the
  // finalized media uploads and returns the presigned attachments on the DTO.
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
      roomKind: "cleanup",
      userId,
      body: frame.body,
      ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
      clientId: frame.clientId,
      ...(mediaUploadIds && mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
    })
  }
  // USER @-mentions: resolve @handles + the frame's mentionedUserIds (self excluded), persist them, and
  // project them onto the DTO so the broadcast + ack already carry message.mentions. All AFTER persist; a
  // resolve/record failure degrades to "no mentions" rather than failing the send.
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

  // Broadcast to the room EXCEPT this sender's socket (P1-2): the sender reconciles its optimistic bubble
  // from the ack alone, so excluding it from the fan-out prevents a double render. Other members (and the
  // sender's OTHER devices) still receive the message frame.
  await deps.chat.broadcast(roomKey, message, { excludeConnId: conn.id })
  // The sender's ONLY copy of the message (exactly-once delivery to the sender).
  conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message }))

  fireMentionBells(deps, kind, id, userId, mentions, message)
  fireThreadSignal(deps, kind, id, userId)
  fireDmBell(deps, kind, id, userId, roomKey, message)
}

/**
 * Best-effort per-mentioned-user bell. Runs after the message is durably persisted + delivered + acked, so
 * a notify failure must NEVER affect the send path. The wiring applies block + pref gating.
 */
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

/**
 * Best-effort thread-unread signal: fire a `{topic:"threads", id}` invalidate-signal to the recipients (so
 * a participant WITHOUT the room open gets an unread bump). Fire-and-forget — runs after the message is
 * durably persisted + delivered + acked, so a resolver/publish failure must NEVER affect the send path.
 */
function fireThreadSignal(deps: GatewayDeps, kind: RoomKind, id: string, senderId: string): void {
  if (!deps.userChannel || !deps.threadRecipientsOf) return
  const { userChannel, threadRecipientsOf } = deps
  void (async () => {
    const recipients = await threadRecipientsOf(kind, id, senderId)
    if (recipients.length === 0) return
    await userChannel.publishToUsers(recipients, { topic: "threads", id })
  })().catch(() => {})
}

/**
 * Best-effort dm BELL notification for the PEER, but ONLY when the peer is NOT actively viewing this dm
 * room (the literal #42 complaint): a live presence entry on the namespaced dm room key means they are
 * reading the message right now, so a bell would be noise. peerOf excludes the sender. Fire-and-forget —
 * a presence/notify failure must NEVER affect the send path.
 */
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
  // Server-side throttle backstop: drop typing fan-outs more frequent than TYPING_MIN_INTERVAL_MS for this
  // connection+room, regardless of what the client sends.
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
  // Route by (roomKind, cleanupId) when present (a socket joined to both a cleanup and a dm marks the right
  // one); else fall back to the socket's FIRST joined room (legacy single-room behavior).
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
  // A report discussion has no per-user read-state (it is a public signal room, not an inbox).
  if (kind === "report_discussion") return
  if (kind === "dm") {
    // Gate the write on participation: an ack carries an arbitrary thread id and the dm markRead is an
    // unconditional upsert, so without this any authenticated socket could write dm_read_state rows for
    // threads it isn't in. peerOf returns null for a non-participant.
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

/**
 * Handle ONE inbound client frame for a session. All effects are sends/persist/broadcast/room changes; it
 * never throws on bad input — a non-JSON or schema-invalid frame yields a single error frame.
 */
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
