import { describe, expect, it } from "vitest"
import type {
  ApplicationFeeRecord,
  BalanceTransactionRecord,
  Payments,
} from "@civfix/shared/interfaces"
import {
  RECONCILE_DONATION_PAGE,
  RECONCILE_MAX_STRIPE_PAGES,
  RECONCILE_STRIPE_PAGE,
  collectBalanceTransactions,
  compareAgainstStripe,
  findDivergences,
  reconcileOrganization,
  runPaymentsReconciliation,
  type ReconcileDeps,
} from "../../../src/services/payments/donation-reconcile.js"
import type { DonationRecord } from "../../../src/services/payments/donation-repository.drizzle.js"

function donation(patch: Partial<Parameters<typeof findDivergences>[0][number]> = {}) {
  return {
    id: "d1",
    reference: "CFD-1",
    amountMinor: 10_000,
    feePlatformMinor: 500,
    feeRefundedMinor: 0,
    feeStripeMinor: 320,
    netMinor: 9180,
    stripeChargeId: "ch_1",
    stripeApplicationFeeId: "fee_1",
    ...patch,
  }
}

function record(patch: Partial<DonationRecord> = {}): DonationRecord {
  return {
    ...donation(),
    donorKey: "d",
    organizationId: "org",
    eventId: null,
    userId: null,
    donorEmail: null,
    donorName: null,
    shareIdentityWithOrg: false,
    currency: "USD",
    feeBps: 500,
    status: "succeeded",
    failureReason: null,
    disputeState: "none",
    refundedTotalMinor: 0,
    stripeAccountId: "acct_1",
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    cardBrand: null,
    cardLast4: null,
    livemode: true,
    chargedAt: new Date("2026-03-01T00:00:00.000Z"),
    sessionExpiresAt: null,
    receiptSentAt: null,
    receiptKey: null,
    receiptDocumentVersion: null,
    consentTermsVersion: null,
    consentDisclosureVersion: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    lastPolledAt: null,
    ...patch,
  } as DonationRecord
}

function transaction(patch: Partial<BalanceTransactionRecord> = {}): BalanceTransactionRecord {
  return {
    id: "txn_1",
    type: "charge",
    amountMinor: 10_000,
    feeMinor: 820,
    stripeFeeMinor: 320,
    applicationFeeMinor: 500,
    netMinor: 9180,
    currency: "usd",
    createdSec: 1780000000,
    sourceId: "ch_1",
    ...patch,
  }
}

describe("reconciliation invariants", () => {
  it("finds nothing on a fully settled donation", () => {
    expect(findDivergences([donation()])).toEqual([])
  })

  it("flags a succeeded donation with no charge id", () => {
    const found = findDivergences([donation({ stripeChargeId: null })])
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe("missing_charge_id")
  })

  it("flags a platform fee with no application fee object", () => {
    const found = findDivergences([donation({ stripeApplicationFeeId: null })])
    expect(found.some((entry) => entry.kind === "missing_application_fee")).toBe(true)
  })

  it("does not flag a missing application fee when the platform fee is zero", () => {
    expect(
      findDivergences([
        donation({ feePlatformMinor: 0, stripeApplicationFeeId: null, netMinor: 9680 }),
      ]),
    ).toEqual([])
  })

  it("flags a donation whose processor fee never settled", () => {
    const found = findDivergences([donation({ feeStripeMinor: null })])
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe("unsettled_processor_fee")
  })

  it("flags a fee refund larger than the fee that was charged", () => {
    const found = findDivergences([donation({ feeRefundedMinor: 600 })])
    expect(found.some((entry) => entry.kind === "fee_mismatch")).toBe(true)
  })

  it("flags a net that does not equal gross minus both fees", () => {
    const found = findDivergences([donation({ netMinor: 9999 })])
    const mismatch = found.find((entry) => entry.kind === "amount_mismatch")
    expect(mismatch?.expectedMinor).toBe(9180)
    expect(mismatch?.observedMinor).toBe(9999)
  })

  it("reports every divergent donation in one pass", () => {
    const found = findDivergences([
      donation({ id: "a", stripeChargeId: null }),
      donation({ id: "b" }),
      donation({ id: "c", netMinor: 1 }),
    ])
    expect(found.map((entry) => entry.donationId).sort()).toEqual(["a", "c"])
  })
})

describe("reconciliation against Stripe", () => {
  function fee(patch: Partial<ApplicationFeeRecord> = {}): ApplicationFeeRecord {
    return {
      id: "fee_1",
      chargeId: "ch_1",
      amountMinor: 500,
      amountRefundedMinor: 0,
      currency: "usd",
      createdSec: 1780000000,
      livemode: true,
      ...patch,
    }
  }

  it("finds nothing when Stripe agrees with the local row", () => {
    const result = compareAgainstStripe({
      donations: [record()],
      transactions: [transaction()],
      applicationFees: new Map([["fee_1", fee()]]),
    })
    expect(result.divergences).toEqual([])
    expect(result.applicationFeesChecked).toBe(1)
  })

  it("flags a settled donation Stripe has no charge for", () => {
    const result = compareAgainstStripe({
      donations: [record()],
      transactions: [],
      applicationFees: new Map(),
    })
    expect(result.divergences.map((entry) => entry.kind)).toEqual(["charge_not_at_stripe"])
  })

  it("flags a processor fee that does not match the balance transaction", () => {
    const result = compareAgainstStripe({
      donations: [record({ feeStripeMinor: 820 })],
      transactions: [transaction()],
      applicationFees: new Map(),
    })
    expect(result.divergences.map((entry) => entry.kind)).toEqual(["processor_fee_mismatch"])
  })

  it("flags a platform fee Stripe took that civfix never agreed", () => {
    const result = compareAgainstStripe({
      donations: [record()],
      transactions: [transaction({ applicationFeeMinor: 900 })],
      applicationFees: new Map(),
    })
    expect(result.divergences.map((entry) => entry.kind)).toEqual(["platform_fee_mismatch"])
  })

  it("flags an application fee whose refunded amount drifted from the local ledger", () => {
    const result = compareAgainstStripe({
      donations: [record({ feeRefundedMinor: 125 })],
      transactions: [transaction()],
      applicationFees: new Map([["fee_1", fee({ amountRefundedMinor: 0 })]]),
    })
    expect(result.divergences.map((entry) => entry.kind)).toEqual(["refunded_fee_mismatch"])
  })

  it("ignores charges on the connected account that are not civfix donations", () => {
    const result = compareAgainstStripe({
      donations: [record()],
      transactions: [transaction(), transaction({ id: "txn_2", sourceId: "ch_other" })],
      applicationFees: new Map([["fee_1", fee()]]),
    })
    expect(result.divergences).toEqual([])
  })

  it("pages every balance transaction Stripe offers", async () => {
    const pages = [
      { items: [transaction({ id: "txn_1" })], nextCursor: "txn_1" },
      { items: [transaction({ id: "txn_2" })], nextCursor: null },
    ]
    let call = 0
    const payments = {
      listBalanceTransactions: () => Promise.resolve(pages[call++] as (typeof pages)[number]),
    } as unknown as Payments
    const collected = await collectBalanceTransactions(payments, "acct_1", null)
    expect(collected.items.map((item) => item.id)).toEqual(["txn_1", "txn_2"])
    expect(collected.complete).toBe(true)
  })

  it("pages a busy account to exhaustion under the raised bound", async () => {
    const total = RECONCILE_STRIPE_PAGE * (RECONCILE_MAX_STRIPE_PAGES - 20)
    const ledger = Array.from({ length: total }, (_unused, index) =>
      transaction({ id: `txn_${index}`, sourceId: `ch_${index}`, createdSec: 1780000000 - index }),
    )
    let calls = 0
    const payments = {
      listBalanceTransactions: (
        _accountId: string,
        input: { cursor?: string | null; limit?: number },
      ) => {
        calls += 1
        const start =
          input.cursor === undefined || input.cursor === null
            ? 0
            : ledger.findIndex((item) => item.id === input.cursor) + 1
        const limit = input.limit ?? RECONCILE_STRIPE_PAGE
        const items = ledger.slice(start, start + limit)
        const last = items[items.length - 1]
        const hasMore = start + items.length < ledger.length
        return Promise.resolve({
          items,
          nextCursor: hasMore && last !== undefined ? last.id : null,
        })
      },
    } as unknown as Payments

    const collected = await collectBalanceTransactions(payments, "acct_1", 1770000000)
    expect(collected.complete).toBe(true)
    expect(collected.items).toHaveLength(total)
    expect(new Set(collected.items.map((item) => item.id)).size).toBe(total)
    expect(calls).toBeLessThanOrEqual(RECONCILE_MAX_STRIPE_PAGES)
  })

  it("reports the listing incomplete when the page bound is spent", async () => {
    let calls = 0
    const payments = {
      listBalanceTransactions: () => {
        calls += 1
        return Promise.resolve({
          items: [transaction({ id: `txn_${calls}`, sourceId: `ch_${calls}` })],
          nextCursor: `txn_${calls}`,
        })
      },
    } as unknown as Payments

    const collected = await collectBalanceTransactions(payments, "acct_1", 1770000000)
    expect(collected.complete).toBe(false)
    expect(calls).toBe(RECONCILE_MAX_STRIPE_PAGES)
  })

  it("flags no charge as absent from Stripe when the listing is incomplete", () => {
    const result = compareAgainstStripe({
      donations: [record({ id: "d_old", reference: "CFD-old", stripeChargeId: "ch_old" })],
      transactions: [],
      applicationFees: new Map(),
      stripeListingComplete: false,
    })
    expect(result.divergences).toEqual([])
    expect(result.chargesNotCompared).toBe(1)
  })
})

describe("reconciliation high-water mark", () => {
  const WINDOW_START = new Date("2026-03-01T00:00:00.000Z")

  function localDonation(index: number): DonationRecord {
    const chargedAt = new Date(WINDOW_START.getTime() + index * 60_000)
    return {
      ...record({
        id: `d${index}`,
        reference: `CFD-${index}`,
        stripeChargeId: `ch_${index}`,
        stripeApplicationFeeId: null,
        feePlatformMinor: 0,
        netMinor: 9680,
        chargedAt,
        createdAt: chargedAt,
      }),
    }
  }

  function transactionFor(donation: DonationRecord): BalanceTransactionRecord {
    return transaction({
      id: `txn_${donation.id}`,
      sourceId: donation.stripeChargeId as string,
      applicationFeeMinor: 0,
      feeMinor: 320,
      netMinor: 9680,
      createdSec: Math.floor((donation.chargedAt as Date).getTime() / 1000),
    })
  }

  function depsFor(input: {
    rows: DonationRecord[]
    transactions: BalanceTransactionRecord[]
    alwaysFullPage?: boolean
  }): ReconcileDeps {
    const donations = {
      succeededSince: ({
        limit,
        after,
      }: {
        limit: number
        after?: { chargedAt: Date; id: string } | null
      }) => {
        if (input.alwaysFullPage === true) return Promise.resolve(input.rows.slice(0, limit))
        const anchor = after ?? null
        const remaining =
          anchor === null
            ? input.rows
            : input.rows.filter((row) => (row.chargedAt as Date) > anchor.chargedAt)
        return Promise.resolve(remaining.slice(0, limit))
      },
    }
    const payments = {
      listBalanceTransactions: () =>
        Promise.resolve({ items: input.transactions, nextCursor: null }),
    }
    return {
      sql: (() => undefined) as unknown as ReconcileDeps["sql"],
      donations: donations as unknown as ReconcileDeps["donations"],
      orgs: {} as ReconcileDeps["orgs"],
      payments: payments as unknown as ReconcileDeps["payments"],
    }
  }

  it("compares every local donation past the first page", async () => {
    const rows = Array.from({ length: RECONCILE_DONATION_PAGE + 1 }, (_, index) =>
      localDonation(index),
    )
    const until = new Date(WINDOW_START.getTime() + 86_400_000)
    const result = await reconcileOrganization(
      depsFor({ rows, transactions: rows.map(transactionFor) }),
      {
        organizationId: "org",
        stripeAccountId: "acct_1",
        since: null,
        until,
        applicationFees: new Map(),
      },
    )
    expect(result.donationsChecked).toBe(RECONCILE_DONATION_PAGE + 1)
    expect(result.divergences).toEqual([])
    expect(result.comparedThrough.getTime()).toBe(until.getTime())
  })

  it("caps the mark at the last compared donation when the local side is not exhausted", async () => {
    const rows = Array.from({ length: RECONCILE_DONATION_PAGE }, (_, index) => localDonation(index))
    const lastLocal = rows[rows.length - 1]?.chargedAt as Date
    const newer = transaction({
      id: "txn_newer",
      sourceId: "ch_newer",
      createdSec: Math.floor((lastLocal.getTime() + 3_600_000) / 1000),
    })
    const until = new Date(lastLocal.getTime() + 86_400_000)
    const result = await reconcileOrganization(
      depsFor({
        rows,
        transactions: [...rows.map(transactionFor), newer],
        alwaysFullPage: true,
      }),
      {
        organizationId: "org",
        stripeAccountId: "acct_1",
        since: null,
        until,
        applicationFees: new Map(),
      },
    )
    expect(result.comparedThrough.getTime()).toBe(lastLocal.getTime())
    expect(result.balanceTransactionsChecked).toBe(RECONCILE_DONATION_PAGE)
    expect(result.divergences).toEqual([])
  })
})

describe("reconciliation with an incomplete Stripe listing", () => {
  const UNTIL = new Date("2026-03-31T00:00:00.000Z")
  const SINCE = new Date("2026-01-01T00:00:00.000Z")

  function localRow(index: number): DonationRecord {
    const chargedAt = new Date(SINCE.getTime() + index * 86_400_000)
    return record({
      id: `d${index}`,
      reference: `CFD-${index}`,
      stripeChargeId: `ch_${index}`,
      stripeApplicationFeeId: null,
      feePlatformMinor: 0,
      netMinor: 9680,
      chargedAt,
      createdAt: chargedAt,
    })
  }

  function neverExhaustingPayments(): Payments {
    let call = 0
    return {
      listApplicationFees: () => Promise.resolve({ items: [], nextCursor: null }),
      listBalanceTransactions: () => {
        call += 1
        return Promise.resolve({
          items: [transaction({ id: `txn_${call}`, sourceId: `ch_unknown_${call}` })],
          nextCursor: `txn_${call}`,
        })
      },
    } as unknown as Payments
  }

  function depsWith(rows: DonationRecord[]): {
    deps: ReconcileDeps
    statements: string[]
  } {
    const statements: string[] = []
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join(" ? "))
      return Promise.resolve([])
    }) as unknown as ReconcileDeps["sql"]
    ;(sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value
    return {
      statements,
      deps: {
        sql,
        donations: {
          succeededSince: () => Promise.resolve(rows),
        } as unknown as ReconcileDeps["donations"],
        orgs: {
          listOnboardedAccounts: (_limit: number, after: string | null) =>
            Promise.resolve(
              after === null
                ? [{ organizationId: "org", stripeAccountId: "acct_1", reconciledThrough: SINCE }]
                : [],
            ),
        } as unknown as ReconcileDeps["orgs"],
        payments: neverExhaustingPayments(),
        now: () => new Date(UNTIL.getTime() + 3_600_000),
      },
    }
  }

  it("records no charge_not_at_stripe and holds the mark at the window start", async () => {
    const rows = [localRow(0), localRow(1)]
    const { deps } = depsWith(rows)
    const result = await reconcileOrganization(deps, {
      organizationId: "org",
      stripeAccountId: "acct_1",
      since: SINCE,
      until: UNTIL,
      applicationFees: new Map(),
    })
    expect(result.stripeListingComplete).toBe(false)
    expect(result.divergences).toEqual([])
    expect(result.comparedThrough.getTime()).toBe(SINCE.getTime())
  })

  it("never advances reconciled_through when the listing is incomplete", async () => {
    const { deps, statements } = depsWith([localRow(0)])
    const run = await runPaymentsReconciliation(deps)
    expect(run.organizations).toBe(1)
    expect(run.divergences).toBe(0)
    expect(statements.some((entry) => entry.includes("donation_reconciliation_runs"))).toBe(true)
    expect(statements.some((entry) => entry.includes("reconciled_through"))).toBe(false)
  })
})
