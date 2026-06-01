/**
 * CounterStore seam: the tiny slice of a hot counter the API-layer abuse stack needs.
 *
 * The IP-rate-limit and H3-per-cell controls each need an atomic "increment a counter whose key has a
 * TTL anchored to the first hit in the window" primitive - exactly Redis INCR + (conditional) EXPIRE.
 * Confining that to a 1-method interface means:
 *   - the real adapter (ioredis) is trivial and confined to one file, and
 *   - an in-memory implementation with an injectable clock lets every counter-driven control (the
 *     N-per-hour caps, window rollover) be unit-tested with no Redis and no Docker.
 *
 * Semantics mirror Redis exactly: `incr` creates the key at 1 and applies `ttlSeconds` ONLY on
 * creation; an existing key keeps its original expiry, so the window is anchored to its first hit.
 * This is the same contract as auth/cache.ts CacheClient.incr; CounterStore is intentionally the
 * narrower seam (just incr) so the abuse modules cannot reach for unrelated cache verbs.
 */

import type { RedisClient } from "../adapters/redis.js"

export interface CounterStore {
  /**
   * Atomically increment the integer counter at `key`, returning the new value. When this call creates
   * the key, its expiry is set to `ttlSeconds` from now; an already-existing key keeps its original
   * expiry (the window is anchored to the first hit, exactly like INCR followed by EXPIRE-if-new).
   */
  incr(key: string, ttlSeconds: number): Promise<number>
}

/** A clock returning epoch milliseconds. Overridable in tests to exercise TTL rollover deterministically. */
export type Clock = () => number

interface Entry {
  count: number
  /** Epoch ms at which the entry expires. */
  expiresAtMs: number
}

/**
 * In-memory CounterStore for local unit tests. Single-process and not shared, which is exactly what a
 * counter unit test wants. A custom `clock` lets a test advance time to roll a window over without
 * real waiting.
 */
export class InMemoryCounterStore implements CounterStore {
  private readonly store = new Map<string, Entry>()
  private readonly clock: Clock

  constructor(clock: Clock = () => Date.now()) {
    this.clock = clock
  }

  /** Return the live entry for a key, pruning it if it has expired. */
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

  /** Test helper: peek the current value of a counter without incrementing (0 when absent/expired). */
  peek(key: string): number {
    return this.live(key)?.count ?? 0
  }
}

/**
 * Real CounterStore backed by ioredis. The only place ioredis verbs are issued for the abuse counters.
 * Uses INCR and, on the first hit of a window, EXPIRE to anchor the TTL.
 */
export class RedisCounterStore implements CounterStore {
  private readonly redis: RedisClient

  constructor(redis: RedisClient) {
    this.redis = redis
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const next = await this.redis.incr(key)
    if (next === 1) {
      // First hit in this window: anchor the expiry. Later hits leave it untouched.
      await this.redis.expire(key, Math.max(1, Math.ceil(ttlSeconds)))
    }
    return next
  }
}
