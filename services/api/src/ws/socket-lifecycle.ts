import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "@fastify/websocket"
import type { ChatConnection, UserChannel } from "@civfix/shared/interfaces"
import { randomUUID } from "node:crypto"
import { checkWsHandshake, originHeader } from "./handshake.js"
import { handleClientFrame, leaveRoomAndAnnounce, serverFrame, sendError, decodeRoomKey } from "./frame-handler.js"
import { makeTokenBucketLimiter, type RateLimiter } from "./report-rate-limit.js"
import { normalizeIp } from "../abuse/ip-rate-limit.js"
import {
  type GatewaySession,
  type RegisterGatewayOptions,
  WS_BUFFER_DROP_THRESHOLD,
  WS_BUFFER_TERMINATE_TICKS,
  WS_CLOSE_POLICY_VIOLATION,
  WS_HANDSHAKE_BUFFER_BYTES,
  WS_HANDSHAKE_FRAME_BUFFER,
  WS_HEARTBEAT_MS,
  WS_REAUTH_INTERVAL_MS,
} from "./types.js"
import type { SessionService } from "../auth/session-service.js"

const READY_STATE_OPEN = 1

const CLEANUP_SEND_LIMIT = { capacity: 30, refillPerSec: 0.5 } as const

const DM_SEND_LIMIT = { capacity: 20, refillPerSec: 0.5 } as const

/**
 * Per-process connection ceilings (G14: PER PROCESS, so the effective ceiling multiplies by API replica
 * count). EXPORTED so the lifecycle tests drive the real cap instead of re-declaring the number — a test
 * that hardcodes `10` keeps passing while silently no longer testing the boundary if either value moves.
 */
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
      // cleanup AND group rooms share the cleanup bucket shape (30 burst, 0.5/s refill, per user+room).
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

/**
 * SECURITY (M1): re-authorize a LIVE socket.
 *
 * A WebSocket authenticated once, at connect, and then never again — so a user who logged out, whose
 * session was revoked, or who was BANNED kept full read/write access to every room they had joined for
 * as long as they left the tab open (the heartbeat only pinged). This runs on every heartbeat tick:
 *
 *   - Every tick: `isUserActive` — a single Redis read of the banned marker, the same veto
 *     `resolveSession` applies on the HTTP lane. This is the check that must never be skipped, because
 *     banning is the time-critical one.
 *   - At most every WS_REAUTH_INTERVAL_MS, and only when the handshake retained a session token
 *     (cookie/bearer, never ?ticket=): a full `resolveSession`, which additionally catches logout and
 *     per-session revocation, and verifies the session still belongs to the SAME user. Throttled
 *     because resolveSession slides the session's expiry, and an idle socket should not extend a
 *     session's life once per 30s.
 *
 * Returns false when the socket must be closed. FAILS OPEN on an infrastructure error (a Redis blip
 * must not mass-disconnect every live chat socket) — the next tick retries, and the HTTP lane's own
 * fail-closed auth hook still guards every mutation.
 */
export async function isSocketStillAuthorized(
  sessions: SessionService | undefined,
  userId: string,
  token: string | undefined,
  fullCheck: boolean,
): Promise<boolean> {
  if (!sessions) return true
  try {
    if (!(await sessions.isUserActive(userId))) return false
    if (fullCheck && token !== undefined) {
      const resolved = await sessions.resolveSession(token)
      if (resolved === null || resolved.userId !== userId) return false
    }
    return true
  } catch {
    return true
  }
}

export function registerChatGateway(app: FastifyInstance, opts: RegisterGatewayOptions): void {
  const sendLimiter = makeSendLimiter(opts.reportSendLimiter)
  const connectionsPerUser = new Map<string, number>()
  const connectionsPerIp = new Map<string, number>()

  app.get("/ws", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    // The 'message' listener is attached SYNCHRONOUSLY, before the async handshake below: `ws` emits
    // 'message' on receipt and DROPS the frame when no listener exists, while a client legitimately
    // sends `join` the instant the socket opens (the gateway sends no ready signal). So frames that
    // arrive during the handshake's Redis/Postgres round trips buffer here — bounded by BOTH
    // WS_HANDSHAKE_FRAME_BUFFER (count) and WS_HANDSHAKE_BUFFER_BYTES (total size, because 32 frames at
    // the 64 KiB maxPayload would otherwise be ~2 MB held for an UNAUTHENTICATED socket) — and the
    // established session drains them in arrival order. Every rejection path discards the buffer unread.
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
      // Byte-exact (not raw.length: UTF-16 code units under-count multi-byte bodies). An oversized frame
      // is dropped rather than truncated — a partial frame would fail WsClientMessageSchema anyway.
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
          socket.send(serverFrame({ type: "error", code: handshake.code, message: handshake.message }))
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
          socket.send(serverFrame({ type: "error", code: "RATE_LIMITED", message: "Too many open connections." }))
        } catch (err) {
          request.log.debug({ err }, "ws: connection-cap reject send failed (socket already closing)")
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

      let unsubscribeUser = await subscribeUserChannel(opts.userChannel, userId, session.conn, request.log)

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
      // M1: the credential this handshake authenticated with (absent on the ?ticket= path) + when the
      // last FULL re-resolve ran. Seeded to "now" because the handshake itself just resolved it.
      const sessionToken = handshake.token
      let lastFullReauthAt = Date.now()
      let closingForAuth = false
      socket.on("pong", () => {
        alive = true
      })
      const heartbeat = setInterval(() => {
        if (!alive) {
          socket.terminate()
          return
        }
        // M1: re-authorize the live socket. Async, so it runs alongside (not instead of) the ping — a
        // revoked/banned user is cut off within one heartbeat + one Redis round trip.
        void (async () => {
          const now = Date.now()
          const fullCheck = now - lastFullReauthAt >= WS_REAUTH_INTERVAL_MS
          if (fullCheck) lastFullReauthAt = now
          if (await isSocketStillAuthorized(opts.sessions, userId, sessionToken, fullCheck)) return
          if (closingForAuth) return
          closingForAuth = true
          request.log.info({ userId }, "ws: closing socket, session no longer valid")
          try {
            session.conn.send(
              serverFrame({ type: "error", code: "UNAUTHORIZED", message: "Your session ended." }),
            )
          } catch (err) {
            request.log.debug({ err }, "ws: reauth-reject send failed (socket already closing)")
          }
          socket.close(WS_CLOSE_POLICY_VIOLATION, "session no longer valid")
        })().catch(() => {})
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
        // FIRST: mark the session dead so a handler still mid-await (handleJoin) knows the rooms it is
        // about to register will never be seen by this pass, and undoes them itself.
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

      // Hand the buffer over to live dispatch. Buffered frames run SEQUENTIALLY, in arrival order (a
      // `join` sent immediately after onopen must be applied before the `send` that followed it), and the
      // loop re-reads the array so frames arriving mid-drain keep their place in line. Only then do later
      // frames go straight through, one fire-and-forget handler each, as before.
      const buffered = pending ?? []
      while (buffered.length > 0) {
        const raw = buffered.shift()
        if (raw === undefined) break
        // Release this frame's share of the byte budget as it leaves the buffer: a frame arriving MID-drain
        // is still appended by the listener above (that is how it keeps its place in line), and it should be
        // judged against what is currently held, not against the pre-drain peak.
        pendingBytes = Math.max(0, pendingBytes - Buffer.byteLength(raw, "utf8"))
        await runFrame(raw)
      }
      dropPending()
      onFrame = (raw: string): void => {
        void runFrame(raw)
      }
    })()
  })
}

export { wrapSocket }
