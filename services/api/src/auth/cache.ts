/**
 * CacheClient seam: the tiny slice of Redis the auth subsystem needs.
 *
 * The session service uses this for the write-through session cache; the OTP service uses it for the
 * sliding-window rate-limit counters. Keeping it to a 4-method interface means:
 *   - the real adapter (ioredis) is trivial and confined to one file, and
 *   - an in-memory implementation with an injectable clock lets every cache-dependent behavior
 *     (hit/miss, TTL expiry, sliding windows, rate-limit counters) be unit-tested with no Docker.
 *
 * Semantics mirror Redis: `get` returns null for a missing OR expired key; `set` with `ttlSeconds`
 * sets an absolute expiry; `incr` creates the key at 1 and only applies `ttlSeconds` on creation
 * (so a window's TTL is anchored to its first hit, exactly like INCR + EXPIRE-if-new).
 */

import type { RedisClient } from "../adapters/redis.js"

export interface CacheClient {
  /** Return the stored string, or null if absent / expired. */
  get(key: string): Promise<string | null>
  /** Store a string with an absolute TTL in seconds. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  /** Delete a key. No-op if absent. */
  del(key: string): Promise<void>
  /**
   * Atomically increment an integer counter, returning the new value. When the key is created by
   * this call, its expiry is set to `ttlSeconds` from now; existing keys keep their original expiry
   * (window anchored to first hit).
   */
  incr(key: string, ttlSeconds: number): Promise<number>
}

/** A monotonic-enough clock returning epoch milliseconds. Overridable in tests. */
export type Clock = () => number

interface Entry {
  value: string
  /** Epoch ms at which the entry expires; Infinity for no expiry. */
  expiresAtMs: number
}

/**
 * In-memory CacheClient for local tests. Single-process and not shared, which is exactly what a unit
 * test wants. A custom `clock` lets a test advance time deterministically to exercise TTL expiry and
 * sliding-window rate limits without real waiting.
 */
export class InMemoryCacheClient implements CacheClient {
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

  get(key: string): Promise<string | null> {
    const entry = this.live(key)
    return Promise.resolve(entry ? entry.value : null)
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAtMs: this.clock() + ttlSeconds * 1000 })
    return Promise.resolve()
  }

  del(key: string): Promise<void> {
    this.store.delete(key)
    return Promise.resolve()
  }

  incr(key: string, ttlSeconds: number): Promise<number> {
    const existing = this.live(key)
    if (!existing) {
      this.store.set(key, { value: "1", expiresAtMs: this.clock() + ttlSeconds * 1000 })
      return Promise.resolve(1)
    }
    const next = Number.parseInt(existing.value, 10) + 1
    existing.value = String(next)
    return Promise.resolve(next)
  }

  /** Test helper: number of currently-stored keys (expired entries are pruned lazily on access). */
  size(): number {
    return this.store.size
  }
}

/**
 * Real CacheClient backed by ioredis. The only place ioredis verbs are issued for auth. Uses SET ...
 * EX for TTL and INCR + (conditional) EXPIRE for counters.
 */
export class RedisCacheClient implements CacheClient {
  private readonly redis: RedisClient

  constructor(redis: RedisClient) {
    this.redis = redis
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key)
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", Math.max(1, Math.ceil(ttlSeconds)))
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key)
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
