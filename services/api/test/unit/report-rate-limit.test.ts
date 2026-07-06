import { describe, it, expect } from "vitest"
import { makeTokenBucketLimiter } from "../../src/ws/report-rate-limit.js"

describe("makeTokenBucketLimiter", () => {
  it("allows up to capacity, denies once empty, and refills over time", () => {
    let t = 0
    const limiter = makeTokenBucketLimiter({ capacity: 2, refillPerSec: 1, now: () => t })
    expect(limiter.tryConsume("k")).toBe(true)
    expect(limiter.tryConsume("k")).toBe(true)
    expect(limiter.tryConsume("k")).toBe(false)
    t = 1000
    expect(limiter.tryConsume("k")).toBe(true)
    expect(limiter.tryConsume("k")).toBe(false)
  })

  it("meters each key independently", () => {
    const limiter = makeTokenBucketLimiter({ capacity: 1, refillPerSec: 0 })
    expect(limiter.tryConsume("a")).toBe(true)
    expect(limiter.tryConsume("a")).toBe(false)
    expect(limiter.tryConsume("b")).toBe(true)
  })

  it("does not evict resident keys while under maxKeys", () => {
    const limiter = makeTokenBucketLimiter({ capacity: 1, refillPerSec: 0, maxKeys: 50 })
    expect(limiter.tryConsume("a")).toBe(true)
    expect(limiter.tryConsume("b")).toBe(true)
    expect(limiter.tryConsume("a")).toBe(false)
    expect(limiter.tryConsume("b")).toBe(false)
  })

  it("hard-caps the key set at maxKeys, evicting the least-recently-used depleted bucket (F86)", () => {
    const limiter = makeTokenBucketLimiter({ capacity: 1, refillPerSec: 0, maxKeys: 2 })
    expect(limiter.tryConsume("a")).toBe(true)
    expect(limiter.tryConsume("b")).toBe(true)
    expect(limiter.tryConsume("c")).toBe(true)
    expect(limiter.tryConsume("b")).toBe(false)
    expect(limiter.tryConsume("a")).toBe(true)
  })
})
