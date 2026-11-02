import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import {
  TOKEN_BYTES,
  generateToken,
  sha256Hex,
  randomIntBelow,
  generateNumericCode,
  constantTimeStringEqual,
} from "../../src/auth/crypto.js"

describe("auth crypto", () => {
  it("sha256Hex matches node's crypto and is stable + 64 hex chars", async () => {
    const input = "the-quick-brown-fox"
    const ours = await sha256Hex(input)
    const node = createHash("sha256").update(input, "utf8").digest("hex")
    expect(ours).toBe(node)
    expect(ours).toMatch(/^[0-9a-f]{64}$/)
    expect(await sha256Hex(input)).toBe(ours)
  })

  it("generateToken yields a 256-bit base64url value, unique per call", () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toBe(b)
    expect(Buffer.from(a, "base64url").length).toBe(TOKEN_BYTES)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("randomIntBelow stays in [0, max) and covers the full range", () => {
    const seen = new Set<number>()
    for (let i = 0; i < 5000; i++) {
      const n = randomIntBelow(10)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(10)
      seen.add(n)
    }
    // Over 5000 draws every digit 0-9 should appear.
    expect(seen.size).toBe(10)
  })

  it("randomIntBelow is unbiased where a single-byte modulo would not be", () => {
    // 256 % 200 = 56, so `byte % 200` would land in [0, 56) with probability 112/256 = 0.4375 instead of
    // 56/200 = 0.28. Over 200k draws the standard error is about 0.001, so 0.01 is a 10-sigma bound.
    const draws = 200_000
    let low = 0
    let outOfRange = 0
    for (let i = 0; i < draws; i++) {
      const n = randomIntBelow(200)
      if (!Number.isInteger(n) || n < 0 || n >= 200) outOfRange++
      if (n < 56) low++
    }
    expect(outOfRange).toBe(0)
    expect(Math.abs(low / draws - 56 / 200)).toBeLessThan(0.01)
  })

  it("randomIntBelow draws each digit about equally often", () => {
    const draws = 100_000
    const counts = new Array<number>(10).fill(0)
    for (let i = 0; i < draws; i++) counts[randomIntBelow(10)]!++
    // Each bucket expects 10k with a standard deviation near 95; 600 is a six-sigma bound.
    for (const count of counts) expect(Math.abs(count - draws / 10)).toBeLessThan(600)
  })

  it("randomIntBelow refuses a max that is not a positive integer", () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(() => randomIntBelow(max)).toThrow()
    }
    expect(randomIntBelow(1)).toBe(0)
  })

  it("generateNumericCode returns exactly N digits (zero-padded)", () => {
    const leading = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const code = generateNumericCode(6)
      expect(code).toMatch(/^\d{6}$/)
      leading.add(code[0]!)
    }
    expect(leading.has("0")).toBe(true)
  })

  it("constantTimeStringEqual matches only identical strings", () => {
    expect(constantTimeStringEqual("abc", "abc")).toBe(true)
    expect(constantTimeStringEqual("abc", "abd")).toBe(false)
    expect(constantTimeStringEqual("abc", "abcd")).toBe(false)
    expect(constantTimeStringEqual("", "")).toBe(true)
  })
})
