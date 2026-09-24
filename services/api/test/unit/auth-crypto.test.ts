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

  it("generateNumericCode returns exactly N digits (zero-padded)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateNumericCode(6)
      expect(code).toMatch(/^\d{6}$/)
    }
  })

  it("constantTimeStringEqual matches only identical strings", () => {
    expect(constantTimeStringEqual("abc", "abc")).toBe(true)
    expect(constantTimeStringEqual("abc", "abd")).toBe(false)
    expect(constantTimeStringEqual("abc", "abcd")).toBe(false)
    expect(constantTimeStringEqual("", "")).toBe(true)
  })
})
