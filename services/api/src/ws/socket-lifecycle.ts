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

const DROPPABLE_FRAME_TYPES = new Set(["presence", "presence_snapshot", "typing", "discussion"])

function isDroppableFrame(data: string): boolean {
  const m = /"type"\s*:\s*"([^"]+)"/.exec(data)
  return m?.[1] !== undefined && DROPPABLE_FRAME_TYPES.has(m[1])
}

function decodeFrame(data: unknown): string {
  if (typeof data === "string") return data
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8")
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  return String(data)
}

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
        } catch (err) {
          request.log.debug({ err }, "ws: handshake-reject send failed (socket already closing)")
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
          onReportMessage: opts.onReportMessage,
          reportVisible: opts.reportVisible,
          reportSendLimiter: opts.reportSendLimiter,
          chatMentions: opts.chatMentions,
        },
      }

      let unsubscribeUser = await subscribeUserChannel(opts.userChannel, userId, session.conn, request.log)

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
        if (socket.bufferedAmount > WS_BUFFER_DROP_THRESHOLD) {
          if (++overBufferTicks >= WS_BUFFER_TERMINATE_TICKS) {
            socket.terminate()
            return
          }
        } else {
          overBufferTicks = 0
        }
        alive = false
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
        const raw = decodeFrame(data)
        void handleClientFrame(session, raw).catch((err: unknown) => {
          request.log.error({ err }, "ws frame handler failed")
          sendError(session.conn, "INTERNAL", "Failed to handle frame.")
        })
      })

      socket.on("close", () => {
        clearInterval(heartbeat)
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
