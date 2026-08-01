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
import {
  type GatewayDeps,
  type GatewaySession,
  TYPING_MIN_INTERVAL_MS,
  TYPING_THROTTLE_MAX_ROOMS,
  WS_FRAME_LIMIT,
} from "./types.js"
import { makeTokenBucketLimiter } from "./report-rate-limit.js"

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

/**
 * The authorization verdict for one room frame. `peer` rides ONLY the dm lane: `peerOf` both answers
 * participation and yields the peer the block gate needs, so handleSend hands that already-resolved id to
 * the dm bell instead of reading dm_threads a second time for the same send. Absent for every other kind
 * (and on the deny path) — a consumer that sees no peer must not infer one.
 */
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
    return ok ? { ok: true } : { ok: false, code: "FORBIDDEN", message: "You are not a member of this cleanup." }
  }
  if (kind === "report") {
    // Join is public: any authed socket that can SEE the report may open the room read-only.
    if (deps.reportVisible && !(await deps.reportVisible(id, userId))) {
      return { ok: false, code: "NOT_FOUND", message: "Report not found." }
    }
    // Posting / typing / presence require actual membership (Join button in the client).
    if (requireMember) {
      if (!deps.reportChat) {
        // No report membership source wired: FAIL CLOSED, exactly like the group lane below. This used
        // to fall through to `{ ok: true }`, so any wiring that forgot `reportChat` (an overrides-based
        // harness, a future partial deployment) silently LOST the member gate and turned a public
        // report room into a world-writable one — the gate has to be present to be relied on.
        return { ok: false, code: "FORBIDDEN", message: "Report chat is not available." }
      }
      if (!(await deps.reportChat.isMember(id, userId))) {
        return { ok: false, code: "FORBIDDEN", message: "Join this report chat to send messages." }
      }
    }
    return { ok: true }
  }
  if (kind === "group") {
    // P5: two gate levels keyed on `requireMember`. READ level (join): a member of any room OR a
    // non-member of a PUBLIC room (read-only presence join). SEND level (send/typing): must be a
    // member AND hold post permission — a channel's read-only members (canPost=false) get
    // channel_read_only; a public non-member gets the plain "not a member" 403.
    if (!deps.groupChat) {
      // No group deps wired (fake-chat/no-DB harnesses): FAIL CLOSED so a group frame can never
      // fall through to the dm lane below.
      return { ok: false, code: "FORBIDDEN", message: "Group chat is not available." }
    }
    const access = await deps.groupChat.access(id, userId)
    // Unknown group: uniform "not a member" 403 (no existence oracle, matching the pre-P5 stance).
    if (access === null) {
      return { ok: false, code: "FORBIDDEN", message: "You are not a member of this group." }
    }
    if (!requireMember) {
      // Read/join level: members always; non-members only when the room is public.
      if (access.isMember || access.visibility === "public") return { ok: true }
      return { ok: false, code: "FORBIDDEN", message: "You are not a member of this group." }
    }
    // Send/typing level: membership first (a public non-member reader can't post), then post power.
    if (!access.isMember) {
      return { ok: false, code: "FORBIDDEN", message: "You are not a member of this group." }
    }
    if (!access.canPost) {
      return { ok: false, code: "channel_read_only", message: "Only owners and admins can post in this channel." }
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
  return { ok: true, peer }
}

function selfSignalThreads(channel: UserChannel | undefined, userId: string, id: string): void {
  void channel?.publishToUser(userId, { topic: "threads", id }).catch(() => {})
}

/**
 * The join is authorized and then registered across three stores (room Set, presence, read state), each
 * an await — so `session.closed` is re-checked after every one of them. The close handler runs ONCE and
 * only leaves the rooms already in `session.joined`; anything this handler registers afterwards is
 * invisible to it and must be undone here (silently: a join that never announced needs no leave delta).
 */
async function handleJoin(session: GatewaySession, frame: ExtractFrame<"join">): Promise<void> {
  const { conn, deps, userId } = session
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const id = frame.cleanupId
  const auth = await authorizeRoom(deps, kind, id, userId)
  if (session.closed) return
  if (!auth.ok) {
    sendError(conn, auth.code, auth.message, { kind, id })
    return
  }
  const roomKey = roomKeyFor(kind, id)
  await deps.chat.joinRoom(roomKey, conn, userId)
  if (session.closed) {
    // Dead conn: drop it back out of the room so the room's Set can reach 0 and release its pub/sub
    // subscription. Not added to `joined` at all, so nothing else has to unwind.
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

/**
 * SECURITY (H6): `leave` is the ONE frame that must not consult authorizeRoom — it is the inverse of a
 * join, and a socket can only ever un-do a join THIS connection performed. Gating on the session's own
 * `joined` set is both stricter and cheaper than a membership query:
 *
 *   - It costs zero DB/Redis round trips for the (attacker) case of a room the socket never joined.
 *   - It closes the presence-injection hole: before this gate, a `{"type":"leave","roomKind":"dm",
 *     "cleanupId":"<someone else's thread>"}` frame reached presence.leave for a room the caller had no
 *     relationship with, and because `userGone` was derived from ABSENCE from the member list it was
 *     unconditionally true — forging a `presence/leave` delta for the attacker into any private DM,
 *     group or cleanup room and broadcasting it to every member. (The presence layer is hardened too,
 *     in RedisChatPresence.leave / InMemoryChatPresence.leave, so `userGone` now requires the ZREM to
 *     have actually removed a row. Both halves are needed: this one also stops the Redis publish.)
 *
 * An un-joined room is a SILENT no-op, not an error frame: leaving what you are not in is already the
 * caller's desired end state, and answering would leak whether the room exists.
 */
async function handleLeave(session: GatewaySession, frame: ExtractFrame<"leave">): Promise<void> {
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const roomKey = roomKeyFor(kind, frame.cleanupId)
  if (!session.joined.has(roomKey)) return
  await leaveRoomAndAnnounce(session, roomKey)
}

/**
 * SECURITY (H7): the message kinds a CLIENT may author over the wire.
 *
 * The shared `send` frame reuses the full ChatMessageKind enum, which also contains the two
 * SERVER-AUTHORED kinds:
 *   - "system" — platform/city timeline events (status changed, city replied, member joined). These are
 *     written by privileged paths as SENDER-LESS rows and render with platform/city chrome, so a member
 *     of any public report room could otherwise post
 *     `{"kind":"system","body":"Status updated to Resolved by the City of Los Angeles."}` and have it
 *     persist + broadcast as an official civic event — permanently uneditable and unpinnable, i.e. not
 *     even removable by the room's own moderation.
 *   - "poll" — poll rows are created by the P6 poll routes (which also write the chat_polls row); a
 *     hand-rolled poll message would be a body-less bubble with no poll behind it.
 *
 * Enforced HERE (the single gateway ingress for client-authored messages) rather than in the shared
 * schema because @civfix/shared is a separate repo on its own release train; narrowing
 * WsClientMessageSchema there is tracked as a follow-up and would be defense in depth, not the gate.
 */
const CLIENT_AUTHORABLE_KINDS: ReadonlySet<string> = new Set([
  "text",
  "share_pin",
  "task_complete",
  "rsvp_change",
])

async function handleSend(session: GatewaySession, frame: ExtractFrame<"send">): Promise<void> {
  const { conn, deps, userId } = session
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const id = frame.cleanupId
  // Reject a forged server-authored kind BEFORE any query or rate-limit spend (see the allowlist's note).
  if (frame.kind !== undefined && !CLIENT_AUTHORABLE_KINDS.has(frame.kind)) {
    sendError(conn, "BAD_FRAME", "That message kind can't be sent by a client.", { kind, id })
    return
  }
  if (containsSlur(frame.body)) {
    sendError(conn, "BLOCKED", "This contains language that isn't allowed.", { kind, id })
    return
  }
  const body = frame.body.trim()
  const carriesMedia = (frame.mediaUploadIds?.length ?? 0) > 0
  const isTextFrame = frame.kind === undefined || frame.kind === "text"
  if (body.length === 0 && !carriesMedia && isTextFrame) {
    sendError(conn, "BAD_FRAME", "A message needs text or an attachment.", { kind, id })
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
        body,
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
        clientId: frame.clientId,
        ...(mediaUploadIds && mediaUploadIds.length > 0 ? { mediaUploadIds } : {}),
        ...(frame.replyToId !== undefined ? { replyToId: frame.replyToId } : {}),
      })
    } else {
      message = await deps.chat.persist({
        cleanupId: id,
        roomKind: kind,
        userId,
        body,
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
    const handles = parseUserMentions(body)
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
  // The dm peer was already resolved by the authorization above (see RoomAuthorization.peer).
  fireDmBell(deps, kind, id, auth.peer ?? null, roomKey, message)
  fireReplyBell(deps, kind, id, userId, replyTargetUserId, message)
  fireReportCityForward(deps, kind, id, message)
  fireGroupFanOut(deps, kind, id, message)
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

/**
 * Fire the P4 4.5 group member bell fan-out (group-chat-notifier via the wiring's onGroupMessage) —
 * the group twin of fireReportCityForward's onReportMessage hook. Fire-and-forget like every other
 * post-send effect; the notifier itself owns the sender/present/muted/reply-target/mention dedupe.
 */
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

/**
 * The dm "delivered" bell. `peer` is the id authorizeRoom already resolved for THIS send (it had to read
 * dm_threads to authorize at all), so the bell costs no second read; a null peer means the caller had no
 * authorized dm peer and the bell is simply skipped. The gates are unchanged: dm rooms only, and never
 * for a peer currently present in the room.
 */
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
  const kind: RoomKind = frame.roomKind ?? "cleanup"
  const id = frame.cleanupId
  const roomKey = roomKeyFor(kind, id)
  // SECURITY (M13): the per-room typing throttle runs BEFORE authorizeRoom, so a client spamming typing
  // frames at a room costs ZERO membership queries and zero Redis round trips once the first one lands
  // within the window. (Ordering is safe: the throttle only ever suppresses a broadcast, and the
  // authorization gate below still runs for every frame that survives it.)
  const now = Date.now()
  const last = session.typingThrottle.get(roomKey) ?? 0
  if (now - last < TYPING_MIN_INTERVAL_MS) return
  // Bounded LRU (entries are only deleted on leave, and rooms typed at but never joined never leave):
  // re-inserting moves a key to the end, so the map's insertion order IS recency and the front entry is
  // the least-recently-used one to evict. Evicting a live room's entry costs one extra broadcast.
  session.typingThrottle.delete(roomKey)
  if (session.typingThrottle.size >= TYPING_THROTTLE_MAX_ROOMS) {
    const oldest: string | undefined = session.typingThrottle.keys().next().value
    if (oldest !== undefined) session.typingThrottle.delete(oldest)
  }
  session.typingThrottle.set(roomKey, now)
  // Typing carries the SAME restriction as send: report members-only, and group send-permission
  // (a read-only channel member must not emit typing) — so gate at send level for both.
  const auth = await authorizeRoom(
    deps,
    kind,
    id,
    userId,
    /* requireMember */ kind === "report" || kind === "group",
  )
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
    kind = frame.roomKind ?? "cleanup"
    id = frame.cleanupId
  } else {
    // Roomless ack (pre-multi-room clients): only unambiguous while the socket holds exactly ONE room.
    // With several joined, the room was whichever the `joined` Set happened to hold first — i.e. the
    // watermark landed on an arbitrary room. Ignore it instead; every current client stamps cleanupId.
    if (session.joined.size !== 1) return
    const firstKey: string | undefined = session.joined.values().next().value
    if (firstKey === undefined) return
    const decoded = decodeRoomKey(firstKey)
    kind = decoded.kind
    id = decoded.id
  }
  if (kind === "report") {
    if (deps.reportChat) await deps.reportChat.advanceReadWatermark(id, userId, frame.upToId)
    return
  }
  if (kind === "group") {
    // Member-scoped in the repo's WHERE (a non-member ack matches no chat_group_members row). The
    // threads self-signal mirrors dm/cleanup so an open inbox refreshes its unread badge.
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
  // A frame that arrives after (or during) close does nothing: every handler below would write to
  // stores the close pass has already unwound. Cheapest possible check, so it goes first.
  if (session.closed) return
  // SECURITY (M13): ONE bucket for EVERY inbound frame, spent BEFORE parsing and before dispatch — so a
  // throttled join/typing/ack costs zero DB and zero Redis round trips (and a malformed-frame flood
  // costs no schema validation either). `send` keeps its own tighter per-user+room bucket downstream;
  // this is the per-connection ceiling that used to be missing entirely. The bucket is created on first
  // use so no session can exist without one (see GatewaySession.frameLimiter).
  const limiter = (session.frameLimiter ??= makeTokenBucketLimiter(WS_FRAME_LIMIT))
  if (!limiter.tryConsume(session.conn.id)) {
    sendError(session.conn, "RATE_LIMITED", "You're sending frames too fast. Please slow down.")
    return
  }
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
