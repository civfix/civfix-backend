/**
 * WebSocket chat gateway, mounted at GET /ws via @fastify/websocket.
 *
 * ORIGIN ALLOWLIST (anti-CSWSH): the cookie handshake path (a) is vulnerable to Cross-Site WebSocket
 * Hijacking because the browser attaches the httpOnly session cookie to a cross-origin ws() connection
 * automatically (the CORS preflight does NOT apply to WebSocket upgrades). So BEFORE resolving auth we
 * check the upgrade request's Origin header against the configured WEB_ORIGINS allowlist (same policy
 * as the CORS plugin): an Origin that is present is allowed; a cross-site Origin is REJECTED with a
 * policy-violation close. An empty allowlist (dev-only) allows all origins, mirroring the CORS plugin's
 * documented dev convenience.
 *
 * NO-ORIGIN HANDLING (P1-4): a handshake with NO Origin header is treated differently per credential:
 *   - When a SESSION COOKIE is present on the upgrade (the ambient-cookie / browser path), we REQUIRE a
 *     present, allowlisted Origin and REJECT a missing one. A real browser ALWAYS sends an Origin on a
 *     ws() upgrade, so the only way to reach the cookie path with no Origin is a non-browser client
 *     replaying a stolen cookie - exactly the CSWSH-adjacent case we want to deny. This makes the Origin
 *     gate a genuine second factor for the cookie path.
 *   - When NO session cookie is present (native mobile RN socket carrying its bearer in ?token,
 *     server-to-server, tests), a missing Origin is ALLOWED: those carry no ambient cookie so they are
 *     not CSWSH-exposed, and the bearer/?token path (b) still validates the credential.
 * Documented clearly so a re-reviewer sees the no-Origin allowance is deliberately scoped to the
 * cookie-less bearer path, not a blanket bypass.
 *
 * DUAL HANDSHAKE AUTH (the web and mobile clients differ):
 *   (a) COOKIE (web, same-origin SPA): the httpOnly session cookie is sent automatically on the upgrade
 *       request, so the auth onRequest hook already resolved req.auth from it. We accept that (after the
 *       Origin allowlist check above has cleared the cross-site-hijack risk).
 *   (b) ?token=<bearer> QUERY PARAM (mobile): a React Native WebSocket cannot set an Authorization
 *       header, so the native client passes its bearer token as a query parameter. We resolve it via
 *       session-service.resolveSession during the handshake.
 *   Resolution order: prefer an already-resolved cookie/bearer session on req.auth; otherwise fall back
 *   to the ?token query. A handshake that resolves to no user is REJECTED (the socket is closed with a
 *   policy-violation code and a single {type:"error"} frame), so unauthenticated sockets never join.
 *
 * MEMBERSHIP-GATED ROOMS: chat membership == cleanup membership. join/send verify the user is a
 * cleanup_member (via the injected isMember probe) before the ChatService admits the socket or accepts a
 * message. A non-member's join/send is answered with an {type:"error"} frame and ignored.
 *
 * FRAME HANDLING is split out as handleClientFrame(session, raw) so the persist+broadcast+ack and
 * membership-gating logic is unit-testable with mock ChatConnections, independent of a real socket. The
 * Fastify handler is a thin adapter: it wraps the raw ws socket as a ChatConnection, validates the
 * handshake, forwards messages to handleClientFrame, runs a heartbeat, and cleans up on close.
 *
 * Inbound frames are validated against WsClientMessageSchema; malformed frames are answered with an
 * error frame and never crash the socket. Outbound frames conform to WsServerMessageSchema.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import { WsClientMessageSchema, type RoomKind, type WsServerMessage } from "@civfix/shared"
import type { ChatService, ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import type { SessionService } from "../auth/session-service.js"
import type { ChatPresence } from "../adapters/chat-presence.js"
import { presentedSessionToken, SESSION_COOKIE } from "../auth/transport.js"
import { isProd } from "../env.js"
import { randomUUID } from "node:crypto"

/** Heartbeat interval (ms): ping idle sockets so dead connections are detected and reaped. */
export const WS_HEARTBEAT_MS = 30_000

/** Close code used when a handshake is unauthenticated (RFC 6455 policy violation). */
export const WS_CLOSE_POLICY_VIOLATION = 1008

/**
 * Server-side typing throttle (ms): a backstop against a chatty/abusive client. At most one typing
 * fan-out per room per connection in this window; the clients also throttle, but we never trust them.
 */
export const TYPING_MIN_INTERVAL_MS = 1000

/**
 * Decide whether a WebSocket upgrade Origin is allowed (anti-CSWSH). Pure so it is unit-testable with no
 * socket. `hasSessionCookie` is whether the upgrade presented an ambient session cookie. Policy (mirrors
 * the CORS plugin, with the P1-4 cookie-path tightening):
 *   - empty allowlist -> ALLOW all (dev-only convenience; the CORS plugin logs this same condition).
 *   - no Origin header (undefined/empty):
 *       * WITH a session cookie -> REJECT. The ambient-cookie path must carry a present, allowlisted
 *         Origin; a real browser always sends one, so a missing Origin here is a non-browser client
 *         replaying a stolen cookie. This is the CSWSH second factor.
 *       * WITHOUT a session cookie -> ALLOW. Native mobile / server-to-server / tests send no Origin and
 *         carry no ambient cookie, so they are not hijack-exposed; the bearer/?token path still validates.
 *   - Origin present in the allowlist -> ALLOW (exact string match, as browsers send a normalized
 *     scheme://host[:port] with no trailing slash).
 *   - any other Origin -> REJECT (a cross-site page trying to ride the session cookie).
 */
export function isAllowedWsOrigin(
  origin: string | undefined,
  webOrigins: readonly string[],
  hasSessionCookie = false,
): boolean {
  // An empty allowlist disables the anti-CSWSH gate, so allow it ONLY outside production (dev convenience),
  // matching the CORS plugin's fail-closed-in-prod behavior. In prod env.ts already requires WEB_ORIGINS
  // to be non-empty at boot, so this is belt-and-suspenders against a regression that empties it.
  if (webOrigins.length === 0) return !isProd()
  if (origin === undefined || origin === "") {
    // Allow a missing Origin ONLY for the cookie-less (bearer/native) path; the cookie path must carry
    // an allowlisted Origin so the gate is a real second factor against CSWSH.
    return !hasSessionCookie
  }
  return webOrigins.includes(origin)
}

/** Read the (single) Origin header from an upgrade request, or undefined when absent. */
function originHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers.origin
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === "" ? undefined : value
}

/** Whether the upgrade request presents an ambient session cookie (the CSWSH-exposed path). */
function wsHasSessionCookie(request: FastifyRequest): boolean {
  const cookie = request.cookies?.[SESSION_COOKIE]
  return typeof cookie === "string" && cookie.length > 0
}

/** Membership probe: is `userId` a member of `cleanupId`? (cleanup membership == chat membership). */
export type IsMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

/** Optional read-state updater (per-user last-read), used by the `ack` frame. No-op when omitted. */
export type MarkReadFn = (cleanupId: string, userId: string, upToId: string) => Promise<void>

/**
 * The DM seam the gateway drives for `roomKind:"dm"` frames. It mirrors the cleanup seams but is
 * addressed by thread id: an isParticipant membership probe, a persist (returns the broadcastable DTO),
 * a markRead watermark, and a peerOf lookup (the OTHER participant) so block checks can run before a join
 * or send. Optional on GatewayDeps so the cleanup-only tests and the legacy path need not wire it; the
 * frame handler falls back to refusing dm frames when it is absent.
 */
export interface GatewayDmDeps {
  /** Whether `userId` is one of the dm thread's two participants. */
  isParticipant(threadId: string, userId: string): Promise<boolean>
  /** The OTHER participant of the thread (for the block check), or null when `userId` is not in it. */
  peerOf(threadId: string, userId: string): Promise<string | null>
  /** Persist a dm message and return the broadcastable ChatMessageDTO (roomKind:"dm", cleanupId=thread). */
  persist(input: {
    threadId: string
    senderId: string
    body: string
    kind?: import("@civfix/shared").ChatMessageKind
    clientId?: string
  }): Promise<import("@civfix/shared").ChatMessageDTO>
  /** Record that `userId` read `threadId` up to message `upToId` (monotonic). */
  markRead(threadId: string, userId: string, upToId: string): Promise<void>
}

/** Bidirectional block check: is `a` blocked by `b` or vice versa? Used to gate dm join/send. */
export type IsBlockedEitherWayFn = (a: string, b: string) => Promise<boolean>

/**
 * Resolve the per-user signal recipients for a freshly-persisted message in room `(kind, id)`, EXCLUDING
 * the sender. Lets the gateway fire a `{topic:"threads", id}` invalidate-signal to participants who do not
 * have the room open WITHOUT importing any repo (the caller wires the cleanup-members / dm-peer lookup).
 * Returns an empty list when there is no one else to signal. Best-effort: a failure here must never affect
 * the send path.
 */
export type ThreadRecipientsOf = (
  kind: RoomKind,
  id: string,
  senderId: string,
) => Promise<string[]>

/**
 * The ChatService the gateway drives. Identical to the shared ChatService except `broadcast` accepts an
 * OPTIONAL excludeConnId so the gateway can keep the sender out of the broadcast fan-out (it learns
 * durability from the ack instead, P1-2). A 2-arg ChatService.broadcast is assignable here (fewer
 * params), so both the real WsChatService (which uses the hint) and the FakeChatService (which ignores
 * the extra arg) satisfy this type without any change to the frozen shared interface.
 */
export type GatewayChatService = Omit<ChatService, "broadcast"> & {
  broadcast(
    cleanupId: string,
    msg: Parameters<ChatService["broadcast"]>[1],
    opts?: { excludeConnId?: string },
  ): Promise<void>
}

/** The dependencies the gateway frame handler needs (no Fastify/socket types here so it stays testable). */
export interface GatewayDeps {
  chat: GatewayChatService
  isMember: IsMemberFn
  markRead?: MarkReadFn | undefined
  /** Optional presence registry: tracks who is online per room and powers presence snapshots/deltas. */
  presence?: ChatPresence | undefined
  /** Optional DM seam: membership/persist/read-state for `roomKind:"dm"` frames. Absent ⇒ dm refused. */
  dm?: GatewayDmDeps | undefined
  /** Optional bidirectional block check, gating dm join/send (refuses when blocked either way). */
  isBlockedEitherWay?: IsBlockedEitherWayFn | undefined
  /** Optional per-user signal channel: fires a `{topic:"threads"}` invalidate-signal on a new message. */
  userChannel?: UserChannel | undefined
  /** Optional resolver for the message recipients to signal (excludes the sender). Wired in chat.routes. */
  threadRecipientsOf?: ThreadRecipientsOf | undefined
}

/**
 * Per-connection session: the authenticated user, the wrapped connection, the set of rooms this socket
 * has joined (so close can leave them all), the deps, and a per-room typing throttle clock. One is
 * created per socket.
 */
export interface GatewaySession {
  readonly userId: string
  readonly conn: ChatConnection
  readonly joined: Set<string>
  readonly deps: GatewayDeps
  /** Per-room last typing-broadcast epoch ms (server-side throttle). Mutated in place. */
  readonly typingThrottle: Map<string, number>
}

/** Build a server frame as a JSON string (typed against the shared server-frame union). */
function serverFrame(frame: WsServerMessage): string {
  return JSON.stringify(frame)
}

/**
 * Send an {type:"error"} frame. When the error is room-scoped (a rejected join/send/typing for a
 * specific room) pass `room` so the frame carries the bare room id + roomKind: a client multiplexing
 * several rooms over ONE socket then applies the error (and any "stop re-joining this room" logic) only
 * to the matching room, never to a healthy sibling. Omit `room` for connection-level errors (auth /
 * malformed frame). roomKind is stamped only for dm (absent ⇒ cleanup), matching the other frames.
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
      ...(room ? { cleanupId: room.id, ...(room.kind === "dm" ? { roomKind: "dm" as const } : {}) } : {}),
    }),
  )
}

/** Prefix that namespaces a dm thread's fan-out room key so dm and cleanup ids can never collide. */
const DM_ROOM_PREFIX = "dm:"

/**
 * Map a frame's (roomKind, id) to the internal fan-out room key. Cleanup ids stay bare (backward
 * compatible); dm ids are namespaced `dm:<id>` so the presence/pubsub key space is partitioned and a dm
 * thread id can never collide with a cleanup id. The presence adapter keys off whatever room id we pass,
 * so passing the namespaced key gives dm threads their own presence/typing space automatically.
 */
function roomKeyFor(kind: RoomKind, id: string): string {
  return kind === "dm" ? `${DM_ROOM_PREFIX}${id}` : id
}

/** Recover the (roomKind, bare id) a stored room key represents (the inverse of roomKeyFor). */
function decodeRoomKey(roomKey: string): { kind: RoomKind; id: string } {
  return roomKey.startsWith(DM_ROOM_PREFIX)
    ? { kind: "dm", id: roomKey.slice(DM_ROOM_PREFIX.length) }
    : { kind: "cleanup", id: roomKey }
}

/**
 * Leave a room AND announce a presence(leave) delta to the remaining members when this was the user's
 * LAST connection in the room. Shared by the explicit `leave` frame and the socket `close` cleanup so
 * both paths drop the room AND deregister presence (otherwise a closed socket would linger as "online"
 * until its TTL pruned it). Order: drop from the message fan-out first (the conn is gone from the room,
 * so the leave delta below reaches only the OTHERS), then deregister presence and broadcast the delta.
 */
async function leaveRoomAndAnnounce(session: GatewaySession, roomKey: string): Promise<void> {
  const { conn, deps, userId } = session
  const { kind, id } = decodeRoomKey(roomKey)
  // Fan-out + presence are keyed by the namespaced roomKey; the presence frame carries the BARE id +
  // roomKind so clients route it to the right (cleanup|dm) room.
  await deps.chat.leaveRoom(roomKey, conn)
  session.joined.delete(roomKey)
  session.typingThrottle.delete(roomKey)
  if (deps.presence) {
    const { userGone } = await deps.presence.leave(roomKey, conn.id, userId)
    if (userGone) {
      await deps.chat.broadcastEvent?.(roomKey, {
        type: "presence",
        cleanupId: id,
        ...(kind === "dm" ? { roomKind: kind } : {}),
        userId,
        state: "leave",
      })
    }
  }
}

/**
 * Authorize a room for a (kind, id). Returns { ok:true } when the user may join/send, else { ok:false }
 * with the error code/message to send. Cleanup: cleanup membership (existing isMember). DM: the user must
 * be a thread participant AND not blocked either way w.r.t. the peer (and the dm/block seams must be
 * wired). The dm failure message is intentionally the generic "no longer reach" copy so block and
 * not-a-participant are not distinguished. NOTE: cleanup group chat behavior is unchanged.
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
  // dm
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
 * Handle ONE inbound client frame for a session. Returns nothing; all effects are sends/persist/
 * broadcast/room changes. This is the unit-tested core of the gateway:
 *   - parse + validate against WsClientMessageSchema; a malformed frame -> a single error frame, no throw.
 *   - each frame carries an OPTIONAL roomKind (absent ⇒ "cleanup"); the room id travels in `cleanupId`
 *     (a dm thread id for roomKind:"dm"). The internal fan-out/presence room key is roomKeyFor(kind, id):
 *     cleanup ids stay bare, dm ids are namespaced `dm:<id>` so the two id spaces never collide.
 *   - join: authorize the room (cleanup membership OR dm participant+not-blocked), then ChatService.joinRoom
 *     under the room key + a presence snapshot to the joiner's own socket (frames carry the bare id + roomKind).
 *   - leave: ChatService.leaveRoom under the room key.
 *   - send: authorize, persist (cleanup → chat seam; dm → dm seam, with a fresh block re-check), broadcast
 *     under the room key EXCEPT the sender's socket, and ack the SENDER (the sender's exactly-once copy; P1-2).
 *   - typing: authorize, then broadcast a typing frame under the room key (best-effort, carries id + roomKind).
 *   - ack: route by (roomKind, cleanupId) when present, else the socket's first joined room; markRead routes
 *     by kind (cleanup → cleanup read-state; dm → dm read-state).
 */
export async function handleClientFrame(session: GatewaySession, raw: string): Promise<void> {
  const { conn, deps, userId } = session

  // Parse JSON defensively: a non-JSON frame is malformed.
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    sendError(conn, "BAD_FRAME", "Malformed frame: not JSON.")
    return
  }

  // Validate against the shared client-frame union. An unknown type / missing field -> error frame.
  const result = WsClientMessageSchema.safeParse(parsedJson)
  if (!result.success) {
    sendError(conn, "BAD_FRAME", "Frame failed schema validation.")
    return
  }
  const frame = result.data

  switch (frame.type) {
    case "join": {
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
      // Presence (when a registry is wired): register this connection, send the joiner the CURRENT online
      // snapshot so it can render "N online" immediately, and broadcast a join DELTA to the OTHER members
      // only when this is the user's FIRST connection in the room (so opening a second tab/device does not
      // spam a redundant join). The joiner is excluded from the delta - it already has the snapshot. The
      // presence frames carry the BARE id + roomKind so clients route them to the right (cleanup|dm) room.
      if (deps.presence) {
        const { online, userJoined } = await deps.presence.join(roomKey, conn.id, userId)
        conn.send(
          serverFrame({
            type: "presence_snapshot",
            cleanupId: id,
            ...(kind === "dm" ? { roomKind: kind } : {}),
            userIds: online,
          }),
        )
        if (userJoined) {
          await deps.chat.broadcastEvent?.(
            roomKey,
            {
              type: "presence",
              cleanupId: id,
              ...(kind === "dm" ? { roomKind: kind } : {}),
              userId,
              state: "join",
            },
            { excludeConnId: conn.id },
          )
        }
      }
      return
    }

    case "leave": {
      const kind: RoomKind = frame.roomKind ?? "cleanup"
      await leaveRoomAndAnnounce(session, roomKeyFor(kind, frame.cleanupId))
      return
    }

    case "send": {
      const kind: RoomKind = frame.roomKind ?? "cleanup"
      const id = frame.cleanupId
      const auth = await authorizeRoom(deps, kind, id, userId)
      if (!auth.ok) {
        sendError(conn, auth.code, auth.message, { kind, id })
        return
      }
      const roomKey = roomKeyFor(kind, id)
      // Persist first so the broadcast + ack carry the durable id/createdAt (the optimistic client
      // reconciles its temporary clientId against the server message). Route persistence by kind:
      // cleanup → the chat seam; dm → the dm seam (the block re-check already ran in authorizeRoom).
      let message: import("@civfix/shared").ChatMessageDTO
      if (kind === "dm") {
        // dm seam must be wired (authorizeRoom already refused dm when it is absent).
        message = await deps.dm!.persist({
          threadId: id,
          senderId: userId,
          body: frame.body,
          ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
          clientId: frame.clientId,
        })
      } else {
        message = await deps.chat.persist({
          cleanupId: id,
          roomKind: "cleanup",
          userId,
          body: frame.body,
          ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
          clientId: frame.clientId,
        })
      }
      // Broadcast to the room EXCEPT this sender's socket (P1-2): the sender would otherwise get both the
      // broadcast {type:"message"} frame AND the {type:"ack"} below for the same id and render it twice.
      // excludeConnId keeps the sender out of the fan-out; the sender reconciles its optimistic bubble
      // from the ack alone. Other members (and the sender's OTHER devices, which are different
      // connections) still receive the message frame. The DTO already carries cleanupId=id + roomKind.
      await deps.chat.broadcast(roomKey, message, { excludeConnId: conn.id })
      // Ack the SENDER directly with the clientId so its optimistic bubble is reconciled. This is the
      // sender's ONLY copy of the message (exactly-once delivery to the sender).
      conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message }))
      // Best-effort thread-unread signal: fire a {topic:"threads", id} invalidate-signal to the message
      // recipients (so a participant WITHOUT the room open gets an unread bump). Fully fire-and-forget —
      // it runs after the message is durably persisted + delivered + acked, so a resolver/publish failure
      // must NEVER affect the send path. Only emit when both the channel and the resolver are wired.
      if (deps.userChannel && deps.threadRecipientsOf) {
        const { userChannel, threadRecipientsOf } = deps
        void (async () => {
          const recipients = await threadRecipientsOf(kind, id, userId)
          if (recipients.length === 0) return
          await userChannel.publishToUsers(recipients, { topic: "threads", id })
        })().catch(() => {})
      }
      return
    }

    case "typing": {
      // A member is typing: fan a {type:"typing"} frame to the OTHER members (the sender is excluded) over
      // the dedicated broadcastEvent channel - it carries an ephemeral, un-persisted frame, so it never
      // touches the message stream or history. A non-member / non-participant must not even signal typing.
      const kind: RoomKind = frame.roomKind ?? "cleanup"
      const id = frame.cleanupId
      const auth = await authorizeRoom(deps, kind, id, userId)
      if (!auth.ok) {
        sendError(conn, auth.code, auth.message, { kind, id })
        return
      }
      const roomKey = roomKeyFor(kind, id)
      // Server-side throttle backstop: drop typing fan-outs more frequent than TYPING_MIN_INTERVAL_MS for
      // this connection+room, regardless of what the client sends.
      const now = Date.now()
      const last = session.typingThrottle.get(roomKey) ?? 0
      if (now - last < TYPING_MIN_INTERVAL_MS) return
      session.typingThrottle.set(roomKey, now)
      await deps.chat.broadcastEvent?.(
        roomKey,
        {
          type: "typing",
          cleanupId: id,
          ...(kind === "dm" ? { roomKind: kind } : {}),
          userId,
        },
        { excludeConnId: conn.id },
      )
      return
    }

    case "ack": {
      // Update per-user read state (OPTIONAL; drives the threads unread count). Route by (roomKind,
      // cleanupId) when the frame carries them (a socket joined to BOTH a cleanup and a dm thread marks
      // the right one); otherwise fall back to the socket's FIRST joined room (legacy single-room
      // behavior). markRead routes by kind: cleanup → the cleanup read-state seam; dm → the dm read-state
      // seam. No-op when neither seam is wired / there is nothing to mark.
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
      if (kind === "dm") {
        // Gate the write on participation: an ack carries an arbitrary thread id and the dm markRead is an
        // unconditional upsert, so without this any authenticated socket could write dm_read_state rows for
        // threads it isn't in (an authorization asymmetry with the self-gating cleanup path). peerOf returns
        // null for a non-participant.
        if (deps.dm && (await deps.dm.peerOf(id, userId)) !== null) {
          await deps.dm.markRead(id, userId, frame.upToId)
        }
      } else if (deps.markRead) {
        await deps.markRead(id, userId, frame.upToId)
      }
      return
    }
  }
}

/**
 * Subscribe an authenticated socket's user on the per-user signal channel for the socket's lifetime
 * (independent of any room join), so the backend can push invalidate-signals to this client. Returns the
 * unsubscribe handle to dispose on socket close, or undefined when no channel is wired or the subscribe
 * failed. BEST-EFFORT: a subscribe failure is logged and swallowed (returns undefined) so the handshake
 * still completes and the socket serves chat — the per-user channel is a freshness layer, not a gate.
 * Extracted (like handleClientFrame) so the subscribe/disposal lifecycle is unit-testable with a mock
 * ChatConnection and a FakeUserChannel, independent of a real socket.
 */
export async function subscribeUserChannel(
  userChannel: UserChannel | undefined,
  userId: string,
  conn: ChatConnection,
  logger?: Pick<FastifyBaseLogger, "warn">,
): Promise<(() => Promise<void>) | undefined> {
  if (!userChannel) return undefined
  try {
    return await userChannel.subscribeUser(userId, conn)
  } catch (err) {
    logger?.warn({ err, userId }, "ws: user-channel subscribe failed (continuing)")
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Fastify adapter (binds a raw ws socket to a GatewaySession)
// ---------------------------------------------------------------------------

/** Wrap a raw ws WebSocket as the vendor-neutral ChatConnection the ChatService consumes. */
function wrapSocket(socket: WebSocket): ChatConnection {
  const id = randomUUID()
  return {
    id,
    send(data: string): void {
      // Only write to an OPEN socket; ws readyState 1 === OPEN.
      if (socket.readyState === 1) socket.send(data)
    },
  }
}

/**
 * Resolve the authenticated user id for a WS handshake. Prefers an already-resolved session on req.auth
 * (cookie web transport, or a bearer that the auth hook honored). Falls back to the ?token query param
 * (mobile), resolving it via the session service. Returns null when neither yields a user.
 */
export async function resolveWsUser(
  request: FastifyRequest,
  sessions: SessionService | undefined,
): Promise<string | null> {
  // (a) Cookie/bearer already resolved by the auth onRequest hook.
  const fromContext = request.auth?.userId ?? null
  if (fromContext !== null) return fromContext

  // (b) ?token=<bearer> query param (mobile RN WebSocket cannot set headers).
  const query = request.query as { token?: unknown } | undefined
  const token = typeof query?.token === "string" && query.token.length > 0 ? query.token : null
  // Also accept a bearer presented the normal way, in case a non-RN client can set the header.
  const presented = token ?? presentedSessionToken(request)
  if (presented && sessions) {
    const resolved = await sessions.resolveSession(presented)
    if (resolved) return resolved.userId
  }
  return null
}

/**
 * The outcome of validating a WS upgrade handshake: either an accepted user, or a rejection carrying
 * the error-frame code + a close reason. Split out (like resolveWsUser) so BOTH gates - the anti-CSWSH
 * Origin allowlist and the dual auth - are unit-testable with a synthetic request, no live socket.
 */
export type WsHandshakeResult =
  | { ok: true; userId: string }
  | { ok: false; code: "FORBIDDEN" | "UNAUTHORIZED"; message: string; reason: string }

/**
 * Validate a WS upgrade handshake. Order matters:
 *   1) Origin allowlist (anti-CSWSH): a cross-site Origin is rejected BEFORE the cookie is consulted, so
 *      a hijacking page can never ride the ambient session cookie.
 *   2) Auth: resolve the user from the already-resolved cookie/bearer session or the ?token query.
 * Returns a structured result; the Fastify adapter turns a rejection into an error frame + close.
 */
export async function checkWsHandshake(
  request: FastifyRequest,
  opts: { sessions: SessionService | undefined; webOrigins: readonly string[] },
): Promise<WsHandshakeResult> {
  // The Origin gate is stricter when an ambient session cookie is present (P1-4): a cookie handshake
  // MUST carry an allowlisted Origin (a real browser always does), so a missing Origin on the cookie
  // path is rejected; the bearer/?token (cookie-less) path stays Origin-optional.
  const hasSessionCookie = wsHasSessionCookie(request)
  if (!isAllowedWsOrigin(originHeader(request), opts.webOrigins, hasSessionCookie)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Origin not allowed.",
      reason: "origin not allowed",
    }
  }
  const userId = await resolveWsUser(request, opts.sessions)
  if (userId === null) {
    return {
      ok: false,
      code: "UNAUTHORIZED",
      message: "Authentication required.",
      reason: "unauthenticated",
    }
  }
  return { ok: true, userId }
}

export interface RegisterGatewayOptions {
  /** The chat service (real WsChatService in production, or the fake). */
  chat: ChatService
  /** Membership probe (cleanup membership == chat membership). */
  isMember: IsMemberFn
  /** Session service for resolving the ?token query param (mobile). */
  sessions: SessionService | undefined
  /** Optional read-state updater for the `ack` frame (cleanup chat). */
  markRead?: MarkReadFn | undefined
  /** Optional presence registry: powers presence snapshots/deltas and is refreshed by the heartbeat. */
  presence?: ChatPresence | undefined
  /** Optional DM seam: membership/persist/read-state for `roomKind:"dm"` frames. */
  dm?: GatewayDmDeps | undefined
  /** Optional bidirectional block check, gating dm join/send. */
  isBlockedEitherWay?: IsBlockedEitherWayFn | undefined
  /**
   * Optional per-user signal channel. When wired, every authenticated socket subscribes its user on the
   * channel for the socket's lifetime (so the backend can push invalidate-signals to the client), and the
   * `send` handler fires a `{topic:"threads"}` signal to the message recipients. Optional so existing
   * tests that only exercise chat need not wire it.
   */
  userChannel?: UserChannel | undefined
  /** Optional resolver for the thread-signal recipients (excludes the sender). See ThreadRecipientsOf. */
  threadRecipientsOf?: ThreadRecipientsOf | undefined
  /** CORS/WS Origin allowlist (env.WEB_ORIGINS). Empty allows all (dev). See isAllowedWsOrigin. */
  webOrigins: readonly string[]
}

/**
 * Register GET /ws. Requires @fastify/websocket to be registered on the app already. Authenticates the
 * handshake (cookie or ?token), then drives the session through handleClientFrame and a heartbeat.
 */
export function registerChatGateway(app: FastifyInstance, opts: RegisterGatewayOptions): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    void (async () => {
      // Validate the handshake: Origin allowlist (anti-CSWSH) THEN dual auth. A rejection is closed with
      // one error frame + policy-violation; nothing past this point runs for a disallowed/unauthed socket.
      const handshake = await checkWsHandshake(request, {
        sessions: opts.sessions,
        webOrigins: opts.webOrigins,
      })
      if (!handshake.ok) {
        if (handshake.code === "FORBIDDEN") {
          request.log.warn({ origin: originHeader(request) }, "ws: rejected cross-site Origin")
        }
        try {
          socket.send(serverFrame({ type: "error", code: handshake.code, message: handshake.message }))
        } catch {
          // Ignore a send failure on an already-closing socket.
        }
        socket.close(WS_CLOSE_POLICY_VIOLATION, handshake.reason)
        return
      }
      const userId = handshake.userId

      const session: GatewaySession = {
        userId,
        conn: wrapSocket(socket),
        joined: new Set<string>(),
        typingThrottle: new Map<string, number>(),
        deps: {
          chat: opts.chat,
          isMember: opts.isMember,
          markRead: opts.markRead,
          presence: opts.presence,
          dm: opts.dm,
          isBlockedEitherWay: opts.isBlockedEitherWay,
          userChannel: opts.userChannel,
          threadRecipientsOf: opts.threadRecipientsOf,
        },
      }

      // Subscribe this user on the per-user signal channel for the socket's whole lifetime, independent of
      // any room join, so the backend can push invalidate-signals (new notification / thread-unread) to
      // this client. Best-effort (see subscribeUserChannel): a subscribe failure does NOT crash the
      // handshake — the socket still serves chat. The unsubscribe handle is kept in this per-socket closure
      // and disposed on close.
      let unsubscribeUser = await subscribeUserChannel(
        opts.userChannel,
        userId,
        session.conn,
        request.log,
      )

      // Close-during-subscribe guard (resource-leak fix): the socket may have CLOSED while we were awaiting
      // checkWsHandshake / subscribeUserChannel above. The "close" listener that disposes the subscription
      // is not registered yet, so that close event was lost — leaving the user stuck in the channel (and, on
      // the last connection, the Redis user:<id> SUBSCRIBE never released). If the socket is no longer OPEN
      // (ws readyState 1 === OPEN, the same convention as wrapSocket), dispose the subscription now and bail
      // before installing the heartbeat/listeners. There is NO await between this check and the socket.on
      // ("close") registration below, so on the single-threaded event loop a close can never slip through the
      // gap: it is observed here, or the listener is already in place to catch it.
      if (socket.readyState !== 1) {
        if (unsubscribeUser) {
          void unsubscribeUser().catch(() => {})
          unsubscribeUser = undefined
        }
        return
      }

      // Heartbeat: ws marks a socket alive on pong; if a ping goes unanswered before the next tick, the
      // socket is dead and we terminate it (which fires "close" and cleans up rooms).
      let alive = true
      socket.on("pong", () => {
        alive = true
      })
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        alive = false
        // Refresh this socket's presence entries so they are not pruned while it stays connected (the
        // registry's last-seen TTL is a few heartbeats; a long-idle-but-connected member must remain
        // "online"). Fire-and-forget; a Redis hiccup must not affect the keepalive.
        if (opts.presence) {
          for (const cleanupId of session.joined) {
            void opts.presence.refresh(cleanupId, session.conn.id, session.userId).catch(() => {})
          }
        }
        try {
          socket.ping()
        } catch {
          // A failed ping means the socket is gone; terminate to trigger cleanup.
          socket.terminate()
        }
      }, WS_HEARTBEAT_MS)
      // Do not keep the event loop alive solely for the heartbeat timer.
      if (typeof heartbeat.unref === "function") heartbeat.unref()

      socket.on("message", (data: unknown) => {
        const raw = typeof data === "string" ? data : String(data)
        void handleClientFrame(session, raw).catch((err: unknown) => {
          request.log.error({ err }, "ws frame handler failed")
          sendError(session.conn, "INTERNAL", "Failed to handle frame.")
        })
      })

      socket.on("close", () => {
        clearInterval(heartbeat)
        // Leave every room this socket joined so the ChatService drops it from fan-out AND presence
        // deregisters it (announcing a leave delta when it was the user's last connection). Iterate a
        // copy because leaveRoomAndAnnounce mutates session.joined.
        for (const cleanupId of [...session.joined]) {
          void leaveRoomAndAnnounce(session, cleanupId).catch(() => {})
        }
        session.joined.clear()
        // Drop this socket from the per-user signal channel (unsubscribes the user:* channel on its last
        // connection). Fire-and-forget; a teardown failure must not affect the close path.
        if (unsubscribeUser) {
          void unsubscribeUser().catch(() => {})
          unsubscribeUser = undefined
        }
      })

      socket.on("error", (err: unknown) => {
        request.log.warn({ err }, "ws socket error")
      })
    })()
  })
}
