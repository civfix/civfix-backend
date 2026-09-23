import { describe, expect, it } from "vitest"
import { assertNoSlur, containsSlur } from "../../src/abuse/slur-filter.js"

describe("containsSlur - blocks hate slurs", () => {
  const blocked = [
    "you are a faggot",
    "what a retard",
    "that is retarded",
    "go back tranny",
    "stupid spic",
    "filthy kike",
    "a chink remark",
    "racist coon comment",
  ]
  for (const text of blocked) {
    it(`blocks: ${JSON.stringify(text)}`, () => {
      expect(containsSlur(text)).toBe(true)
    })
  }
})

describe("containsSlur - blocks obfuscated variants", () => {
  const obfuscated = [
    "n i g g e r",
    "n.i.g.g.e.r",
    "f@ggot",
    "f4ggot",
    "r3tard",
    "retaaaard",
    "f-a-g-g-o-t",
    "n1gger",
    " ret*ard",
    "nig.ger",
  ]
  for (const text of obfuscated) {
    it(`blocks obfuscated: ${JSON.stringify(text)}`, () => {
      expect(containsSlur(text)).toBe(true)
    })
  }
})

describe("containsSlur - passes innocent lookalikes (Scunthorpe problem)", () => {
  const innocent = [
    "Scunthorpe",
    "the assassin escaped",
    "what class are you in",
    "a secret passage",
    "Matsushita Electric",
    "the cockpit door",
    "Charles Dickens",
    "run the analysis again",
    "shuttlecock",
    "I visited Nigeria last year",
    "he was niggardly with praise",
    "Pakistan is large",
    "a Pakistani dish",
    "the cocoon opened",
    "a raccoon in the yard",
    "a tycoon's fortune",
    "the pothole on Main St is huge",
    "please fix the broken streetlight",
    "(5 pics) trash pile",
    "(5 pics) trash pile at the corner",
    "5 pic of the dumped couch",
    "co on down to the meeting",
  ]
  for (const text of innocent) {
    it(`passes: ${JSON.stringify(text)}`, () => {
      expect(containsSlur(text)).toBe(false)
    })
  }
})

describe("containsSlur - passes general profanity (slurs only)", () => {
  const profanity = [
    "this is shit",
    "what the fuck",
    "that damn pothole",
    "you are an ass",
    "stop being a bitch about it",
    "this is bullshit",
    "what an asshole driver",
  ]
  for (const text of profanity) {
    it(`passes profanity: ${JSON.stringify(text)}`, () => {
      expect(containsSlur(text)).toBe(false)
    })
  }
})

describe("containsSlur - null/empty", () => {
  it("returns false for null/undefined/empty/whitespace", () => {
    expect(containsSlur(null)).toBe(false)
    expect(containsSlur(undefined)).toBe(false)
    expect(containsSlur("")).toBe(false)
    expect(containsSlur("   ")).toBe(false)
  })
})

describe("assertNoSlur", () => {
  it("no-ops on null/empty/clean text", () => {
    expect(() => assertNoSlur(null)).not.toThrow()
    expect(() => assertNoSlur("")).not.toThrow()
    expect(() => assertNoSlur("a normal comment about a pothole")).not.toThrow()
    expect(() => assertNoSlur("this is shit")).not.toThrow()
  })

  it("throws a VALIDATION AppError keyed on the given field when a slur is present", () => {
    expect(() => assertNoSlur("you faggot", "body")).toThrowError()
    try {
      assertNoSlur("you faggot", "body")
      throw new Error("expected to throw")
    } catch (err) {
      expect(err).toMatchObject({ code: "VALIDATION" })
      expect((err as { fields?: Record<string, string> }).fields).toMatchObject({
        body: expect.any(String),
      })
    }
  })

  it("defaults the field to 'body' and supports a custom field", () => {
    try {
      assertNoSlur("a retard remark", "description")
      throw new Error("expected to throw")
    } catch (err) {
      expect((err as { fields?: Record<string, string> }).fields).toHaveProperty("description")
    }
  })
})
