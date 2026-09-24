/**
 * The media presign endpoint is reachable without an account, and its only control was a 30/min/IP
 * REQUEST cap. Requests are the wrong unit: 30 requests x 50 MB x 60 minutes is 90 GB/hour from a
 * single source, against an orphan sweep that reclaims a bounded batch per hour. This meters the
 * declared byte size instead, so the budget is denominated in the resource actually consumed.
 *
 * Semantics mirror abuse/counter-store.ts exactly, with INCRBY in place of INCR: the TTL is applied only
 * while the key has none, so the window is anchored to the caller's first upload of the day and cannot
 * be extended by continuing to spend, while a key that lost its expiry still gets one.
 *
 * FAIL CLOSED: `charge` never swallows a store error. A meter that cannot be read must not silently
 * become "unlimited".
 */

import type { RedisClient } from "../adapters/redis.js"
import { attachAtomicIncrBy } from "../adapters/redis-incr.js"
import { MS_PER_SECOND } from "../lib/time.js"

/** Generous for a real reporter: a handful of photos and a short video. */
export const MEDIA_UPLOAD_BYTES_PER_DAY = 512 * 1024 * 1024

export const MEDIA_UPLOAD_BYTE_WINDOW_SECONDS = 24 * 60 * 60

/** Distinct bucket from every other abuse counter (see abuse/counter-store.ts). */
export const MEDIA_UPLOAD_BYTE_PREFIX = "abuse:media:bytes:"

export interface ByteMeter {
  /** Returns the running total after the add. */
  add(subject: string, bytes: number): Promise<number>
}

export class RedisByteMeter implements ByteMeter {
  private readonly incrBy: ReturnType<typeof attachAtomicIncrBy>

  constructor(redis: RedisClient) {
    this.incrBy = attachAtomicIncrBy(redis)
  }

  add(subject: string, bytes: number): Promise<number> {
    return this.incrBy(MEDIA_UPLOAD_BYTE_PREFIX + subject, bytes, MEDIA_UPLOAD_BYTE_WINDOW_SECONDS)
  }
}

/** Same create-anchored-TTL semantics as the Redis meter. */
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
        expiresAtMs: now + MEDIA_UPLOAD_BYTE_WINDOW_SECONDS * MS_PER_SECOND,
      })
      return Promise.resolve(bytes)
    }
    existing.total += bytes
    return Promise.resolve(existing.total)
  }
}
