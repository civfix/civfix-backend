
import type { RedisClient } from "../adapters/redis.js"
import { attachAtomicIncr } from "../adapters/redis-incr.js"

export interface CacheClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
  mget?(keys: string[]): Promise<(string | null)[]>
  incr(key: string, ttlSeconds: number): Promise<number>
}

export type Clock = () => number

interface Entry {
  value: string
  expiresAtMs: number
}

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

  mget(keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((key) => this.live(key)?.value ?? null))
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

  size(): number {
    return this.store.size
  }

  expiryOf(key: string): number | null {
    const entry = this.live(key)
    return entry ? entry.expiresAtMs : null
  }
}

export class RedisCacheClient implements CacheClient {
  private readonly redis: RedisClient
  private readonly atomicIncr: (key: string, ttlSeconds: number) => Promise<number>

  constructor(redis: RedisClient) {
    this.redis = redis
    this.atomicIncr = attachAtomicIncr(redis)
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

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return []
    return this.redis.mget(...keys)
  }

  incr(key: string, ttlSeconds: number): Promise<number> {
    return this.atomicIncr(key, ttlSeconds)
  }
}
