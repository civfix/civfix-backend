import { beforeEach, describe, expect, it } from "vitest"
import RedisMock from "ioredis-mock"
import type { RedisClient } from "../../src/adapters/redis.js"
import { attachAtomicIncr, attachAtomicIncrBy } from "../../src/adapters/redis-incr.js"

const WINDOW_SECONDS = 60
const ELAPSED_WINDOW_MS = 3_000

function freshRedis(): RedisClient {
  return new RedisMock()
}

describe("atomic counters keep a fixed window", () => {
  beforeEach(async () => {
    await freshRedis().flushall()
  })

  it("does not restart the window when a zero increment created the key", async () => {
    const redis = freshRedis()
    const incrBy = attachAtomicIncrBy(redis)

    await incrBy("budget", 0, WINDOW_SECONDS)
    await redis.pexpire("budget", ELAPSED_WINDOW_MS)
    await incrBy("budget", 5, WINDOW_SECONDS)

    const ttl = await redis.pttl("budget")
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(ELAPSED_WINDOW_MS)
  })

  it("gives an INCRBY counter that lost its expiry a fresh window instead of living forever", async () => {
    const redis = freshRedis()
    const incrBy = attachAtomicIncrBy(redis)
    await redis.set("budget", "7")

    await expect(incrBy("budget", 2, WINDOW_SECONDS)).resolves.toBe(9)
    expect(await redis.pttl("budget")).toBeGreaterThan(0)
  })

  it("gives an INCR counter that lost its expiry a fresh window instead of living forever", async () => {
    const redis = freshRedis()
    const incr = attachAtomicIncr(redis)
    await redis.set("hits", "3")

    await expect(incr("hits", WINDOW_SECONDS)).resolves.toBe(4)
    expect(await redis.pttl("hits")).toBeGreaterThan(0)
  })

  it("starts the window on the first increment and leaves it alone afterwards", async () => {
    const redis = freshRedis()
    const incr = attachAtomicIncr(redis)

    await expect(incr("hits", WINDOW_SECONDS)).resolves.toBe(1)
    await redis.pexpire("hits", ELAPSED_WINDOW_MS)
    await expect(incr("hits", WINDOW_SECONDS)).resolves.toBe(2)

    expect(await redis.pttl("hits")).toBeLessThanOrEqual(ELAPSED_WINDOW_MS)
  })
})
