import type { FastifyBaseLogger } from "fastify"
import type { ChatMessageDTO, RoomKind, WsServerMessage } from "@civfix/shared"
import { unrefSleep } from "../lib/sleep.js"
import { MS_PER_SECOND } from "../lib/time.js"
import { settleWithin } from "../lib/timeout.js"

export const SEND_DEDUPE_TTL_SECONDS = 24 * 60 * 60

export const SEND_DEDUPE_PENDING_TTL_SECONDS = 60

export const SEND_DEDUPE_PENDING = "pending"

export const SEND_DEDUPE_INFLIGHT_ATTEMPTS = 5

export const SEND_DEDUPE_INFLIGHT_DELAY_MS = 100

export const BROADCAST_ATTEMPTS = 3

const BROADCAST_BACKOFF_MS: readonly number[] = [100, 250]

const BROADCAST_ATTEMPT_TIMEOUT_MS = 2000

const RESERVE_TIMEOUT_MS = 1000

const DEDUPE_WARN_INTERVAL_MS = 60_000

const SEND_DEDUPE_KEY_PREFIX = "chat:send:"

const DEDUPE_LOG_COMPONENT = "chat-send-dedupe"

export type SendReservation =
  | { state: "reserved" }
  | { state: "duplicate"; messageId: string }
  | { state: "open" }

export interface SendDedupeStore {
  reserve(key: string): Promise<SendReservation>
  commit(key: string, messageId: string): Promise<void>
  release(key: string): Promise<void>
}

export function sendDedupeKey(userId: string, roomKey: string, clientId: string): string {
  return `${SEND_DEDUPE_KEY_PREFIX}${userId}:${roomKey}:${clientId}`
}

const IN_MEMORY_SWEEP_THRESHOLD = 5000

export class InMemorySendDedupeStore implements SendDedupeStore {
  private readonly store = new Map<string, { value: string; expiresAtMs: number }>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  private live(key: string): string | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAtMs <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  private put(key: string, value: string, ttlSeconds: number): void {
    const at = this.now()
    if (this.store.size >= IN_MEMORY_SWEEP_THRESHOLD) {
      for (const [k, entry] of this.store) {
        if (entry.expiresAtMs <= at) this.store.delete(k)
      }
    }
    this.store.set(key, { value, expiresAtMs: at + ttlSeconds * MS_PER_SECOND })
  }

  reserve(key: string): Promise<SendReservation> {
    const existing = this.live(key)
    if (existing === undefined) {
      this.put(key, SEND_DEDUPE_PENDING, SEND_DEDUPE_PENDING_TTL_SECONDS)
      return Promise.resolve({ state: "reserved" })
    }
    if (existing === SEND_DEDUPE_PENDING) return Promise.resolve({ state: "open" })
    return Promise.resolve({ state: "duplicate", messageId: existing })
  }

  commit(key: string, messageId: string): Promise<void> {
    this.put(key, messageId, SEND_DEDUPE_TTL_SECONDS)
    return Promise.resolve()
  }

  release(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }

  size(): number {
    return this.store.size
  }
}

export type FindRoomMessage = (
  kind: RoomKind,
  roomId: string,
  messageId: string,
  viewerUserId: string,
) => Promise<ChatMessageDTO | null>

export type LocalDeliver = (
  roomKey: string,
  frame: WsServerMessage,
  excludeConnId: string | undefined,
) => number

export interface BroadcastFailure {
  roomKey: string
  messageId: string
  attempts: number
  failures: number
  localRecipients: number
}

export interface SendResilienceDeps {
  dedupe?: SendDedupeStore | undefined
  findRoomMessage?: FindRoomMessage | undefined
  deliverLocally?: LocalDeliver | undefined
  onBroadcastFailure?: ((info: BroadcastFailure) => void) | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
  jitter?: (() => number) | undefined
  attemptTimeoutMs?: number | undefined
  logger?: Pick<FastifyBaseLogger, "warn"> | undefined
  reserveTimeoutMs?: number | undefined
  now?: (() => number) | undefined
}

export interface RoomBroadcaster {
  broadcast(
    roomKey: string,
    message: ChatMessageDTO,
    opts?: { excludeConnId?: string },
  ): Promise<void>
}

export interface SendResilience {
  reserve(key: string): Promise<SendReservation>
  commit(key: string, messageId: string): Promise<void>
  release(key: string): Promise<void>
  findRoomMessage: FindRoomMessage
  broadcastMessage(
    chat: RoomBroadcaster,
    roomKey: string,
    message: ChatMessageDTO,
    excludeConnId: string,
  ): Promise<void>
  dedupeFailureCount(): number
}

const OPEN: SendReservation = { state: "open" }

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return settleWithin(work, ms, { timeoutError: () => new Error("timed out"), unref: true })
}

export function makeRateLimitedWarn(
  logger: Pick<FastifyBaseLogger, "warn"> | undefined,
  intervalMs: number,
  now: () => number,
): (payload: Record<string, unknown>, message: string) => void {
  const lastAt = new Map<string, number>()
  let suppressed = 0
  return (payload, message) => {
    if (!logger) return
    const at = now()
    const previous = lastAt.get(message)
    if (previous !== undefined && at - previous < intervalMs) {
      suppressed += 1
      return
    }
    lastAt.set(message, at)
    logger.warn({ ...payload, ...(suppressed > 0 ? { suppressed } : {}) }, message)
    suppressed = 0
  }
}

export function makeSendResilience(deps: SendResilienceDeps = {}): SendResilience {
  const sleep = deps.sleep ?? unrefSleep
  const jitter = deps.jitter ?? Math.random
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? BROADCAST_ATTEMPT_TIMEOUT_MS
  const reserveTimeoutMs = deps.reserveTimeoutMs ?? RESERVE_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())
  const warn = makeRateLimitedWarn(deps.logger, DEDUPE_WARN_INTERVAL_MS, now)
  let failures = 0
  let dedupeFailures = 0

  return {
    async reserve(key): Promise<SendReservation> {
      if (!deps.dedupe) return OPEN
      try {
        return await withTimeout(deps.dedupe.reserve(key), reserveTimeoutMs)
      } catch {
        dedupeFailures += 1
        warn(
          { component: DEDUPE_LOG_COMPONENT, op: "reserve", dedupeFailures },
          "chat: send dedupe unavailable; the send will insert without an idempotency reservation",
        )
        return OPEN
      }
    },
    commit: (key, messageId) =>
      deps.dedupe
        ? deps.dedupe.commit(key, messageId).catch(() => {
            dedupeFailures += 1
            warn(
              { component: DEDUPE_LOG_COMPONENT, op: "commit", dedupeFailures },
              "chat: send dedupe commit failed; a retry of this clientId may duplicate",
            )
          })
        : Promise.resolve(),
    release: (key) =>
      deps.dedupe
        ? deps.dedupe.release(key).catch(() => {
            dedupeFailures += 1
            warn(
              { component: DEDUPE_LOG_COMPONENT, op: "release", dedupeFailures },
              "chat: send dedupe release failed; the reservation will expire on its own",
            )
          })
        : Promise.resolve(),
    findRoomMessage: (kind, roomId, messageId, viewerUserId) =>
      deps.findRoomMessage
        ? deps.findRoomMessage(kind, roomId, messageId, viewerUserId).catch((err: unknown) => {
            deps.logger?.warn(
              { err, kind, roomId, messageId, component: DEDUPE_LOG_COMPONENT },
              "chat: idempotent re-ack lookup failed; the resend will insert a new message",
            )
            return null
          })
        : Promise.resolve(null),

    async broadcastMessage(chat, roomKey, message, excludeConnId): Promise<void> {
      for (let attempt = 0; attempt < BROADCAST_ATTEMPTS; attempt++) {
        try {
          await withTimeout(
            Promise.resolve(chat.broadcast(roomKey, message, { excludeConnId })),
            attemptTimeoutMs,
          )
          return
        } catch {
          const backoff = BROADCAST_BACKOFF_MS[attempt]
          if (backoff !== undefined) await sleep(backoff + Math.floor(jitter() * backoff))
        }
      }
      failures += 1
      let localRecipients = 0
      if (deps.deliverLocally) {
        try {
          localRecipients = deps.deliverLocally(
            roomKey,
            { type: "message", message },
            excludeConnId,
          )
        } catch {
          localRecipients = 0
        }
      }
      deps.onBroadcastFailure?.({
        roomKey,
        messageId: message.id,
        attempts: BROADCAST_ATTEMPTS,
        failures,
        localRecipients,
      })
    },

    dedupeFailureCount: () => dedupeFailures,
  }
}
