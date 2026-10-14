import type { RedisClient } from "../adapters/redis.js"
import { attachAtomicIncr } from "../adapters/redis-incr.js"

export interface CacheClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
  mget?(keys: string[]): Promise<(string | null)[]>
  incr(key: string, ttlSeconds: number): Promise<number>
  sadd(key: string, ...members: string[]): Promise<number>
  srem(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  smismember(key: string, members: readonly string[]): Promise<number[]>
  scard(key: string): Promise<number>
  expire(key: string, ttlSeconds: number): Promise<void>
  expireNx(key: string, ttlSeconds: number): Promise<void>
}

export type Clock = () => number

interface Entry {
  value: string
  expiresAtMs: number
}

interface SetEntry {
  members: Set<string>
  expiresAtMs: number
}

export class InMemoryCacheClient implements CacheClient {
  private readonly store = new Map<string, Entry>()
  private readonly sets = new Map<string, SetEntry>()
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

  private liveSet(key: string): SetEntry | undefined {
    const entry = this.sets.get(key)
    if (!entry) return undefined
    if (entry.expiresAtMs <= this.clock()) {
      this.sets.delete(key)
      return undefined
    }
    return entry
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    let entry = this.liveSet(key)
    if (!entry) {
      entry = { members: new Set<string>(), expiresAtMs: Number.POSITIVE_INFINITY }
      this.sets.set(key, entry)
    }
    let added = 0
    for (const member of members) {
      if (!entry.members.has(member)) {
        entry.members.add(member)
        added += 1
      }
    }
    return Promise.resolve(added)
  }

  srem(key: string, ...members: string[]): Promise<number> {
    const entry = this.liveSet(key)
    if (!entry) return Promise.resolve(0)
    let removed = 0
    for (const member of members) {
      if (entry.members.delete(member)) removed += 1
    }
    return Promise.resolve(removed)
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.liveSet(key)?.members ?? [])])
  }

  smismember(key: string, members: readonly string[]): Promise<number[]> {
    const entry = this.liveSet(key)
    return Promise.resolve(members.map((member) => (entry?.members.has(member) ? 1 : 0)))
  }

  scard(key: string): Promise<number> {
    return Promise.resolve(this.liveSet(key)?.members.size ?? 0)
  }

  expire(key: string, ttlSeconds: number): Promise<void> {
    const at = this.clock() + ttlSeconds * 1000
    const setEntry = this.liveSet(key)
    if (setEntry) setEntry.expiresAtMs = at
    const entry = this.live(key)
    if (entry) entry.expiresAtMs = at
    return Promise.resolve()
  }

  expireNx(key: string, ttlSeconds: number): Promise<void> {
    const at = this.clock() + ttlSeconds * 1000
    const setEntry = this.liveSet(key)
    if (setEntry && !Number.isFinite(setEntry.expiresAtMs)) setEntry.expiresAtMs = at
    const entry = this.live(key)
    if (entry && !Number.isFinite(entry.expiresAtMs)) entry.expiresAtMs = at
    return Promise.resolve()
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

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0
    return this.redis.sadd(key, ...members)
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0
    return this.redis.srem(key, ...members)
  }

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key)
  }

  async smismember(key: string, members: readonly string[]): Promise<number[]> {
    if (members.length === 0) return []
    return this.redis.smismember(key, [...members])
  }

  async scard(key: string): Promise<number> {
    return this.redis.scard(key)
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, Math.max(1, Math.ceil(ttlSeconds)))
  }

  async expireNx(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, Math.max(1, Math.ceil(ttlSeconds)), "NX")
  }
}
