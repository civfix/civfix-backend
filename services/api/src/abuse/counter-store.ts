
import type { RedisClient } from "../adapters/redis.js"
import { attachAtomicIncr, attachAtomicIncrBy } from "../adapters/redis-incr.js"

export interface CounterStore {
  incr(key: string, ttlSeconds: number): Promise<number>
  incrBy(key: string, by: number, ttlSeconds: number): Promise<number>
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
    return this.incrBy(key, 1, ttlSeconds)
  }

  incrBy(key: string, by: number, ttlSeconds: number): Promise<number> {
    const amount = Math.max(0, Math.floor(by))
    const existing = this.live(key)
    if (!existing) {
      this.store.set(key, { count: amount, expiresAtMs: this.clock() + ttlSeconds * 1000 })
      return Promise.resolve(amount)
    }
    existing.count += amount
    return Promise.resolve(existing.count)
  }

  peek(key: string): number {
    return this.live(key)?.count ?? 0
  }
}

export class RedisCounterStore implements CounterStore {
  private readonly atomicIncr: (key: string, ttlSeconds: number) => Promise<number>
  private readonly atomicIncrBy: (key: string, by: number, ttlSeconds: number) => Promise<number>

  constructor(redis: RedisClient) {
    this.atomicIncr = attachAtomicIncr(redis)
    this.atomicIncrBy = attachAtomicIncrBy(redis)
  }

  incr(key: string, ttlSeconds: number): Promise<number> {
    return this.atomicIncr(key, ttlSeconds)
  }

  incrBy(key: string, by: number, ttlSeconds: number): Promise<number> {
    return this.atomicIncrBy(key, by, ttlSeconds)
  }
}
