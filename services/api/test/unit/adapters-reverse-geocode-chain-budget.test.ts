// The deadline half of chainReverse regressed: one 5s ceiling handed whole to the first provider left
// the fallback ~1s after a 4s-timeout stall, so the fallback came back empty. The budget is now split
// `remaining / providers-left`. vitest fakes Date.now too, which is what the chain measures with.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { chainReverse, type PointResolver } from "../../src/adapters/reverse-geocode.chain.js"

// A string answer keeps these assertions about the clock, not the result shape.
type StringResolver = PointResolver<string>

function hangs(calls: number[]): StringResolver {
  return () => {
    calls.push(Date.now())
    return new Promise<string | null>(() => {})
  }
}

function answersAfter(afterMs: number, value: string | null, calls: number[]): StringResolver {
  return () => {
    calls.push(Date.now())
    return new Promise<string | null>((resolve) => {
      setTimeout(() => resolve(value), afterMs)
    })
  }
}

describe("chainReverse budget", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("abandons a hung first provider at half the budget and still asks the fallback", async () => {
    const calls: number[] = []
    const start = Date.now()
    const promise = chainReverse(hangs(calls), answersAfter(500, "fallback", calls))(1, 2)

    await vi.advanceTimersByTimeAsync(2_400)
    expect(calls.map((t) => t - start)).toEqual([0])

    // 2500 = 5000 / 2 providers: the stall is cut off here, not at its own 4000 timeout.
    await vi.advanceTimersByTimeAsync(200)
    expect(calls.map((t) => t - start)).toEqual([0, 2_500])

    await vi.advanceTimersByTimeAsync(500)
    await expect(promise).resolves.toBe("fallback")
  })

  it("gives the fallback the first provider's UNUSED share when it answers fast", async () => {
    const calls: number[] = []
    const promise = chainReverse(
      answersAfter(200, null, calls),
      answersAfter(4_500, "slow-but-worth-waiting-for", calls),
    )(1, 2)

    // The old shape (one 5s ceiling, ~1s left for provider 2) could not have returned this at all.
    await vi.advanceTimersByTimeAsync(4_800)
    await expect(promise).resolves.toBe("slow-but-worth-waiting-for")
  })

  it("stays bounded by the total budget when every provider hangs", async () => {
    const calls: number[] = []
    const start = Date.now()
    const promise = chainReverse(hangs(calls), hangs(calls), hangs(calls))(1, 2)

    // 5000/3, then remaining/2, then the rest: three attempts, one total deadline.
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(promise).resolves.toBeNull()
    expect(calls.length).toBe(3)
    expect(calls.map((t) => t - start)).toEqual([0, 1_667, 3_334])
  })

  it("gives a lone provider the whole budget", async () => {
    const calls: number[] = []
    const promise = chainReverse(answersAfter(4_900, "only", calls))(1, 2)
    await vi.advanceTimersByTimeAsync(4_900)
    await expect(promise).resolves.toBe("only")
  })

  it("a provider that rejects late (after losing the race) does not surface as an unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      const late: StringResolver = () =>
        new Promise<string | null>((_resolve, reject) => {
          setTimeout(() => reject(new Error("vendor blew up after we gave up")), 3_000)
        })
      const promise = chainReverse(late, late)(1, 2)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(promise).resolves.toBeNull()
      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})
