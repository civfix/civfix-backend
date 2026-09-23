import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import { randomUUID } from "node:crypto"
import { checkWsHandshake, originHeader } from "./handshake.js"
import {
  handleClientFrame,
  leaveRoomAndAnnounce,
  reauthorizeJoinedRooms,
  serverFrame,
  sendError,
  decodeRoomKey,
} from "./frame-handler.js"
import { makeTokenBucketLimiter, type RateLimiter } from "./report-rate-limit.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import {
  type GatewaySession,
  type RegisterGatewayOptions,
  WS_BUFFER_DROP_THRESHOLD,
  WS_BUFFER_TERMINATE_TICKS,
  WS_CLOSE_POLICY_VIOLATION,
  WS_FRAME_RATE_LIMITED_MESSAGE,
  WS_FRAME_BACKLOG_REASON,
  WS_HANDSHAKE_BUFFER_BYTES,
  WS_HANDSHAKE_FRAME_BUFFER,
  WS_HEARTBEAT_MS,
  WS_MAX_QUEUED_BYTES,
  WS_MAX_QUEUED_FRAMES,
  WS_REAUTH_INTERVAL_MS,
  WS_REAUTH_JITTER_MS,
  WS_SESSION_ENDED_MESSAGE,
  WS_SESSION_ENDED_REASON,
} from "./types.js"
import type { SessionService } from "../auth/session-service.js"
import type { AccountStatus } from "../auth/stores.js"
import type { SocketStatusCheck } from "../auth/account-status.js"

const READY_STATE_OPEN = 1

const CLEANUP_SEND_LIMIT = { capacity: 30, refillPerSec: 0.5 } as const

const DM_SEND_LIMIT = { capacity: 20, refillPerSec: 0.5 } as const

export const MAX_CONNECTIONS_PER_USER = 10

export const MAX_CONNECTIONS_PER_IP = 30

function makeSendLimiter(reportLimiter: RateLimiter | undefined): RateLimiter {
  const cleanup = makeTokenBucketLimiter(CLEANUP_SEND_LIMIT)
  const dm = makeTokenBucketLimiter(DM_SEND_LIMIT)
  return {
    tryConsume(key: string): boolean {
      const { kind } = decodeRoomKey(key.slice(key.indexOf(":") + 1))
      if (kind === "dm") return dm.tryConsume(key)
      if (kind === "report") return reportLimiter ? reportLimiter.tryConsume(key) : true
      return cleanup.tryConsume(key)
    },
  }
}

function bumpCount(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta
  if (next <= 0) counts.delete(key)
  else counts.set(key, next)
}

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

export interface SocketAuthCheck {
  authorized: boolean
  accountStatus?: AccountStatus
}

export async function checkSocketAuthorization(
  sessions: SessionService | undefined,
  userId: string,
  sessionHash: string | undefined,
  fullCheck: boolean,
): Promise<SocketAuthCheck> {
  if (!sessions) return { authorized: true }
  try {
    if (!(await sessions.isUserActive(userId))) return { authorized: false }
    if (fullCheck && sessionHash !== undefined) {
      const resolved = await sessions.resolveSessionByHash(sessionHash)
      if (resolved === null || resolved.userId !== userId) return { authorized: false }
      return { authorized: true, accountStatus: resolved.accountStatus }
    }
    return { authorized: true }
  } catch {
    // A session-store outage must not drop every live socket at once; the next heartbeat re-checks.
    return { authorized: true }
  }
}

export function makeStatusRevalidator(
  sessions: SessionService,
  userId: string,
  sessionHash: string,
): () => Promise<SocketStatusCheck> {
  return async () => {
    let resolved
    try {
      resolved = await sessions.resolveSessionByHash(sessionHash)
    } catch {
      return { kind: "unknown" }
    }
    if (resolved === null || resolved.userId !== userId) return { kind: "revoked" }
    return { kind: "live", status: resolved.accountStatus }
  }
}

export async function isSocketStillAuthorized(
  sessions: SessionService | undefined,
  userId: string,
  sessionHash: string | undefined,
  fullCheck: boolean,
): Promise<boolean> {
  return (await checkSocketAuthorization(sessions, userId, sessionHash, fullCheck)).authorized
}

export function registerChatGateway(app: FastifyInstance, opts: RegisterGatewayOptions): void {
  const sendLimiter = makeSendLimiter(opts.reportSendLimiter)
  const connectionsPerUser = new Map<string, number>()
  const connectionsPerIp = new Map<string, number>()

  app.get("/ws", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    let pending: string[] | undefined = []
    let pendingBytes = 0
    let onFrame: ((raw: string) => void) | undefined
    const dropPending = (): void => {
      pending = undefined
      pendingBytes = 0
    }
    socket.on("message", (data: unknown) => {
      const raw = decodeFrame(data)
      if (onFrame !== undefined) {
        onFrame(raw)
        return
      }
      if (pending === undefined || pending.length >= WS_HANDSHAKE_FRAME_BUFFER) return
      const bytes = Buffer.byteLength(raw, "utf8")
      if (pendingBytes + bytes > WS_HANDSHAKE_BUFFER_BYTES) return
      pendingBytes += bytes
      pending.push(raw)
    })

    void (async () => {
      const handshake = await checkWsHandshake(request, {
        sessions: opts.sessions,
        webOrigins: opts.webOrigins,
        redeemTicket: opts.redeemTicket,
      })
      if (!handshake.ok) {
        dropPending()
        if (handshake.code === "FORBIDDEN") {
          request.log.warn({ origin: originHeader(request) }, "ws: rejected cross-site Origin")
        }
        try {
          socket.send(
            serverFrame({ type: "error", code: handshake.code, message: handshake.message }),
          )
        } catch (err) {
          request.log.debug({ err }, "ws: handshake-reject send failed (socket already closing)")
        }
        socket.close(WS_CLOSE_POLICY_VIOLATION, handshake.reason)
        return
      }
      const userId = handshake.userId
      const ipKey = normalizeIp(request.ip)

      if (
        (connectionsPerUser.get(userId) ?? 0) >= MAX_CONNECTIONS_PER_USER ||
        (connectionsPerIp.get(ipKey) ?? 0) >= MAX_CONNECTIONS_PER_IP
      ) {
        dropPending()
        try {
          socket.send(
            serverFrame({
              type: "error",
              code: "RATE_LIMITED",
              message: "Too many open connections.",
            }),
          )
        } catch (err) {
          request.log.debug(
            { err },
            "ws: connection-cap reject send failed (socket already closing)",
          )
        }
        socket.close(WS_CLOSE_POLICY_VIOLATION, "too many connections")
        return
      }

      bumpCount(connectionsPerUser, userId, 1)
      bumpCount(connectionsPerIp, ipKey, 1)
      let released = false
      const releaseConnectionSlot = (): void => {
        if (released) return
        released = true
        bumpCount(connectionsPerUser, userId, -1)
        bumpCount(connectionsPerIp, ipKey, -1)
      }
      socket.on("close", releaseConnectionSlot)

      const session: GatewaySession = {
        userId,
        ...(handshake.accountStatus !== undefined
          ? { accountStatus: handshake.accountStatus }
          : {}),
        ...(handshake.sessionHash !== undefined && opts.sessions !== undefined
          ? {
              revalidateStatus: makeStatusRevalidator(opts.sessions, userId, handshake.sessionHash),
            }
          : {}),
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
          onGroupMessage: opts.onGroupMessage,
          onChatReply: opts.onChatReply,
          reportVisible: opts.reportVisible,
          reportSendLimiter: sendLimiter,
          chatMentions: opts.chatMentions,
          reportChat: opts.reportChat,
          groupChat: opts.groupChat,
        },
      }

      let unsubscribeUser = await subscribeUserChannel(
        opts.userChannel,
        userId,
        session.conn,
        request.log,
      )

      if (socket.readyState !== READY_STATE_OPEN) {
        dropPending()
        if (unsubscribeUser) {
          void unsubscribeUser().catch(() => {})
          unsubscribeUser = undefined
        }
        releaseConnectionSlot()
        return
      }

      let alive = true
      let overBufferTicks = 0
      const sessionHash = handshake.sessionHash
      const nextReauthInterval = (): number =>
        WS_REAUTH_INTERVAL_MS + Math.floor(Math.random() * WS_REAUTH_JITTER_MS)
      let reauthIntervalMs = nextReauthInterval()
      let lastFullReauthAt = Date.now() - Math.floor(Math.random() * WS_REAUTH_INTERVAL_MS)
      let closingForAuth = false
      const closeForAuth = (): void => {
        if (closingForAuth) return
        closingForAuth = true
        request.log.info({ userId }, "ws: closing socket, session no longer valid")
        try {
          session.conn.send(
            serverFrame({
              type: "error",
              code: "UNAUTHORIZED",
              message: WS_SESSION_ENDED_MESSAGE,
            }),
          )
        } catch (err) {
          request.log.debug({ err }, "ws: reauth-reject send failed (socket already closing)")
        }
        socket.close(WS_CLOSE_POLICY_VIOLATION, WS_SESSION_ENDED_REASON)
      }
      session.closeForAuth = closeForAuth
      socket.on("pong", () => {
        alive = true
      })
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        void (async () => {
          const now = Date.now()
          const fullCheck = now - lastFullReauthAt >= reauthIntervalMs
          if (fullCheck) {
            lastFullReauthAt = now
            reauthIntervalMs = nextReauthInterval()
          }
          const check = await checkSocketAuthorization(
            opts.sessions,
            userId,
            sessionHash,
            fullCheck,
          )
          if (check.authorized) {
            if (check.accountStatus !== undefined) session.accountStatus = check.accountStatus
            if (fullCheck && !closingForAuth && !session.closed) {
              await reauthorizeJoinedRooms(session)
            }
            return
          }
          closeForAuth()
        })().catch((err: unknown) => {
          request.log.warn({ err }, "ws: heartbeat reauthorization failed")
        })
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

      const runFrame = async (raw: string): Promise<void> => {
        try {
          await handleClientFrame(session, raw)
        } catch (err) {
          request.log.error({ err }, "ws frame handler failed")
          sendError(session.conn, "INTERNAL", "Failed to handle frame.")
        }
      }

      socket.on("close", () => {
        session.closed = true
        dropPending()
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

      const buffered = pending ?? []
      while (buffered.length > 0) {
        const raw = buffered.shift()
        if (raw === undefined) break
        pendingBytes = Math.max(0, pendingBytes - Buffer.byteLength(raw, "utf8"))
        await runFrame(raw)
      }
      dropPending()
      let frameChain: Promise<void> = Promise.resolve()
      let queuedFrames = 0
      let queuedBytes = 0
      let backlogClosed = false
      const closeForBacklog = (): void => {
        backlogClosed = true
        request.log.warn(
          { userId, queuedFrames, queuedBytes },
          "ws: closing socket, inbound frame backlog over cap",
        )
        try {
          session.conn.send(
            serverFrame({
              type: "error",
              code: "RATE_LIMITED",
              message: WS_FRAME_RATE_LIMITED_MESSAGE,
            }),
          )
        } catch (err) {
          request.log.debug({ err }, "ws: backlog-reject send failed (socket already closing)")
        }
        socket.close(WS_CLOSE_POLICY_VIOLATION, WS_FRAME_BACKLOG_REASON)
      }
      // The per-frame token bucket only runs when a frame is dequeued, so while one handler awaits
      // a slow store every later frame would otherwise sit in memory unbounded.
      onFrame = (raw: string): void => {
        if (backlogClosed || session.closed) return
        const bytes = Buffer.byteLength(raw, "utf8")
        if (queuedFrames >= WS_MAX_QUEUED_FRAMES || queuedBytes + bytes > WS_MAX_QUEUED_BYTES) {
          closeForBacklog()
          return
        }
        queuedFrames += 1
        queuedBytes += bytes
        frameChain = frameChain.then(async () => {
          try {
            await runFrame(raw)
          } finally {
            queuedFrames -= 1
            queuedBytes -= bytes
          }
        })
      }
    })()
  })
}

export { wrapSocket }
