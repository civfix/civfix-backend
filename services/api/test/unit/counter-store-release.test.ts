import { beforeEach, describe, expect, it } from "vitest"
import RedisMock from "ioredis-mock"
import type { RedisClient } from "../../src/adapters/redis.js"
import {
  InMemoryCounterStore,
  RedisCounterStore,
  type CounterStore,
} from "../../src/abuse/counter-store.js"

const WINDOW_SECONDS = 60
const ELAPSED_WINDOW_MS = 3_000

function freshRedis(): RedisClient {
  return new RedisMock() as unknown as RedisClient
}

const stores: Array<[string, () => { store: CounterStore; redis?: RedisClient }]> = [
  ["in-memory", () => ({ store: new InMemoryCounterStore() })],
  [
    "redis",
    () => {
      const redis = freshRedis()
      return { store: new RedisCounterStore(redis), redis }
    },
  ],
]

describe.each(stores)("%s counter store gives back a charge", (_name, make) => {
  beforeEach(async () => {
    await freshRedis().flushall()
  })

  it("lowers a live count by the amount given back", async () => {
    const { store } = make()
    await store.incrBy("slots", 3, WINDOW_SECONDS)
    await expect(store.decrBy("slots", 1)).resolves.toBe(2)
    await expect(store.incr("slots", WINDOW_SECONDS)).resolves.toBe(3)
  })

  it("never counts below zero", async () => {
    const { store } = make()
    await store.incr("slots", WINDOW_SECONDS)
    await expect(store.decrBy("slots", 5)).resolves.toBe(0)
    await expect(store.incr("slots", WINDOW_SECONDS)).resolves.toBe(1)
  })

  it("leaves a missing key missing, so a give-back cannot open a window of its own", async () => {
    const { store, redis } = make()
    await expect(store.decrBy("absent", 1)).resolves.toBe(0)
    if (redis !== undefined) expect(await redis.exists("absent")).toBe(0)
    await expect(store.incr("absent", WINDOW_SECONDS)).resolves.toBe(1)
  })
})

describe("redis counter store give-back keeps the window", () => {
  it("does not extend or restart the expiry of the key it lowers", async () => {
    const redis = freshRedis()
    const store = new RedisCounterStore(redis)
    await store.incrBy("slots", 2, WINDOW_SECONDS)
    await redis.pexpire("slots", ELAPSED_WINDOW_MS)

    await store.decrBy("slots", 1)

    const ttl = await redis.pttl("slots")
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(ELAPSED_WINDOW_MS)
  })
})
