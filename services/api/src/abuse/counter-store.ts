/**
 * CounterStore seam: the tiny slice of a hot counter the API-layer abuse stack needs.
 *
 * Semantics mirror Redis exactly: `incr` creates the key at 1 and applies `ttlSeconds` ONLY on
 * creation; an existing key keeps its original expiry, so the window is anchored to its first hit.
 * Same contract as auth/cache.ts CacheClient.incr; CounterStore is intentionally the narrower seam
 * (just incr) so the abuse modules cannot reach for unrelated cache verbs.
 */

import type { RedisClient } from "../adapters/redis.js"
import { attachAtomicIncr } from "../adapters/redis-incr.js"

export interface CounterStore {
  incr(key: string, ttlSeconds: number): Promise<number>
}

export type Clock = () => number

interface Entry {
  count: number
  expiresAtMs: number
}

export class InMemoryCounterStore implements CounterStore {
  private readonly store = new Map<string, Entry>()
  private readonly clock: Clock

  constructor(clock: Clock = () => Date.now()) {
    this.clock = clock
  }

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAtMs <= this.clock()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  incr(key: string, ttlSeconds: number): Promise<number> {
    const existing = this.live(key)
    if (!existing) {
      this.store.set(key, { count: 1, expiresAtMs: this.clock() + ttlSeconds * 1000 })
      return Promise.resolve(1)
    }
    existing.count += 1
    return Promise.resolve(existing.count)
  }

  peek(key: string): number {
    return this.live(key)?.count ?? 0
  }
}

export class RedisCounterStore implements CounterStore {
  // Atomic INCR + PEXPIRE-on-create in one round-trip: a crash between INCR and EXPIRE would otherwise
  // strand a TTL-less counter and rate-limit that IP / H3 cell forever (see adapters/redis-incr.ts).
  private readonly atomicIncr: (key: string, ttlSeconds: number) => Promise<number>

  constructor(redis: RedisClient) {
    this.atomicIncr = attachAtomicIncr(redis)
  }

  incr(key: string, ttlSeconds: number): Promise<number> {
    return this.atomicIncr(key, ttlSeconds)
  }
}
