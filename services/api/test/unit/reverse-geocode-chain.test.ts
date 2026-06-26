import { describe, it, expect } from "vitest"
import { chainReverse, type ReverseGeocode } from "../../src/adapters/reverse-geocode.chain.js"

const ok =
  (label: string): ReverseGeocode =>
  async () =>
    label
const nul: ReverseGeocode = async () => null

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
