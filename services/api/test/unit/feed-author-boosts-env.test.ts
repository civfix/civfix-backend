import { describe, expect, it } from "vitest"
import { loadEnv } from "../../src/env.js"
import { authorBoost } from "../../src/services/feed-ranking.js"

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

function load(boosts?: string) {
  return loadEnv({
    NODE_ENV: "test",
    ...(boosts === undefined ? {} : { FEED_AUTHOR_BOOSTS: boosts }),
  })
}

function expectNoBoosts(env: ReturnType<typeof load>): void {
  expect(env.FEED_AUTHOR_BOOSTS.size).toBe(0)
  for (const id of [A, B, C]) expect(authorBoost(env.FEED_AUTHOR_BOOSTS, id)).toBe(1)
}

describe("FEED_AUTHOR_BOOSTS env var", () => {
  it("T1: boots with no author boosted when unset", () => {
    expectNoBoosts(load())
  })

  it("T2: boots with no author boosted when blank", () => {
    expectNoBoosts(load(""))
    expectNoBoosts(load("   "))
  })

  it("T3: maps each listed author to its multiplier and everyone else to 1", () => {
    const boosts = load(JSON.stringify({ [A]: 1.5, [B]: 2 })).FEED_AUTHOR_BOOSTS
    expect(authorBoost(boosts, A)).toBe(1.5)
    expect(authorBoost(boosts, B)).toBe(2)
    expect(authorBoost(boosts, C)).toBe(1)
  })

  it("T4: accepts the inclusive bounds 1 and 5", () => {
    const boosts = load(JSON.stringify({ [A]: 1, [B]: 5 })).FEED_AUTHOR_BOOSTS
    expect(authorBoost(boosts, A)).toBe(1)
    expect(authorBoost(boosts, B)).toBe(5)
  })

  it("T5: refuses malformed JSON, naming the variable", () => {
    expect(() => load("{not json")).toThrow(/FEED_AUTHOR_BOOSTS/)
  })

  it("T6: refuses a value that is not an object", () => {
    expect(() => load("[1.5]")).toThrow(/FEED_AUTHOR_BOOSTS/)
    expect(() => load("1.5")).toThrow(/FEED_AUTHOR_BOOSTS/)
    expect(() => load("null")).toThrow(/FEED_AUTHOR_BOOSTS/)
  })

  it("T7: refuses a key that is not a UUID", () => {
    expect(() => load('{"roman":1.5}')).toThrow(/FEED_AUTHOR_BOOSTS/)
  })

  it("T8: refuses a multiplier outside 1..5", () => {
    for (const multiplier of [0.99, 5.01, 0, -1]) {
      expect(() => load(JSON.stringify({ [A]: multiplier }))).toThrow(/FEED_AUTHOR_BOOSTS/)
    }
  })

  it("T9: refuses a multiplier that is not a JSON number", () => {
    expect(() => load(JSON.stringify({ [A]: "1.5" }))).toThrow(/FEED_AUTHOR_BOOSTS/)
    expect(() => load(JSON.stringify({ [A]: null }))).toThrow(/FEED_AUTHOR_BOOSTS/)
  })
})

describe("FEED_AUTHOR_BOOSTS env var: details", () => {
  it("never quotes a user ID or a multiplier in the boot error", () => {
    expect(() => load(JSON.stringify({ [A]: 7.25 }))).toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(new RegExp(`${A}|7\\.25`)) }),
    )
  })

  it("matches an upper-case key against the lower-case user ID postgres returns", () => {
    const boosts = load(JSON.stringify({ [A.toUpperCase()]: 2 })).FEED_AUTHOR_BOOSTS
    expect(authorBoost(boosts, A)).toBe(2)
  })

  it("refuses the same user ID listed twice in different case", () => {
    expect(() => load(JSON.stringify({ [A]: 2, [A.toUpperCase()]: 3 }))).toThrow(
      /FEED_AUTHOR_BOOSTS: lists the same user ID twice/,
    )
  })
})
