import { describe, it, expect } from "vitest"
import { stripTrailingSlashes } from "../../src/lib/base-url.js"

describe("stripTrailingSlashes", () => {
  it.each([
    ["https://api.civfix.org///", "https://api.civfix.org"],
    ["https://api.civfix.org", "https://api.civfix.org"],
    ["a//b/", "a//b"],
    ["/", ""],
    ["", ""],
    ["a/ ", "a/ "],
  ])("turns %j into %j", (input, expected) => {
    expect(stripTrailingSlashes(input)).toBe(expected)
  })

  it("finishes fast on a long run of slashes that is not trailing", () => {
    const input = `${"/".repeat(200_000)}a`
    const started = performance.now()
    expect(stripTrailingSlashes(input)).toBe(input)
    expect(stripTrailingSlashes("/".repeat(200_000))).toBe("")
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
