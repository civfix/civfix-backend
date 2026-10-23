// GH#215 / D8: clears are queued per user in Redis and sent as one silent push within 10 seconds by a
// pg-boss job keyed per user. The queue below dedupes pending jobs by singletonKey the way pg-boss's
// "short" policy does; Redis is ioredis-mock.

import { beforeEach, describe, expect, it } from "vitest"
import RedisMock from "ioredis-mock"
import type { EnqueueOptions, JobHandler, Jobs } from "@civfix/seams"
import {
  MultiPushSender,
  type PlatformDispatcher,
  type PushDelivery,
  type PushLogger,
} from "../../src/adapters/push-sender.js"
import { RedisPendingClears, pendingClearsKey } from "../../src/adapters/push-clears.js"
import type { RedisClient } from "../../src/adapters/redis.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makePushClearJobHandler } from "../../src/services/push-clear-jobs.js"
import { PUSH_CLEAR_JOB } from "../../src/lib/queue-names.js"
import { fakePushDb, type PushTokenRow } from "../helpers/push-db.js"
import { N, N1, N2, P } from "../helpers/push-fixtures.js"

interface QueuedJob {
  id: string
  name: string
  data: unknown
  opts: EnqueueOptions | undefined
}

class SingletonQueue implements Pick<Jobs, "enqueue"> {
  readonly pending: QueuedJob[] = []
  private seq = 0

  enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string> {
    const key = opts?.singletonKey
    if (key !== undefined && this.pending.some((j) => j.name === name && j.opts?.singletonKey === key)) {
      return Promise.resolve("")
    }
    this.seq += 1
    const id = `job-${this.seq}`
    this.pending.push({ id, name, data, opts })
    return Promise.resolve(id)
  }

  async runAll(handler: JobHandler): Promise<void> {
    for (const job of this.pending.splice(0)) await handler({ id: job.id, data: job.data })
  }
}

function recording(): { fn: PlatformDispatcher; deliveries: PushDelivery[] } {
  const deliveries: PushDelivery[] = []
  const fn: PlatformDispatcher = (batch) => {
    deliveries.push(...batch)
    return Promise.resolve({ invalidTokens: [] })
  }
  return { fn, deliveries }
}

const quiet: PushLogger = { warn: () => {}, error: () => {} }
const I1 = "ab".repeat(32)

let redis: RedisClient

beforeEach(async () => {
  redis = new RedisMock() as unknown as RedisClient
  await redis.flushall()
})

function harness(rows: PushTokenRow[], counters = new InMemoryCounterStore(() => 1_000)) {
  const ios = recording()
  const android = recording()
  const web = recording()
  const queue = new SingletonQueue()
  const fake = fakePushDb(rows)
  const sender = new MultiPushSender({
    db: fake.db,
    config: {},
    dispatchers: { ios: ios.fn, android: android.fn, web: web.fn },
    counters,
    logger: quiet,
    clears: { jobs: queue, pending: new RedisPendingClears(() => redis) },
  })
  const handler = makePushClearJobHandler(sender, quiet)
  return { ios, android, web, queue, fake, sender, handler, counters }
}

function dataOf(d: PushDelivery): Record<string, string> {
  expect(d.message.kind).toBe("clear")
  if (d.message.kind !== "clear") throw new Error("not a clear")
  const target = d.message.target
  return "all" in target
    ? { kind: "clear", all: "true" }
    : { kind: "clear", ids: JSON.stringify(target.ids) }
}

const nativeRows: PushTokenRow[] = [
  { userId: "u1", platform: "ios", token: I1 },
  { userId: "u1", platform: "android", token: "A1" },
]

describe("MultiPushSender.clear and the clear flush job", () => {
  it("T17: two clears within the window become one job and one silent push per device", async () => {
    const h = harness(nativeRows)

    await h.sender.clear("u1", { ids: [N1] })
    // pg-boss holds the first job for its 10 s start delay, so a clear 2 s later finds it still pending.
    await h.sender.clear("u1", { ids: [N2] })

    expect(h.queue.pending).toHaveLength(1)
    const job = h.queue.pending[0]!
    expect(job.name).toBe(PUSH_CLEAR_JOB)
    expect(job.opts?.singletonKey).toContain("u1")
    expect(job.opts?.startAfter).toBe(10)

    await h.queue.runAll(h.handler)

    expect(h.ios.deliveries.map((d) => d.token)).toEqual([I1])
    expect(h.android.deliveries.map((d) => d.token)).toEqual(["A1"])
    for (const d of [...h.ios.deliveries, ...h.android.deliveries]) {
      const data = dataOf(d)
      expect(Object.keys(data).sort()).toEqual(["ids", "kind"])
      expect((JSON.parse(data.ids!) as string[]).sort()).toEqual([N1, N2])
    }
    expect(await redis.scard(pendingClearsKey("u1"))).toBe(0)
  })

  it("T18: an all-clear after an id clear sends only all", async () => {
    const h = harness(nativeRows)

    await h.sender.clear("u1", { ids: [N1] })
    await h.sender.clear("u1", { all: true })
    await h.queue.runAll(h.handler)

    for (const d of [...h.ios.deliveries, ...h.android.deliveries]) {
      expect(dataOf(d)).toEqual({ kind: "clear", all: "true" })
    }
    expect(h.ios.deliveries).toHaveLength(1)
  })

  it("T19: 101 pending ids become all; exactly 100 stay a list", async () => {
    const over = harness(nativeRows)
    await over.sender.clear("u1", { ids: Array.from({ length: 60 }, (_, i) => N(i + 1)) })
    await over.sender.clear("u1", { ids: Array.from({ length: 41 }, (_, i) => N(i + 61)) })
    await over.queue.runAll(over.handler)
    expect(over.ios.deliveries).toHaveLength(1)
    expect(dataOf(over.ios.deliveries[0]!)).toEqual({ kind: "clear", all: "true" })

    await redis.flushall()
    const exact = harness(nativeRows)
    const hundred = Array.from({ length: 100 }, (_, i) => N(i + 1))
    await exact.sender.clear("u1", { ids: hundred })
    await exact.queue.runAll(exact.handler)
    expect(exact.ios.deliveries).toHaveLength(1)
    const data = dataOf(exact.ios.deliveries[0]!)
    expect((JSON.parse(data.ids!) as string[]).sort()).toEqual(hundred)
  })

  it("T20: web tokens never get a clear, and a web-only user gets nothing", async () => {
    const web = '{"endpoint":"https://push.example.test/1","keys":{"p256dh":"x","auth":"y"}}'
    const h = harness([...nativeRows, { userId: "u1", platform: "web", token: web }, {
      userId: "u2",
      platform: "web",
      token: web.replace("/1", "/2"),
    }])

    await h.sender.clear("u1", { ids: [N1] })
    await h.sender.clear("u2", { ids: [N2] })
    await h.queue.runAll(h.handler)

    expect(h.web.deliveries).toEqual([])
    expect(h.ios.deliveries.map((d) => d.token)).toEqual([I1])
    expect(h.android.deliveries.map((d) => d.token)).toEqual(["A1"])
  })

  it("T23: the 31st flush within a minute sends nothing and completes", async () => {
    const h = harness(nativeRows)

    for (let i = 1; i <= 30; i++) {
      await h.sender.clear("u1", { ids: [N(i)] })
      await h.queue.runAll(h.handler)
      expect(h.ios.deliveries).toHaveLength(i)
      expect(h.android.deliveries).toHaveLength(i)
    }
    await h.sender.clear("u1", { ids: [N(31)] })
    await expect(h.queue.runAll(h.handler)).resolves.toBeUndefined()

    expect(h.ios.deliveries).toHaveLength(30)
    expect(h.android.deliveries).toHaveLength(30)
    expect(h.web.deliveries).toHaveLength(0)
  })

  it("T24: clears and visible pushes have separate budgets", async () => {
    const h = harness(nativeRows)
    for (let i = 1; i <= 30; i++) {
      await h.sender.clear("u1", { ids: [N(i)] })
      await h.queue.runAll(h.handler)
    }
    expect(h.counters.peek("push:rate:u1")).toBe(0)

    await h.sender.sendEach([{ userId: "u1", payload: P(N1, null) }])
    const visible = h.ios.deliveries.filter((d) => d.message.kind === "notification")
    expect(visible.map((d) => d.token)).toEqual([I1])

    const fresh = new InMemoryCounterStore(() => 1_000)
    for (let i = 0; i < 60; i++) await fresh.incr("push:rate:u1", 60)
    await redis.flushall()
    const capped = harness(nativeRows, fresh)
    await capped.sender.clear("u1", { ids: [N1] })
    await capped.queue.runAll(capped.handler)
    expect(capped.ios.deliveries.map((d) => d.message.kind)).toEqual(["clear"])
    expect(capped.android.deliveries.map((d) => d.message.kind)).toEqual(["clear"])
  })

  it("T27: a stored Expo token is revoked by a flush and gets no clear; the FCM token does", async () => {
    const expo = "ExpoPushToken[x]"
    const h = harness([
      { userId: "u1", platform: "android", token: expo },
      { userId: "u1", platform: "android", token: "A1" },
    ])

    await h.sender.clear("u1", { ids: [N1] })
    await h.queue.runAll(h.handler)

    expect(h.fake.rows.find((r) => r.token === expo)!.revokedAt).toBeInstanceOf(Date)
    expect(h.android.deliveries.map((d) => d.token)).toEqual(["A1"])
    expect(h.ios.deliveries).toEqual([])
  })
})
