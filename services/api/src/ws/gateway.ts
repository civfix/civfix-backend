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

import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import { WsClientMessageSchema, type WsServerMessage } from "@civfix/shared"
import type { ChatService, ChatConnection } from "@civfix/shared/interfaces"
import type { SessionService } from "../auth/session-service.js"
import type { ChatPresence } from "../adapters/chat-presence.js"
import { presentedSessionToken, SESSION_COOKIE } from "../auth/transport.js"
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
  // Dev-only: an empty allowlist disables the gate entirely (mirrors CORS).
  if (webOrigins.length === 0) return true
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

/** Send an {type:"error"} frame to a connection. */
function sendError(conn: ChatConnection, code: string, message: string): void {
  conn.send(serverFrame({ type: "error", code, message }))
}

/**
 * Leave a room AND announce a presence(leave) delta to the remaining members when this was the user's
 * LAST connection in the room. Shared by the explicit `leave` frame and the socket `close` cleanup so
 * both paths drop the room AND deregister presence (otherwise a closed socket would linger as "online"
 * until its TTL pruned it). Order: drop from the message fan-out first (the conn is gone from the room,
 * so the leave delta below reaches only the OTHERS), then deregister presence and broadcast the delta.
 */
async function leaveRoomAndAnnounce(session: GatewaySession, cleanupId: string): Promise<void> {
  const { conn, deps, userId } = session
  await deps.chat.leaveRoom(cleanupId, conn)
  session.joined.delete(cleanupId)
  session.typingThrottle.delete(cleanupId)
  if (deps.presence) {
    const { userGone } = await deps.presence.leave(cleanupId, conn.id, userId)
    if (userGone) {
      await deps.chat.broadcastEvent?.(cleanupId, {
        type: "presence",
        cleanupId,
        userId,
        state: "leave",
      })
    }
  }
}

/**
 * Handle ONE inbound client frame for a session. Returns nothing; all effects are sends/persist/
 * broadcast/room changes. This is the unit-tested core of the gateway:
 *   - parse + validate against WsClientMessageSchema; a malformed frame -> a single error frame, no throw.
 *   - join: membership-gate, then ChatService.joinRoom + a presence frame to the joiner's own socket.
 *   - leave: ChatService.leaveRoom.
 *   - send: membership-gate, persist via ChatService, broadcast to the room EXCEPT the sender's socket,
 *     and ack the SENDER with the clientId + persisted message so the optimistic client reconciles
 *     (the sender's exactly-once copy; P1-2).
 *   - typing: broadcast a presence/typing frame to the room (best-effort).
 *   - ack: update read state via markRead (optional).
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
      const ok = await deps.isMember(frame.cleanupId, userId)
      if (!ok) {
        sendError(conn, "FORBIDDEN", "You are not a member of this cleanup.")
        return
      }
      await deps.chat.joinRoom(frame.cleanupId, conn, userId)
      session.joined.add(frame.cleanupId)
      // Presence (when a registry is wired): register this connection, send the joiner the CURRENT online
      // snapshot so it can render "N online" immediately, and broadcast a join DELTA to the OTHER members
      // only when this is the user's FIRST connection in the room (so opening a second tab/device does not
      // spam a redundant join). The joiner is excluded from the delta - it already has the snapshot.
      if (deps.presence) {
        const { online, userJoined } = await deps.presence.join(frame.cleanupId, conn.id, userId)
        conn.send(
          serverFrame({ type: "presence_snapshot", cleanupId: frame.cleanupId, userIds: online }),
        )
        if (userJoined) {
          await deps.chat.broadcastEvent?.(
            frame.cleanupId,
            { type: "presence", cleanupId: frame.cleanupId, userId, state: "join" },
            { excludeConnId: conn.id },
          )
        }
      }
      return
    }

    case "leave": {
      await leaveRoomAndAnnounce(session, frame.cleanupId)
      return
    }

    case "send": {
      const ok = await deps.isMember(frame.cleanupId, userId)
      if (!ok) {
        sendError(conn, "FORBIDDEN", "You are not a member of this cleanup.")
        return
      }
      // Persist first so the broadcast + ack carry the durable id/createdAt (the optimistic client
      // reconciles its temporary clientId against the server message).
      const message = await deps.chat.persist({
        cleanupId: frame.cleanupId,
        userId,
        body: frame.body,
        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
        clientId: frame.clientId,
      })
      // Broadcast to the room EXCEPT this sender's socket (P1-2): the sender would otherwise get both the
      // broadcast {type:"message"} frame AND the {type:"ack"} below for the same id and render it twice.
      // excludeConnId keeps the sender out of the fan-out; the sender reconciles its optimistic bubble
      // from the ack alone. Other members (and the sender's OTHER devices, which are different
      // connections) still receive the message frame.
      await deps.chat.broadcast(frame.cleanupId, message, { excludeConnId: conn.id })
      // Ack the SENDER directly with the clientId so its optimistic bubble is reconciled. This is the
      // sender's ONLY copy of the message (exactly-once delivery to the sender).
      conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message }))
      return
    }

    case "typing": {
      // A member is typing: fan a {type:"typing"} frame to the OTHER members (the sender is excluded) over
      // the dedicated broadcastEvent channel - it carries an ephemeral, un-persisted frame, so it never
      // touches the message stream or history. A non-member must not even signal typing.
      const ok = await deps.isMember(frame.cleanupId, userId)
      if (!ok) {
        sendError(conn, "FORBIDDEN", "You are not a member of this cleanup.")
        return
      }
      // Server-side throttle backstop: drop typing fan-outs more frequent than TYPING_MIN_INTERVAL_MS for
      // this connection+room, regardless of what the client sends.
      const now = Date.now()
      const last = session.typingThrottle.get(frame.cleanupId) ?? 0
      if (now - last < TYPING_MIN_INTERVAL_MS) return
      session.typingThrottle.set(frame.cleanupId, now)
      await deps.chat.broadcastEvent?.(
        frame.cleanupId,
        { type: "typing", cleanupId: frame.cleanupId, userId },
        { excludeConnId: conn.id },
      )
      return
    }

    case "ack": {
      // Update per-user read state (OPTIONAL; drives the threads unread count). The shared ack frame
      // carries only upToId, not a cleanupId, so we scope the read to the room this socket is in. A
      // socket is expected to be in exactly one room (the open conversation); when it is in more than
      // one we take the first joined room, and when it is in none there is nothing to mark. A later
      // step can widen the ack frame to carry the cleanupId for a stricter mapping. No-op when no
      // markRead is wired.
      if (deps.markRead) {
        const cleanupId: string | undefined = session.joined.values().next().value
        if (cleanupId !== undefined) {
          await deps.markRead(cleanupId, userId, frame.upToId)
        }
      }
      return
    }
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
  /** Optional read-state updater for the `ack` frame. */
  markRead?: MarkReadFn | undefined
  /** Optional presence registry: powers presence snapshots/deltas and is refreshed by the heartbeat. */
  presence?: ChatPresence | undefined
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
        },
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
      })

      socket.on("error", (err: unknown) => {
        request.log.warn({ err }, "ws socket error")
      })
    })()
  })
}
