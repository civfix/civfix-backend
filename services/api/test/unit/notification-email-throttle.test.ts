// GH#225 / D10: the Redis store behind the notification email limits. One email per person and
// conversation per hour, 20 per person per hour, each batch in a fixed number of round trips. Redis is
// ioredis-mock.

import { beforeEach, describe, expect, it, vi } from "vitest"
import RedisMock from "ioredis-mock"
import type { RedisClient } from "../../src/adapters/redis.js"
import {
  NOTIFICATION_EMAILS_PER_HOUR,
  RedisNotificationEmailThrottle,
} from "../../src/adapters/notification-email-throttle.js"

const U = "aaaaaaaa-0000-4000-8000-000000000001"
const V = "bbbbbbbb-0000-4000-8000-000000000002"
const HOUR_SECONDS = 3600

let redis: RedisClient
let throttle: RedisNotificationEmailThrottle

beforeEach(async () => {
  redis = new RedisMock()
  await redis.flushall()
  throttle = new RedisNotificationEmailThrottle(() => redis)
})

const chat = (userId: string, conversation = "/messages/dm/R1") => ({ userId, conversation })
const plain = (userId: string) => ({ userId, conversation: null })

describe("RedisNotificationEmailThrottle", () => {
  it("grants one email per person and conversation, with an hour's TTL on each key", async () => {
    expect(await throttle.claim([chat(U), chat(V)])).toEqual([true, true])
    expect(await throttle.claim([chat(U), chat(V), chat(U, "/messages/dm/R2")])).toEqual([
      false,
      false,
      true,
    ])

    const conv = await redis.ttl(`notifemail:conv:${U}:/messages/dm/R1`)
    const cap = await redis.ttl(`notifemail:cap:${U}`)
    expect(conv).toBeGreaterThan(HOUR_SECONDS - 5)
    expect(conv).toBeLessThanOrEqual(HOUR_SECONDS)
    expect(cap).toBeGreaterThan(HOUR_SECONDS - 5)
    expect(await redis.get(`notifemail:cap:${U}`)).toBe("2")
  })

  it("caps a person at 20 an hour, and a refused chat email gives its conversation back", async () => {
    const twenty = Array.from({ length: NOTIFICATION_EMAILS_PER_HOUR }, () => plain(U))
    expect(await throttle.claim(twenty)).toEqual(twenty.map(() => true))

    expect(await throttle.claim([plain(U), chat(U), plain(V)])).toEqual([false, false, true])
    expect(await redis.exists(`notifemail:conv:${U}:/messages/dm/R1`)).toBe(0)
  })

  it("a chat email refused by its conversation key does not count toward the cap", async () => {
    await throttle.claim([chat(U)])
    for (let i = 0; i < 5; i++) await throttle.claim([chat(U)])

    expect(await redis.get(`notifemail:cap:${U}`)).toBe("1")
  })

  it("answers a batch in two MULTI round trips when nothing is refused", async () => {
    const multi = vi.spyOn(redis, "multi")
    await throttle.claim([chat(U), plain(V)])
    expect(multi).toHaveBeenCalledTimes(2)

    multi.mockClear()
    await throttle.claim([plain(U), plain(V)])
    expect(multi).toHaveBeenCalledTimes(1)
  })

  it("release gives back the count and the conversation, and never opens a window", async () => {
    await throttle.claim([chat(U), plain(U)])
    await throttle.release([chat(U)])

    expect(await redis.get(`notifemail:cap:${U}`)).toBe("1")
    expect(await redis.exists(`notifemail:conv:${U}:/messages/dm/R1`)).toBe(0)

    await throttle.release([plain(V)])
    expect(await redis.exists(`notifemail:cap:${V}`)).toBe(0)
  })

  it("surfaces a Redis failure to the caller, which skips the email", async () => {
    vi.spyOn(redis, "multi").mockImplementation(() => {
      throw new Error("connection is closed")
    })
    await expect(throttle.claim([plain(U)])).rejects.toThrow("connection is closed")
  })
})
