import { beforeEach, describe, expect, it } from "vitest"
import RedisMock from "ioredis-mock"
import type { RedisClient } from "../../src/adapters/redis.js"
import {
  MEDIA_UPLOAD_BYTE_PREFIX,
  MEDIA_UPLOAD_BYTE_WINDOW_SECONDS,
  RedisByteMeter,
} from "../../src/services/media-byte-quota.js"

const SUBJECT = "ip:203.0.113.7"
const KEY = MEDIA_UPLOAD_BYTE_PREFIX + SUBJECT
const ELAPSED_WINDOW_MS = 3_000

function freshRedis(): RedisClient {
  return new RedisMock()
}

describe("RedisByteMeter keeps a fixed daily window", () => {
  beforeEach(async () => {
    await freshRedis().flushall()
  })

  it("does not restart the window when a zero-byte charge created the key", async () => {
    const redis = freshRedis()
    const meter = new RedisByteMeter(redis)

    await meter.add(SUBJECT, 0)
    await redis.pexpire(KEY, ELAPSED_WINDOW_MS)
    await expect(meter.add(SUBJECT, 5)).resolves.toBe(5)

    const ttl = await redis.pttl(KEY)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(ELAPSED_WINDOW_MS)
  })

  it("gives a budget key that lost its expiry a fresh window instead of locking the subject out forever", async () => {
    const redis = freshRedis()
    const meter = new RedisByteMeter(redis)
    await redis.set(KEY, "1024")

    await expect(meter.add(SUBJECT, 2048)).resolves.toBe(3072)
    const ttl = await redis.pttl(KEY)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(MEDIA_UPLOAD_BYTE_WINDOW_SECONDS * 1000)
  })

  it("anchors the window on the first charge and does not extend it on later spend", async () => {
    const redis = freshRedis()
    const meter = new RedisByteMeter(redis)

    await expect(meter.add(SUBJECT, 100)).resolves.toBe(100)
    expect(await redis.pttl(KEY)).toBeGreaterThan(ELAPSED_WINDOW_MS)
    await redis.pexpire(KEY, ELAPSED_WINDOW_MS)
    await expect(meter.add(SUBJECT, 200)).resolves.toBe(300)

    expect(await redis.pttl(KEY)).toBeLessThanOrEqual(ELAPSED_WINDOW_MS)
  })
})
