import { describe, it, expect } from "vitest"
import { redactEmails } from "../../src/errors/email-redaction.js"

const R = "[R]"

describe("redactEmails", () => {
  it.each([
    ["contact user@example.com now", "contact [R] now"],
    ["a.b+tag%x_y-z@sub.domain.org", "[R]"],
    ["mailto:Jane.Doe@Example.COM>", "mailto:[R]>"],
    ["first@a.io,second@b.io", "[R],[R]"],
    ["no at sign here", "no at sign here"],
    ["user@localhost", "user@localhost"],
    ["user@.com", "user@.com"],
    ["user@a.c", "user@a.c"],
    ["x@1.2.3.4", "x@1.2.3.4"],
    ["@example.com", "@example.com"],
    ["user@", "user@"],
    ["user@@example.com", "user@@example.com"],
    ["é@example.com", "é@example.com"],
  ])("redacts %j as %j", (input, expected) => {
    expect(redactEmails(input, R)).toBe(expected)
  })

  it.each([
    // The domain backtracks to the last dot followed by two letters and stops at the first non-letter.
    ["x@a.b.c1.de9", "[R]9"],
    ["x@a.bc1", "[R]1"],
    ["x@a-b.co.uk-", "[R]-"],
    ["x@a.bc.d", "[R].d"],
    ["end.@x.org.", "[R]."],
    // The next search starts where the previous match ended, not at the start of a character run.
    ["a@b.com%x@y.io", "[R][R]"],
    ["a@b.comx@y.io", "[R]@y.io"],
  ])("keeps the exact match boundaries for %j", (input, expected) => {
    expect(redactEmails(input, R)).toBe(expected)
  })

  it.each([
    ["a run of local-part characters with no @", "%".repeat(200_000)],
    ["a domain of dots without a TLD", `a@${"1.".repeat(100_000)}`],
    ["repeated @ signs", "a@".repeat(100_000)],
  ])("finishes fast on %s", (_label, input) => {
    const started = performance.now()
    expect(redactEmails(input, R)).toBe(input)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
