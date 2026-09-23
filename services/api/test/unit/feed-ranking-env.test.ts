import { describe, expect, it } from "vitest"
import { DEFAULT_FEED_RANKING } from "@civfix/shared"
import { loadEnv } from "../../src/env.js"

function load(feedRanking?: string) {
  return loadEnv({
    NODE_ENV: "test",
    ...(feedRanking === undefined ? {} : { FEED_RANKING: feedRanking }),
  })
}

describe("FEED_RANKING env var", () => {
  it("falls back to the full default profile when unset", () => {
    expect(load().FEED_RANKING).toEqual(DEFAULT_FEED_RANKING)
  })

  it("treats blank and whitespace as unset, so a commented-out SOPS line is safe", () => {
    expect(load("").FEED_RANKING).toEqual(DEFAULT_FEED_RANKING)
    expect(load("   ").FEED_RANKING).toEqual(DEFAULT_FEED_RANKING)
  })

  it("merges a partial override onto the defaults", () => {
    const env = load('{"halfLifeHours":12,"followWeight":70}')
    expect(env.FEED_RANKING.halfLifeHours).toBe(12)
    expect(env.FEED_RANKING.followWeight).toBe(70)
    expect(env.FEED_RANKING.minScore).toBe(DEFAULT_FEED_RANKING.minScore)
  })

  it("accepts a full profile", () => {
    const env = load(JSON.stringify(DEFAULT_FEED_RANKING))
    expect(env.FEED_RANKING).toEqual(DEFAULT_FEED_RANKING)
  })

  it("refuses to boot on malformed JSON, naming the variable", () => {
    expect(() => load("{not json")).toThrow(/FEED_RANKING: must be a JSON object/)
  })

  it("refuses to boot on a typo'd knob rather than silently ignoring it", () => {
    expect(() => load('{"folowWeight":70}')).toThrow(/FEED_RANKING/)
  })

  it("refuses to boot on an out-of-range value, naming the knob", () => {
    expect(() => load('{"decayFloor":1.5}')).toThrow(/FEED_RANKING\.decayFloor/)
  })

  it("accepts a jitterAmount override, including switching jitter off entirely", () => {
    expect(load('{"jitterAmount":0.4}').FEED_RANKING.jitterAmount).toBe(0.4)
    expect(load('{"jitterAmount":0}').FEED_RANKING.jitterAmount).toBe(0)
    expect(load('{"jitterAmount":1}').FEED_RANKING.jitterAmount).toBe(1)
  })

  it("keeps the rest of the profile intact when only jitterAmount is overridden", () => {
    const env = load('{"jitterAmount":0.05}')
    expect(env.FEED_RANKING).toEqual({ ...DEFAULT_FEED_RANKING, jitterAmount: 0.05 })
  })

  it("refuses an out-of-range jitterAmount rather than clamping it", () => {
    expect(() => load('{"jitterAmount":1.5}')).toThrow(/FEED_RANKING\.jitterAmount/)
    expect(() => load('{"jitterAmount":-0.1}')).toThrow(/FEED_RANKING\.jitterAmount/)
    expect(() => load('{"jitterAmount":"0.2"}')).toThrow(/FEED_RANKING\.jitterAmount/)
  })

  it("refuses a JSON scalar where an object is required", () => {
    expect(() => load("42")).toThrow(/FEED_RANKING/)
    expect(() => load('"forty-two"')).toThrow(/FEED_RANKING/)
  })

  it("reports every bad knob at once, in the one-throw boot list", () => {
    try {
      load('{"decayFloor":1.5,"halfLifeHours":0}')
      expect.unreachable("loadEnv should have thrown")
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain("FEED_RANKING.decayFloor")
      expect(message).toContain("FEED_RANKING.halfLifeHours")
    }
  })
})
