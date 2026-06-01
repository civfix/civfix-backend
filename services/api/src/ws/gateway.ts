/**
 * WebSocket chat gateway, mounted at GET /ws via @fastify/websocket.
 *
 * DUAL HANDSHAKE AUTH (the web and mobile clients differ):
 *   (a) COOKIE (web, same-origin SPA): the httpOnly session cookie is sent automatically on the upgrade
 *       request, so the auth onRequest hook already resolved req.auth from it. We accept that.
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
import { presentedSessionToken } from "../auth/transport.js"
import { randomUUID } from "node:crypto"

/** Heartbeat interval (ms): ping idle sockets so dead connections are detected and reaped. */
export const WS_HEARTBEAT_MS = 30_000

/** Close code used when a handshake is unauthenticated (RFC 6455 policy violation). */
export const WS_CLOSE_POLICY_VIOLATION = 1008

/** Membership probe: is `userId` a member of `cleanupId`? (cleanup membership == chat membership). */
export type IsMemberFn = (cleanupId: string, userId: string) => Promise<boolean>

/** Optional read-state updater (per-user last-read), used by the `ack` frame. No-op when omitted. */
export type MarkReadFn = (cleanupId: string, userId: string, upToId: string) => Promise<void>

/** The dependencies the gateway frame handler needs (no Fastify/socket types here so it stays testable). */
export interface GatewayDeps {
  chat: ChatService
  isMember: IsMemberFn
  markRead?: MarkReadFn | undefined
}

/**
 * Per-connection session: the authenticated user, the wrapped connection, the set of rooms this socket
 * has joined (so close can leave them all), and the deps. One is created per socket.
 */
export interface GatewaySession {
  readonly userId: string
  readonly conn: ChatConnection
  readonly joined: Set<string>
  readonly deps: GatewayDeps
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
 * Handle ONE inbound client frame for a session. Returns nothing; all effects are sends/persist/
 * broadcast/room changes. This is the unit-tested core of the gateway:
 *   - parse + validate against WsClientMessageSchema; a malformed frame -> a single error frame, no throw.
 *   - join: membership-gate, then ChatService.joinRoom + a presence frame to the joiner's own socket.
 *   - leave: ChatService.leaveRoom.
 *   - send: membership-gate, persist via ChatService, broadcast to the room, and ack the SENDER with the
 *     clientId + persisted message so the optimistic client reconciles.
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
      // Presence: tell the joiner's own socket it is in (clients use this to flip room state). Other
      // members learn of the join via the same channel only if presence is broadcast; we keep join
      // presence local to avoid leaking membership churn, matching the "optional" presence in the spec.
      conn.send(
        serverFrame({ type: "presence", cleanupId: frame.cleanupId, userId, state: "join" }),
      )
      return
    }

    case "leave": {
      await deps.chat.leaveRoom(frame.cleanupId, conn)
      session.joined.delete(frame.cleanupId)
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
      // Broadcast to the room (every member, including the sender's other devices).
      await deps.chat.broadcast(frame.cleanupId, message)
      // Ack the SENDER directly with the clientId so its optimistic bubble is reconciled even if the
      // broadcast path is async/cross-worker.
      conn.send(serverFrame({ type: "ack", clientId: frame.clientId, message }))
      return
    }

    case "typing": {
      // Typing presence is OPTIONAL and best-effort (see the spec). The ChatService.broadcast contract
      // only carries a ChatMessageDTO, and we will not abuse it to push a non-message presence frame
      // (which would corrupt the message stream) nor modify the shared interface. So we gate on
      // membership (a non-member must not even signal typing) and otherwise no-op. A later step can add
      // a dedicated presence channel to the ChatService seam if live typing indicators are desired.
      const ok = await deps.isMember(frame.cleanupId, userId)
      if (!ok) {
        sendError(conn, "FORBIDDEN", "You are not a member of this cleanup.")
        return
      }
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

export interface RegisterGatewayOptions {
  /** The chat service (real WsChatService in production, or the fake). */
  chat: ChatService
  /** Membership probe (cleanup membership == chat membership). */
  isMember: IsMemberFn
  /** Session service for resolving the ?token query param (mobile). */
  sessions: SessionService | undefined
  /** Optional read-state updater for the `ack` frame. */
  markRead?: MarkReadFn | undefined
}

/**
 * Register GET /ws. Requires @fastify/websocket to be registered on the app already. Authenticates the
 * handshake (cookie or ?token), then drives the session through handleClientFrame and a heartbeat.
 */
export function registerChatGateway(app: FastifyInstance, opts: RegisterGatewayOptions): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    void (async () => {
      const userId = await resolveWsUser(request, opts.sessions)
      if (userId === null) {
        // Reject the unauthenticated handshake: one error frame, then close with policy-violation.
        try {
          socket.send(
            serverFrame({ type: "error", code: "UNAUTHORIZED", message: "Authentication required." }),
          )
        } catch {
          // Ignore a send failure on an already-closing socket.
        }
        socket.close(WS_CLOSE_POLICY_VIOLATION, "unauthenticated")
        return
      }

      const session: GatewaySession = {
        userId,
        conn: wrapSocket(socket),
        joined: new Set<string>(),
        deps: {
          chat: opts.chat,
          isMember: opts.isMember,
          markRead: opts.markRead,
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
        // Leave every room this socket joined so the ChatService drops it from fan-out.
        for (const cleanupId of session.joined) {
          void opts.chat.leaveRoom(cleanupId, session.conn)
        }
        session.joined.clear()
      })

      socket.on("error", (err: unknown) => {
        request.log.warn({ err }, "ws socket error")
      })
    })()
  })
}
