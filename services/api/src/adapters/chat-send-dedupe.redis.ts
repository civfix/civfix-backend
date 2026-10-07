import type { RedisClient } from "./redis.js"
import {
  SEND_DEDUPE_INFLIGHT_ATTEMPTS,
  SEND_DEDUPE_INFLIGHT_DELAY_MS,
  SEND_DEDUPE_PENDING,
  SEND_DEDUPE_PENDING_TTL_SECONDS,
  SEND_DEDUPE_TTL_SECONDS,
  type SendDedupeStore,
  type SendReservation,
} from "../ws/send-resilience.js"
import { unrefSleep } from "../lib/sleep.js"
import { MS_PER_SECOND } from "../lib/time.js"

export interface RedisSendDedupeOptions {
  ttlSeconds?: number
  pendingTtlSeconds?: number
  inFlightAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

function wholeSecondsToMs(seconds: number): number {
  return Math.max(1, Math.ceil(seconds)) * MS_PER_SECOND
}

// Every Redis failure fails open: dedupe only suppresses retried duplicates, so an outage must not
// block chat sends, and the shared client's error handler already logs the outage itself.
const OPEN: SendReservation = { state: "open" }

export class RedisSendDedupeStore implements SendDedupeStore {
  private readonly redis: RedisClient
  private readonly ttlMs: number
  private readonly pendingTtlMs: number
  private readonly inFlightAttempts: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(redis: RedisClient, opts: RedisSendDedupeOptions = {}) {
    this.redis = redis
    this.ttlMs = wholeSecondsToMs(opts.ttlSeconds ?? SEND_DEDUPE_TTL_SECONDS)
    this.pendingTtlMs = wholeSecondsToMs(opts.pendingTtlSeconds ?? SEND_DEDUPE_PENDING_TTL_SECONDS)
    this.inFlightAttempts = opts.inFlightAttempts ?? SEND_DEDUPE_INFLIGHT_ATTEMPTS
    this.sleep = opts.sleep ?? unrefSleep
  }

  async reserve(key: string): Promise<SendReservation> {
    try {
      const taken = await this.redis.set(key, SEND_DEDUPE_PENDING, "PX", this.pendingTtlMs, "NX")
      if (taken === "OK") return { state: "reserved" }
      for (let attempt = 0; attempt < this.inFlightAttempts; attempt++) {
        const existing = await this.redis.get(key)
        if (existing === null) return OPEN
        if (existing !== SEND_DEDUPE_PENDING) return { state: "duplicate", messageId: existing }
        if (attempt + 1 < this.inFlightAttempts) await this.sleep(SEND_DEDUPE_INFLIGHT_DELAY_MS)
      }
      return OPEN
    } catch {
      return OPEN
    }
  }

  async commit(key: string, messageId: string): Promise<void> {
    try {
      await this.redis.set(key, messageId, "PX", this.ttlMs)
    } catch {
      return
    }
  }

  async release(key: string): Promise<void> {
    try {
      await this.redis.del(key)
    } catch {
      return
    }
  }
}
