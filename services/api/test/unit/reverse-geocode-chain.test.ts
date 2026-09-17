import { describe, it, expect } from "vitest"
import { chainReverse, type PointResolver } from "../../src/adapters/reverse-geocode.chain.js"

/**
 * chainReverse is generic over the answer shape - the real seam carries a structured
 * { line, precision, provider }, but the ORDERING contract under test here is about which provider
 * answers first, not what it answers with, so a bare string keeps the assertions readable.
 */
type StringResolver = PointResolver<string>

const ok =
  (label: string): StringResolver =>
  async () =>
    label
const nul: StringResolver = async () => null

describe("chainReverse", () => {
  it("returns the first non-null result", async () => {
    expect(await chainReverse(nul, ok("A"), ok("B"))(1, 2)).toBe("A")
  })
  it("returns null when all providers return null", async () => {
    expect(await chainReverse(nul, nul)(1, 2)).toBeNull()
  })
  it("skips null/undefined providers", async () => {
    expect(await chainReverse(null, undefined, ok("C"))(1, 2)).toBe("C")
  })
  it("honors order (earlier provider wins)", async () => {
    expect(await chainReverse(ok("first"), ok("second"))(1, 2)).toBe("first")
  })
})
