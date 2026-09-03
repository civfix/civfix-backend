
import { describe, it, expect, vi } from "vitest"
import {
  makeWebPushDispatcher,
  WebPushDeadlineError,
  type PinnedAgentPool,
} from "../../src/adapters/push-webpush.js"
import type { Agent } from "node:https"
import type { PushLogger } from "../../src/adapters/push-sender.js"

const PUBLIC_ENDPOINT = "https://93.184.216.34/push/abc"

function subscriptionToken(endpoint = PUBLIC_ENDPOINT): string {
  return JSON.stringify({
    endpoint,
    keys: { p256dh: Buffer.alloc(65, 7).toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") },
  })
}

function silentLogger(): PushLogger & { warns: unknown[][] } {
  const warns: unknown[][] = []
  return {
    warns,
    warn: (obj, msg) => warns.push([obj, msg]),
    error: () => {},
  }
}

function stubPool(): PinnedAgentPool & { dropped: string[] } {
  const dropped: string[] = []
  return {
    dropped,
    get: () => ({}) as Agent,
    drop: (address, family) => dropped.push(`${family}|${address}`),
    sweep: () => {},
    destroyAll: () => {},
    stats: () => ({ cached: 0, retiring: 0 }),
  }
}

function config(overrides: Record<string, unknown>) {
  return {
    publicKey: "pub",
    privateKey: "priv",
    subject: "mailto:ops@civfix.org",
    ...overrides,
  } as Parameters<typeof makeWebPushDispatcher>[0]
}

describe("web push request deadline (H15)", () => {
  it("passes an explicit numeric timeout to web-push (without it the library arms nothing)", async () => {
    const calls: Array<Record<string, unknown>> = []
    const dispatch = makeWebPushDispatcher(
      config({
        timeoutMs: 50,
        loadModule: () =>
          Promise.resolve({
            setVapidDetails: () => {},
            sendNotification: (_sub: unknown, _body: unknown, options: Record<string, unknown>) => {
              calls.push(options)
              return Promise.resolve({ statusCode: 201 })
            },
          }),
      }),
      silentLogger(),
      stubPool(),
    )

    await dispatch([subscriptionToken()], { title: "hi" })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.timeout).toBe(50)
    expect(calls[0]!.agent).toBeDefined()
  })

  it("settles within the hard deadline when sendNotification NEVER resolves, and drops the pinned agent", async () => {
    vi.useFakeTimers()
    try {
      const pool = stubPool()
      const logger = silentLogger()
      const dispatch = makeWebPushDispatcher(
        config({
          timeoutMs: 1_000,
          loadModule: () =>
            Promise.resolve({
              setVapidDetails: () => {},
              sendNotification: () => new Promise(() => {}),
            }),
        }),
        logger,
        pool,
      )

      const settled = { done: false }
      const run = dispatch([subscriptionToken()], { title: "hi" }).then((r) => {
        settled.done = true
        return r
      })

      await vi.advanceTimersByTimeAsync(500)
      expect(settled.done).toBe(false)

      await vi.advanceTimersByTimeAsync(3_000)
      const result = await run
      expect(settled.done).toBe(true)
      expect(result.invalidTokens).toEqual([])
      expect(pool.dropped).toEqual(["4|93.184.216.34"])
      expect(logger.warns.some(([, msg]) => String(msg).includes("hard deadline"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops dispatching once the whole-batch budget is spent instead of serializing hangs", async () => {
    vi.useFakeTimers()
    try {
      const logger = silentLogger()
      const dispatch = makeWebPushDispatcher(
        config({
          timeoutMs: 1_000,
          batchBudgetMs: 4_000,
          loadModule: () =>
            Promise.resolve({
              setVapidDetails: () => {},
              sendNotification: () => new Promise(() => {}),
            }),
        }),
        logger,
        stubPool(),
      )

      const tokens = Array.from({ length: 40 }, (_, i) =>
        subscriptionToken(`https://93.184.216.34/push/${i}`),
      )
      const run = dispatch(tokens, { title: "hi" })
      await vi.advanceTimersByTimeAsync(60_000)
      await run

      expect(logger.warns.some(([, msg]) => String(msg).includes("batch budget exhausted"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("WebPushDeadlineError names the deadline it broke", () => {
    expect(new WebPushDeadlineError(10_000).message).toContain("10000ms")
  })
})
