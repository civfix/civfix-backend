/**
 * Cumulative presigned-BYTE quota for media uploads (security review M10).
 *
 * The media presign endpoint is reachable without an account, and its only control was a 30/min/IP
 * REQUEST cap. Requests are the wrong unit: 30 requests x 50 MB x 60 minutes is 90 GB/hour from a
 * single source, against an orphan sweep that reclaims a bounded batch per hour. This meters the
 * declared byte size instead, so the budget is denominated in the resource actually consumed.
 *
 * Semantics mirror abuse/counter-store.ts exactly, with INCRBY in place of INCR: the key is created at
 * `bytes` and the TTL is applied ONLY on creation, so the window is anchored to the caller's first
 * upload of the day and cannot be extended by continuing to spend.
 *
 * FAIL CLOSED: `charge` never swallows a store error. A meter that cannot be read must not silently
 * become "unlimited" — that is exactly the failure mode H4 flagged in the rate limiter.
 */

import type { RedisClient } from "../adapters/redis.js"

/** Per-subject daily budget. Generous for a real reporter (a handful of photos and a short video). */
export const MEDIA_UPLOAD_BYTES_PER_DAY = 512 * 1024 * 1024

/** Window length for the byte budget, in seconds. */
export const MEDIA_UPLOAD_BYTE_WINDOW_SECONDS = 24 * 60 * 60

/** Redis key prefix. Distinct bucket from every other abuse counter (see abuse/counter-store.ts). */
export const MEDIA_UPLOAD_BYTE_PREFIX = "abuse:media:bytes:"

export interface ByteMeter {
  /** Add `bytes` to the subject's window and return the running total after the add. */
  add(subject: string, bytes: number): Promise<number>
}

/**
 * Lua kept as a STATIC literal (never composed from input), matching adapters/redis-incr.ts: INCRBY +
 * PEXPIRE-on-create in ONE round-trip so a crash between the two cannot strand a TTL-less key and
 * lock a subject out of uploading forever.
 */
const INCRBY_EXPIRE_LUA =
  "local n = redis.call('INCRBY', KEYS[1], ARGV[1]); if n == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return n"

const COMMAND_NAME = "civfixIncrByExpire"

type WithIncrBy = RedisClient & {
  [COMMAND_NAME]?: (key: string, by: number, ttlMs: number) => Promise<unknown>
}

export class RedisByteMeter implements ByteMeter {
  private readonly client: WithIncrBy

  constructor(redis: RedisClient) {
    this.client = redis as WithIncrBy
    if (typeof this.client[COMMAND_NAME] !== "function") {
      redis.defineCommand(COMMAND_NAME, { numberOfKeys: 1, lua: INCRBY_EXPIRE_LUA })
    }
  }

  async add(subject: string, bytes: number): Promise<number> {
    const result = await this.client[COMMAND_NAME]!(
      MEDIA_UPLOAD_BYTE_PREFIX + subject,
      Math.max(0, Math.floor(bytes)),
      MEDIA_UPLOAD_BYTE_WINDOW_SECONDS * 1000,
    )
    return Number(result)
  }
}

/** In-memory meter for offline harnesses/tests. Same create-anchored-TTL semantics as the Redis one. */
export class InMemoryByteMeter implements ByteMeter {
  private readonly store = new Map<string, { total: number; expiresAtMs: number }>()
  private readonly clock: () => number

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock
  }

  add(subject: string, bytes: number): Promise<number> {
    const now = this.clock()
    const existing = this.store.get(subject)
    if (!existing || existing.expiresAtMs <= now) {
      this.store.set(subject, {
        total: bytes,
        expiresAtMs: now + MEDIA_UPLOAD_BYTE_WINDOW_SECONDS * 1000,
      })
      return Promise.resolve(bytes)
    }
    existing.total += bytes
    return Promise.resolve(existing.total)
  }
}
