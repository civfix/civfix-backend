import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import { randomUUID } from "node:crypto"
import { checkWsHandshake, originHeader } from "./handshake.js"
import { handleClientFrame, leaveRoomAndAnnounce, serverFrame, sendError } from "./frame-handler.js"
import {
  type GatewaySession,
  type RegisterGatewayOptions,
  WS_BUFFER_DROP_THRESHOLD,
  WS_BUFFER_TERMINATE_TICKS,
  WS_CLOSE_POLICY_VIOLATION,
  WS_HEARTBEAT_MS,
} from "./types.js"

const READY_STATE_OPEN = 1

/** Frame types that are ephemeral and may be dropped when the socket is backpressured (the realtime
 *  event channel). Durable frames (message/ack/error) are never dropped — the heartbeat reaps a client
 *  that stays over the buffer threshold. */
const DROPPABLE_FRAME_TYPES = new Set(["presence", "presence_snapshot", "typing", "discussion"])

function isDroppableFrame(data: string): boolean {
  // Cheap prefix probe — the type is the first field on every server frame. Avoids a full JSON.parse on
  // the hot send path; a frame whose type we can't cheaply read is treated as non-droppable (kept).
  const m = /"type"\s*:\s*"([^"]+)"/.exec(data)
  return m?.[1] !== undefined && DROPPABLE_FRAME_TYPES.has(m[1])
}

/** Decode an inbound ws frame to a string: utf8-decode any binary payload (Buffer / Buffer[] / ArrayBuffer)
 *  rather than String(buffer), which is non-deterministic on a Buffer. */
function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8")
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  return String(data)
}

/**
 * Wrap a raw ws WebSocket as the vendor-neutral ChatConnection the ChatService consumes. The send guards
 * BOTH liveness (readyState OPEN) and backpressure: when the outbound buffer is over WS_BUFFER_DROP_THRESHOLD
 * a droppable (presence/typing) frame is skipped so a slow client can't accumulate an unbounded buffer →
 * OOM; durable frames still attempt (the heartbeat terminates a persistently-stuck client).
 */
function wrapSocket(socket: WebSocket): ChatConnection {
  const id = randomUUID()
  return {
    id,
    send(data: string): void {
      if (socket.readyState !== READY_STATE_OPEN) return
      if (socket.bufferedAmount > WS_BUFFER_DROP_THRESHOLD && isDroppableFrame(data)) return
      socket.send(data)
    },
  }
}

/**
 * Subscribe an authenticated socket's user on the per-user signal channel for the socket's lifetime
 * (independent of any room join), so the backend can push invalidate-signals to this client. Returns the
 * unsubscribe handle to dispose on socket close, or undefined when no channel is wired or the subscribe
 * failed. BEST-EFFORT: a subscribe failure is logged and swallowed so the handshake still completes and
 * the socket serves chat — the per-user channel is a freshness layer, not a gate.
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

/**
 * Register GET /ws. Requires @fastify/websocket to be registered on the app already. Authenticates the
 * handshake (cookie or ?token), then drives the session through handleClientFrame and a heartbeat.
 */
export function registerChatGateway(app: FastifyInstance, opts: RegisterGatewayOptions): void {
  app.get("/ws", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    void (async () => {
      const handshake = await checkWsHandshake(request, { sessions: opts.sessions, webOrigins: opts.webOrigins })
      if (!handshake.ok) {
        if (handshake.code === "FORBIDDEN") {
          request.log.warn({ origin: originHeader(request) }, "ws: rejected cross-site Origin")
        }
        try {
          socket.send(serverFrame({ type: "error", code: handshake.code, message: handshake.message }))
        } catch {
          // Already-closing socket: nothing to send.
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
          markReadOnOpen: opts.markReadOnOpen,
          presence: opts.presence,
          dm: opts.dm,
          isBlockedEitherWay: opts.isBlockedEitherWay,
          userChannel: opts.userChannel,
          threadRecipientsOf: opts.threadRecipientsOf,
          onDmDelivered: opts.onDmDelivered,
          chatMentions: opts.chatMentions,
        },
      }

      let unsubscribeUser = await subscribeUserChannel(opts.userChannel, userId, session.conn, request.log)

      // Close-during-subscribe guard (resource-leak fix): the socket may have CLOSED while we awaited
      // checkWsHandshake / subscribeUserChannel — the "close" listener is not registered yet, so that close
      // event was lost, leaving the user stuck in the channel (and the Redis user:<id> SUBSCRIBE never
      // released). There is NO await between this check and the socket.on("close") registration below, so on
      // the single-threaded event loop a close can never slip through the gap.
      if (socket.readyState !== READY_STATE_OPEN) {
        if (unsubscribeUser) {
          void unsubscribeUser().catch(() => {})
          unsubscribeUser = undefined
        }
        return
      }

      let alive = true
      let overBufferTicks = 0
      socket.on("pong", () => {
        alive = true
      })
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        // Reap a backpressured-but-ponging client: a slow consumer can keep answering pings while its
        // outbound buffer grows unbounded. Terminate after it stays over the threshold for consecutive ticks.
        if (socket.bufferedAmount > WS_BUFFER_DROP_THRESHOLD) {
          if (++overBufferTicks >= WS_BUFFER_TERMINATE_TICKS) {
            socket.terminate()
            return
          }
        } else {
          overBufferTicks = 0
        }
        alive = false
        // Refresh this socket's presence entries so they are not pruned while it stays connected. The
        // registry's last-seen TTL is a few heartbeats; a long-idle-but-connected member must remain online.
        if (opts.presence) {
          for (const roomKey of session.joined) {
            void opts.presence.refresh(roomKey, session.conn.id, session.userId).catch(() => {})
          }
        }
        try {
          socket.ping()
        } catch {
          socket.terminate()
        }
      }, WS_HEARTBEAT_MS)
      if (typeof heartbeat.unref === "function") heartbeat.unref()

      socket.on("message", (data: unknown) => {
        // ws delivers a Buffer (or Buffer[] / ArrayBuffer) for binary frames; decode as utf8 explicitly
        // rather than String(data), which on a Buffer yields a non-deterministic toString. The frame is
        // size-bounded by maxPayload (64 KiB), so the decode is cheap and bounded.
        const raw = decodeFrame(data)
        void handleClientFrame(session, raw).catch((err: unknown) => {
          request.log.error({ err }, "ws frame handler failed")
          sendError(session.conn, "INTERNAL", "Failed to handle frame.")
        })
      })

      socket.on("close", () => {
        clearInterval(heartbeat)
        // Leave every joined room so the ChatService drops this socket from fan-out AND presence
        // deregisters it (announcing a leave delta on the user's last connection). Iterate a copy because
        // leaveRoomAndAnnounce mutates session.joined.
        for (const roomKey of [...session.joined]) {
          void leaveRoomAndAnnounce(session, roomKey).catch(() => {})
        }
        session.joined.clear()
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

export { wrapSocket }
