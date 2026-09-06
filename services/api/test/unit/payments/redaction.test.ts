import { describe, expect, it } from "vitest"
import { scrubEvent } from "../../../src/errors/glitchtip.js"
import { PAN_RE, paymentErrorSnapshot, paymentFailure } from "../../../src/errors/payment-failure.js"

const HOSTILE_ERROR = {
  type: "StripeCardError",
  code: "card_declined",
  statusCode: 402,
  requestId: "req_abc",
  message: "Your card was declined: 4242424242424242",
  raw: {
    payment_method: { card: { number: "4242 4242 4242 4242", cvc: "737", exp_month: 12 } },
    source: { number: "4111111111111111" },
  },
  headers: { authorization: "Bearer sk_live_deadbeef" },
}

function digitsRuns(value: string): string[] {
  return [...value.matchAll(/\d{13,19}/g)].map((match) => match[0])
}

describe("payment error redaction", () => {
  it("keeps zero card digits in the classifier snapshot", () => {
    const serialized = JSON.stringify(paymentErrorSnapshot(HOSTILE_ERROR))
    expect(digitsRuns(serialized)).toEqual([])
    expect(serialized).not.toContain("737")
    expect(serialized).not.toContain("Bearer")
  })

  it("never echoes the provider message into the AppError", () => {
    const error = paymentFailure(HOSTILE_ERROR)
    expect(error.message).not.toContain("4242")
    expect(digitsRuns(error.message)).toEqual([])
  })

  it("does not attach the raw provider object to the AppError cause", () => {
    const error = paymentFailure(HOSTILE_ERROR)
    const serialized = JSON.stringify({ cause: (error as { cause?: unknown }).cause })
    expect(serialized).not.toContain("payment_method")
    expect(digitsRuns(serialized)).toEqual([])
  })

  it("PAN_RE matches every separated card form and no short id", () => {
    for (const pan of [
      "4242424242424242",
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
      "4111111111111",
      "4111111111111111111",
    ]) {
      expect(new RegExp(PAN_RE.source).test(pan)).toBe(true)
    }
    for (const safe of ["12345", "202605201200", "cs_test_a1b2c3"]) {
      expect(new RegExp(PAN_RE.source).test(safe)).toBe(false)
    }
  })
})

describe("glitchtip event scrubbing of payment context", () => {
  it("drops payment context out of extra and contexts", () => {
    const scrubbed = scrubEvent({
      extra: {
        donorEmail: "donor@example.org",
        cardLast4: "4242",
        clientSecret: "cs_test_secret",
        amountMinor: 5000,
      },
      contexts: { stripe: { authorization: "Bearer sk_live_x", token: "tok_1" } },
    })
    const serialized = JSON.stringify(scrubbed)
    expect(serialized).not.toContain("donor@example.org")
    expect(serialized).not.toContain("cs_test_secret")
    expect(serialized).not.toContain("sk_live_x")
    expect(serialized).toContain("5000")
  })

  it("scrubs an email out of an exception message", () => {
    const scrubbed = scrubEvent({
      exception: {
        values: [{ value: "donation failed for donor@example.org" }],
      },
    })
    expect(JSON.stringify(scrubbed)).not.toContain("donor@example.org")
  })
})
