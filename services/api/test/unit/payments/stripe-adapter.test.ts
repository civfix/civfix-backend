import { describe, expect, it } from "vitest"
import type Stripe from "stripe"
import {
  isAlreadyRefundedError,
  modeOfSecretKey,
  splitBalanceTransactionFees,
  StripePayments,
} from "../../../src/adapters/payments.stripe.js"

function adapter(client: unknown, secretKey = "rk_test_123"): StripePayments {
  return new StripePayments({
    secretKey,
    webhookSecrets: { connect: ["whsec_c"], platform: ["whsec_p"] },
    clientFactory: () => Promise.resolve(client as Stripe),
  })
}

function asyncList<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item
    },
  }
}

describe("stripe mode is derived from the configured key, never from NODE_ENV", () => {
  it("reads live only from a live key prefix", () => {
    expect(modeOfSecretKey("rk_live_abc")).toBe("live")
    expect(modeOfSecretKey("sk_live_abc")).toBe("live")
    expect(modeOfSecretKey("rk_test_abc")).toBe("test")
    expect(modeOfSecretKey("sk_test_abc")).toBe("test")
    expect(modeOfSecretKey("")).toBe("test")
  })

  it("stamps the connected account with the key's mode", async () => {
    const account = { id: "acct_1", charges_enabled: true, details_submitted: true }
    const live = adapter(
      { accounts: { retrieve: () => Promise.resolve(account) } },
      "rk_live_abc",
    )
    const test = adapter({ accounts: { retrieve: () => Promise.resolve(account) } })
    expect((await live.retrieveAccount("acct_1")).livemode).toBe(true)
    expect((await test.retrieveAccount("acct_1")).livemode).toBe(false)
    expect(live.mode()).toBe("live")
    expect(test.mode()).toBe("test")
  })
})

describe("balance transaction fee split", () => {
  it("separates the civfix application fee from the processor fee", () => {
    const split = splitBalanceTransactionFees(
      {
        amount: 10_000,
        fee: 820,
        net: 9180,
        fee_details: [
          { amount: 320, type: "stripe_fee" },
          { amount: 500, type: "application_fee" },
        ],
      },
      500,
    )
    expect(split.stripeFeeMinor).toBe(320)
    expect(split.applicationFeeMinor).toBe(500)
    expect(split.netMinor).toBe(9180)
    expect(split.netMinor).toBe(10_000 - split.stripeFeeMinor - split.applicationFeeMinor)
  })

  it("counts passthrough and tax details as processor fees", () => {
    const split = splitBalanceTransactionFees(
      {
        amount: 10_000,
        fee: 850,
        net: 9150,
        fee_details: [
          { amount: 320, type: "stripe_fee" },
          { amount: 30, type: "payment_method_passthrough_fee" },
          { amount: 500, type: "application_fee" },
        ],
      },
      500,
    )
    expect(split.stripeFeeMinor).toBe(350)
    expect(split.applicationFeeMinor).toBe(500)
  })

  it("falls back to the charge's application_fee_amount when fee_details is absent", () => {
    const split = splitBalanceTransactionFees({ amount: 10_000, fee: 820, net: 9180 }, 500)
    expect(split.stripeFeeMinor).toBe(320)
    expect(split.applicationFeeMinor).toBe(500)
    expect(split.netMinor).toBe(9180)
  })

  it("never reports a negative processor fee", () => {
    const split = splitBalanceTransactionFees({ amount: 10_000, fee: 300, net: 9700 }, 5000)
    expect(split.applicationFeeMinor).toBe(300)
    expect(split.stripeFeeMinor).toBe(0)
  })
})

describe("retrieveDonation", () => {
  it("returns the processor fee alone, not the sum Stripe charged the account", async () => {
    const payments = adapter({
      checkout: {
        sessions: {
          retrieve: () =>
            Promise.resolve({
              id: "cs_1",
              status: "complete",
              payment_status: "paid",
              amount_total: 10_000,
              livemode: true,
              payment_intent: {
                id: "pi_1",
                latest_charge: {
                  id: "ch_1",
                  created: 1780000000,
                  application_fee: "fee_1",
                  application_fee_amount: 500,
                  payment_method_details: { card: { brand: "visa", last4: "4242" } },
                  balance_transaction: {
                    amount: 10_000,
                    fee: 820,
                    net: 9180,
                    fee_details: [
                      { amount: 320, type: "stripe_fee" },
                      { amount: 500, type: "application_fee" },
                    ],
                  },
                },
              },
            }),
        },
      },
    })

    const snapshot = await payments.retrieveDonation("acct_1", "cs_1")
    expect(snapshot.stripeFeeMinor).toBe(320)
    expect(snapshot.applicationFeeMinor).toBe(500)
    expect(snapshot.netMinor).toBe(9180)
    expect(snapshot.chargeId).toBe("ch_1")
    expect(snapshot.applicationFeeId).toBe("fee_1")
    expect(snapshot.livemode).toBe(false)
  })
})

describe("listRefunds", () => {
  it("re-retrieves every refund on the charge", async () => {
    const payments = adapter({
      refunds: {
        list: () =>
          asyncList([
            { id: "re_1", amount: 2500, status: "succeeded", reason: null, created: 1 },
            { id: "re_2", amount: 7500, status: "succeeded", reason: "requested_by_customer", created: 2 },
          ]),
      },
    })
    const refunds = await payments.listRefunds("acct_1", "ch_1")
    expect(refunds.map((refund) => refund.id)).toEqual(["re_1", "re_2"])
    expect(refunds[1]?.reason).toBe("requested_by_customer")
    expect(refunds.reduce((sum, refund) => sum + refund.amountMinor, 0)).toBe(10_000)
  })
})

describe("reconciliation listings", () => {
  it("pages balance transactions and splits their fees", async () => {
    const payments = adapter({
      balanceTransactions: {
        list: () =>
          Promise.resolve({
            has_more: true,
            data: [
              {
                id: "txn_1",
                type: "charge",
                amount: 10_000,
                fee: 820,
                net: 9180,
                currency: "usd",
                created: 1780000000,
                source: "ch_1",
                fee_details: [
                  { amount: 320, type: "stripe_fee" },
                  { amount: 500, type: "application_fee" },
                ],
              },
            ],
          }),
      },
    })
    const page = await payments.listBalanceTransactions("acct_1", { since: 1 })
    expect(page.items[0]?.stripeFeeMinor).toBe(320)
    expect(page.items[0]?.applicationFeeMinor).toBe(500)
    expect(page.items[0]?.sourceId).toBe("ch_1")
    expect(page.nextCursor).toBe("txn_1")
  })

  it("returns application fees with what has already been refunded", async () => {
    const payments = adapter({
      applicationFees: {
        list: () =>
          Promise.resolve({
            has_more: false,
            data: [
              {
                id: "fee_1",
                charge: "ch_1",
                amount: 500,
                amount_refunded: 125,
                currency: "usd",
                created: 1780000000,
                livemode: false,
              },
            ],
          }),
      },
    })
    const page = await payments.listApplicationFees({ since: null })
    expect(page.items[0]?.amountRefundedMinor).toBe(125)
    expect(page.nextCursor).toBeNull()
  })
})

describe("application fee refund error classification", () => {
  it("treats an already-refunded invalid request as skipped, not failed", () => {
    expect(
      isAlreadyRefundedError({ type: "StripeInvalidRequestError", code: "fee_already_refunded" }),
    ).toBe(true)
    expect(
      isAlreadyRefundedError({
        type: "StripeInvalidRequestError",
        message: "Refund amount ($5.00) is greater than unrefunded amount on charge ($0.00)",
      }),
    ).toBe(true)
    expect(
      isAlreadyRefundedError({
        rawType: "invalid_request_error",
        message: "This application fee has already been refunded.",
      }),
    ).toBe(true)
  })

  it("does not swallow an unrelated failure", () => {
    expect(isAlreadyRefundedError({ type: "StripeAPIError", code: "api_error" })).toBe(false)
    expect(
      isAlreadyRefundedError({ type: "StripeInvalidRequestError", message: "No such fee: fee_9" }),
    ).toBe(false)
    expect(isAlreadyRefundedError(new Error("boom"))).toBe(false)
    expect(isAlreadyRefundedError(null)).toBe(false)
  })
})
