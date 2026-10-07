import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import { ErrorCode } from "@civfix/shared"
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
  type WsHandshakeResult,
  WS_BUFFER_DROP_THRESHOLD,
  WS_BUFFER_TERMINATE_TICKS,
  WS_CLOSE_POLICY_VIOLATION,
  WS_CONNECTION_CAP_REASON,
  WS_FRAME_RATE_LIMITED_MESSAGE,
  WS_FRAME_BACKLOG_REASON,
  WS_HANDSHAKE_BUFFER_BYTES,
  WS_HANDSHAKE_FRAME_BUFFER,
  WS_HEARTBEAT_MS,
  WS_MAX_QUEUED_BYTES,
  WS_MAX_QUEUED_FRAMES,
  WS_REAUTH_INTERVAL_MS,
  WS_REAUTH_JITTER_MS,
  WS_ROUTE,
  WS_SEND_LIMITS,
  WS_SESSION_ENDED_MESSAGE,
  WS_SESSION_ENDED_REASON,
} from "./types.js"
import type { SessionService } from "../auth/session-service.js"
import type { AccountStatus } from "../auth/stores.js"
import type { SocketStatusCheck } from "../auth/account-status.js"

const READY_STATE_OPEN = 1

export const MAX_CONNECTIONS_PER_USER = 10

export const MAX_CONNECTIONS_PER_IP = 30

const DROPPABLE_FRAME_TYPES = new Set(["presence", "presence_snapshot", "typing", "discussion"])

const FRAME_TYPE_PATTERN = /"type"\s*:\s*"([^"]+)"/

type SocketLog = Pick<FastifyBaseLogger, "debug" | "info" | "warn" | "error">

type AcceptedHandshake = Extract<WsHandshakeResult, { ok: true }>

function makeSendLimiter(reportLimiter: RateLimiter | undefined): RateLimiter {
  const cleanup = makeTokenBucketLimiter(WS_SEND_LIMITS.cleanup)
  const dm = makeTokenBucketLimiter(WS_SEND_LIMITS.dm)
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

interface ConnectionSlots {
  tryAcquire(userId: string, ipKey: string): (() => void) | null
}

function makeConnectionSlots(): ConnectionSlots {
  const connectionsPerUser = new Map<string, number>()
  const connectionsPerIp = new Map<string, number>()
  return {
    tryAcquire(userId, ipKey) {
      if (
        (connectionsPerUser.get(userId) ?? 0) >= MAX_CONNECTIONS_PER_USER ||
        (connectionsPerIp.get(ipKey) ?? 0) >= MAX_CONNECTIONS_PER_IP
      ) {
        return null
      }
      bumpCount(connectionsPerUser, userId, 1)
      bumpCount(connectionsPerIp, ipKey, 1)
      let released = false
      return () => {
        if (released) return
        released = true
        bumpCount(connectionsPerUser, userId, -1)
        bumpCount(connectionsPerIp, ipKey, -1)
      }
    },
  }
}

function isDroppableFrame(data: string): boolean {
  const m = FRAME_TYPE_PATTERN.exec(data)
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

function sendErrorThenClose(
  socket: WebSocket,
  send: (data: string) => void,
  log: SocketLog,
  error: { code: string; message: string },
  closeReason: string,
  sendFailureLog: string,
): void {
  try {
    send(serverFrame({ type: "error", code: error.code, message: error.message }))
  } catch (err) {
    log.debug({ err }, sendFailureLog)
  }
  socket.close(WS_CLOSE_POLICY_VIOLATION, closeReason)
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

function makeStatusRevalidator(
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

interface HandshakeFrameBuffer {
  drop(): void
  drain(run: (raw: string) => Promise<void>): Promise<void>
  route(handler: (raw: string) => void): void
}

function bufferFramesUntilAccepted(socket: WebSocket): HandshakeFrameBuffer {
  let pending: string[] | undefined = []
  let pendingBytes = 0
  let onFrame: ((raw: string) => void) | undefined
  const drop = (): void => {
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
  return {
    drop,
    async drain(run) {
      const buffered = pending ?? []
      while (buffered.length > 0) {
        const raw = buffered.shift()
        if (raw === undefined) break
        pendingBytes = Math.max(0, pendingBytes - Buffer.byteLength(raw, "utf8"))
        await run(raw)
      }
      drop()
    },
    route(handler) {
      onFrame = handler
    },
  }
}

function makeGatewaySession(
  socket: WebSocket,
  opts: RegisterGatewayOptions,
  handshake: AcceptedHandshake,
  sendLimiter: RateLimiter,
): GatewaySession {
  const { userId } = handshake
  return {
    userId,
    ...(handshake.accountStatus !== undefined ? { accountStatus: handshake.accountStatus } : {}),
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
}

interface AuthCloser {
  close(): void
  isClosing(): boolean
}

function makeAuthCloser(socket: WebSocket, session: GatewaySession, log: SocketLog): AuthCloser {
  let closingForAuth = false
  return {
    close() {
      if (closingForAuth) return
      closingForAuth = true
      log.info({ userId: session.userId }, "ws: closing socket, session no longer valid")
      sendErrorThenClose(
        socket,
        (data) => session.conn.send(data),
        log,
        { code: ErrorCode.UNAUTHORIZED, message: WS_SESSION_ENDED_MESSAGE },
        WS_SESSION_ENDED_REASON,
        "ws: reauth-reject send failed (socket already closing)",
      )
    },
    isClosing: () => closingForAuth,
  }
}

function nextReauthInterval(): number {
  return WS_REAUTH_INTERVAL_MS + Math.floor(Math.random() * WS_REAUTH_JITTER_MS)
}

function startHeartbeat(
  socket: WebSocket,
  session: GatewaySession,
  opts: RegisterGatewayOptions,
  sessionHash: string | undefined,
  auth: AuthCloser,
  log: SocketLog,
): () => void {
  let alive = true
  let overBufferTicks = 0
  let reauthIntervalMs = nextReauthInterval()
  let lastFullReauthAt = Date.now() - Math.floor(Math.random() * WS_REAUTH_INTERVAL_MS)

  const reauthorize = async (): Promise<void> => {
    const now = Date.now()
    const fullCheck = now - lastFullReauthAt >= reauthIntervalMs
    if (fullCheck) {
      lastFullReauthAt = now
      reauthIntervalMs = nextReauthInterval()
    }
    const check = await checkSocketAuthorization(
      opts.sessions,
      session.userId,
      sessionHash,
      fullCheck,
    )
    if (!check.authorized) {
      auth.close()
      return
    }
    if (check.accountStatus !== undefined) session.accountStatus = check.accountStatus
    if (fullCheck && !auth.isClosing() && !session.closed) {
      await reauthorizeJoinedRooms(session)
    }
  }

  socket.on("pong", () => {
    alive = true
  })
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate()
      return
    }
    void reauthorize().catch((err: unknown) => {
      log.warn({ err }, "ws: heartbeat reauthorization failed")
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
  return () => clearInterval(heartbeat)
}

// The per-frame token bucket only runs when a frame is dequeued, so while one handler awaits a slow
// store every later frame would otherwise sit in memory unbounded.
function makeFrameQueue(
  socket: WebSocket,
  session: GatewaySession,
  runFrame: (raw: string) => Promise<void>,
  log: SocketLog,
): (raw: string) => void {
  let frameChain: Promise<void> = Promise.resolve()
  let queuedFrames = 0
  let queuedBytes = 0
  let backlogClosed = false
  const closeForBacklog = (): void => {
    backlogClosed = true
    log.warn(
      { userId: session.userId, queuedFrames, queuedBytes },
      "ws: closing socket, inbound frame backlog over cap",
    )
    sendErrorThenClose(
      socket,
      (data) => session.conn.send(data),
      log,
      { code: ErrorCode.RATE_LIMITED, message: WS_FRAME_RATE_LIMITED_MESSAGE },
      WS_FRAME_BACKLOG_REASON,
      "ws: backlog-reject send failed (socket already closing)",
    )
  }
  return (raw: string): void => {
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
}

interface SocketContext {
  socket: WebSocket
  request: FastifyRequest
  opts: RegisterGatewayOptions
  sendLimiter: RateLimiter
  slots: ConnectionSlots
  frames: HandshakeFrameBuffer
}

async function acceptSocket(ctx: SocketContext): Promise<void> {
  const { socket, request, opts, slots, frames } = ctx
  const log = request.log
  const handshake = await checkWsHandshake(request, {
    sessions: opts.sessions,
    webOrigins: opts.webOrigins,
    redeemTicket: opts.redeemTicket,
  })
  if (!handshake.ok) {
    frames.drop()
    if (handshake.code === "FORBIDDEN") {
      log.warn({ origin: originHeader(request) }, "ws: rejected cross-site Origin")
    }
    sendErrorThenClose(
      socket,
      (data) => socket.send(data),
      log,
      handshake,
      handshake.reason,
      "ws: handshake-reject send failed (socket already closing)",
    )
    return
  }
  const userId = handshake.userId

  const releaseConnectionSlot = slots.tryAcquire(userId, normalizeIp(request.ip))
  if (releaseConnectionSlot === null) {
    frames.drop()
    sendErrorThenClose(
      socket,
      (data) => socket.send(data),
      log,
      { code: ErrorCode.RATE_LIMITED, message: "Too many open connections." },
      WS_CONNECTION_CAP_REASON,
      "ws: connection-cap reject send failed (socket already closing)",
    )
    return
  }
  socket.on("close", releaseConnectionSlot)

  const session = makeGatewaySession(socket, opts, handshake, ctx.sendLimiter)

  let unsubscribeUser = await subscribeUserChannel(opts.userChannel, userId, session.conn, log)
  const unsubscribe = (): void => {
    if (!unsubscribeUser) return
    void unsubscribeUser().catch(() => {})
    unsubscribeUser = undefined
  }

  if (socket.readyState !== READY_STATE_OPEN) {
    frames.drop()
    unsubscribe()
    releaseConnectionSlot()
    return
  }

  const auth = makeAuthCloser(socket, session, log)
  session.closeForAuth = () => auth.close()
  const stopHeartbeat = startHeartbeat(socket, session, opts, handshake.sessionHash, auth, log)

  const runFrame = async (raw: string): Promise<void> => {
    try {
      await handleClientFrame(session, raw)
    } catch (err) {
      log.error({ err }, "ws frame handler failed")
      sendError(session.conn, ErrorCode.INTERNAL, "Failed to handle frame.")
    }
  }

  socket.on("close", () => {
    session.closed = true
    frames.drop()
    stopHeartbeat()
    for (const roomKey of [...session.joined]) {
      void leaveRoomAndAnnounce(session, roomKey).catch(() => {})
    }
    session.joined.clear()
    unsubscribe()
  })

  socket.on("error", (err: unknown) => {
    log.warn({ err }, "ws socket error")
  })

  await frames.drain(runFrame)
  frames.route(makeFrameQueue(socket, session, runFrame, log))
}

export function registerChatGateway(app: FastifyInstance, opts: RegisterGatewayOptions): void {
  const sendLimiter = makeSendLimiter(opts.reportSendLimiter)
  const slots = makeConnectionSlots()

  app.get(WS_ROUTE, { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const frames = bufferFramesUntilAccepted(socket)
    void acceptSocket({ socket, request, opts, sendLimiter, slots, frames })
  })
}

export { wrapSocket }
