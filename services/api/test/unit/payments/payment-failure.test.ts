import { describe, expect, it } from "vitest"
import { ErrorCode } from "@civfix/shared"
import {
  PAN_RE,
  isLuhnValid,
  classifyPaymentFailure,
  paymentErrorSnapshot,
  paymentFailure,
  paymentFailureKind,
  scrubPan,
} from "../../../src/errors/payment-failure.js"

function stripeError(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    statusCode: 400,
    requestId: "req_123",
    message: "No such customer: cus_123",
    raw: {
      message: "No such customer",
      payment_method: { card: { number: "4242424242424242", cvc: "123", exp_year: 2030 } },
      source: { number: "4111111111111111" },
    },
    headers: { "stripe-account": "acct_1", authorization: "Bearer sk_live_abc" },
    ...patch,
  }
}

describe("payment failure classification", () => {
  it("treats connection and 5xx errors as indeterminate PAYMENT_UNAVAILABLE", () => {
    expect(classifyPaymentFailure(stripeError({ type: "StripeConnectionError" }))).toBe("unavailable")
    expect(classifyPaymentFailure(stripeError({ type: "StripeAPIError" }))).toBe("unavailable")
    expect(
      classifyPaymentFailure(stripeError({ type: "StripeUnknownError", statusCode: 503 })),
    ).toBe("unavailable")
    expect(paymentFailure(stripeError({ type: "StripeConnectionError" })).code).toBe(
      ErrorCode.PAYMENT_UNAVAILABLE,
    )
  })

  it("maps only the account-level invalid-request codes to PAYMENT_UNAVAILABLE", () => {
    expect(classifyPaymentFailure(stripeError({ code: "account_invalid" }))).toBe("unavailable")
    expect(classifyPaymentFailure(stripeError({ code: "charges_disabled" }))).toBe("unavailable")
    expect(classifyPaymentFailure(stripeError({ code: "resource_missing" }))).toBe("internal")
    expect(paymentFailure(stripeError({ code: "resource_missing" })).code).toBe(ErrorCode.INTERNAL)
  })

  it("maps rate limits, idempotency conflicts, signature and auth failures", () => {
    expect(classifyPaymentFailure(stripeError({ type: "StripeRateLimitError" }))).toBe("rate_limited")
    expect(classifyPaymentFailure(stripeError({ type: "StripeIdempotencyError" }))).toBe("conflict")
    expect(
      classifyPaymentFailure(stripeError({ type: "StripeSignatureVerificationError" })),
    ).toBe("unauthorized")
    expect(classifyPaymentFailure(stripeError({ type: "StripeAuthenticationError" }))).toBe("internal")
    expect(classifyPaymentFailure(stripeError({ type: "StripePermissionError" }))).toBe("internal")
    expect(paymentFailure(stripeError({ type: "StripeRateLimitError" })).code).toBe(
      ErrorCode.RATE_LIMITED,
    )
    expect(paymentFailure(stripeError({ type: "StripeIdempotencyError" })).code).toBe(
      ErrorCode.CONFLICT,
    )
    expect(paymentFailure(stripeError({ type: "StripeSignatureVerificationError" })).code).toBe(
      ErrorCode.UNAUTHORIZED,
    )
  })

  it("never echoes the provider message and tags the failure kind", () => {
    const error = paymentFailure(stripeError({ type: "StripeConnectionError" }))
    expect(error.message).not.toContain("No such customer")
    expect(paymentFailureKind(error)).toBe("unavailable")
  })

  it("classifies a non-object as internal without throwing", () => {
    expect(classifyPaymentFailure(null)).toBe("internal")
    expect(classifyPaymentFailure("boom")).toBe("internal")
    expect(paymentErrorSnapshot(undefined)).toEqual({
      type: null,
      code: null,
      statusCode: null,
      requestId: null,
    })
  })
})

describe("payment error snapshot", () => {
  it("extracts only type, code, statusCode and requestId", () => {
    const snapshot = paymentErrorSnapshot(stripeError({}))
    expect(Object.keys(snapshot).sort()).toEqual(["code", "requestId", "statusCode", "type"])
    expect(snapshot).toEqual({
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      statusCode: 400,
      requestId: "req_123",
    })
  })

  it("carries no raw, no payment_method, no headers and no 13+ digit run", () => {
    const serialized = JSON.stringify(paymentErrorSnapshot(stripeError({})))
    expect(serialized).not.toContain('"raw"')
    expect(serialized).not.toContain("payment_method")
    expect(serialized).not.toContain('"source"')
    expect(serialized).not.toContain('"headers"')
    expect(serialized).not.toContain("4242")
    expect(serialized.match(/\d{13,19}/)).toBeNull()
    expect(PAN_RE.test(serialized)).toBe(false)
  })

  it("survives an error whose fields are hostile types", () => {
    const snapshot = paymentErrorSnapshot({
      type: 42,
      code: { toString: () => "x" },
      statusCode: "500",
      requestId: "",
    })
    expect(snapshot).toEqual({ type: null, code: null, statusCode: null, requestId: null })
  })
})

describe("PAN scrubbing", () => {
  it("redacts bare and separated card numbers", () => {
    expect(scrubPan("card 4242424242424242 declined")).toBe("card [redacted-pan] declined")
    expect(scrubPan("4242 4242 4242 4242")).toBe("[redacted-pan]")
    expect(scrubPan("4242-4242-4242-4242")).toBe("[redacted-pan]")
  })

  it("redacts every brand's real test PAN", () => {
    for (const pan of [
      "4111111111111111",
      "5555555555554444",
      "378282246310005",
      "6011111111111117",
      "4222222222222",
    ]) {
      expect(scrubPan(`declined ${pan}`)).toBe("declined [redacted-pan]")
    }
  })

  it("leaves short digit runs alone so ids and amounts stay readable", () => {
    expect(scrubPan("amount 12500 cents")).toBe("amount 12500 cents")
    expect(scrubPan("req_1234567890")).toBe("req_1234567890")
  })

  it("leaves long digit runs that are not Luhn-valid alone: timestamps and ids survive", () => {
    expect(scrubPan("at 1780000000000 ms")).toBe("at 1780000000000 ms")
    expect(scrubPan("request 1234567890123456")).toBe("request 1234567890123456")
    expect(isLuhnValid("4242424242424242")).toBe(true)
    expect(isLuhnValid("4242424242424243")).toBe(false)
  })
})
