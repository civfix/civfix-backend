import { describe, expect, it } from "vitest"
import { FakePayments } from "@civfix/shared/fakes"
import { can } from "@civfix/shared/host"
import type { Payments } from "@civfix/shared/interfaces"
import { InMemoryCounterStore } from "../../../src/abuse/counter-store.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { makeMemoryOrgPayoutsRepository } from "../../../src/services/payments/org-payouts-repository.memory.js"
import {
  makeOrgPayoutsService,
  ORG_PAYOUTS_PER_HOUR,
  type OrgPayoutsService,
} from "../../../src/services/payments/org-payouts-service.js"
import { NOW, ORG_ID, USER_ID, accountRow, orgRow } from "./helpers.js"

const IDEMPOTENCY_KEY = "dddddddd-4444-4444-8444-dddddddddddd"

const SECOND_KEY = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee"

interface Harness {
  service: OrgPayoutsService
  payouts: ReturnType<typeof makeMemoryOrgPayoutsRepository>
  payments: FakePayments
}

async function fundedAccount(payments: FakePayments, amountMinor: number): Promise<string> {
  const created = await payments.createConnectedAccount({
    orgId: ORG_ID,
    legalName: "REACH OUT LOS ANGELES INC",
    idempotencyKey: `acct:${ORG_ID}:v1`,
  })
  payments.settleAccount(created.accountId)
  if (amountMinor > 0) {
    const session = await payments.createDonationCheckout({
      accountId: created.accountId,
      donationId: "cccccccc-3333-4333-8333-cccccccccccc",
      orgId: ORG_ID,
      amountMinor,
      currency: "usd",
      productName: "Donation",
      applicationFeeMinor: 0,
      expiresAtSec: Math.floor(NOW.getTime() / 1000) + 3600,
      idempotencyKey: `checkout:${amountMinor}`,
    })
    payments.completeCheckout(session.sessionId, { stripeFeeMinor: 0 })
  }
  return created.accountId
}

async function harness(
  options: {
    availableMinor?: number
    suspended?: boolean
    payoutsEnabled?: boolean
    paymentsEnabled?: boolean
    createPayoutRejectsWith?: Error
    accountConnected?: boolean
  } = {},
): Promise<Harness> {
  const fake = new FakePayments({ now: () => NOW.getTime() })
  const accountId = await fundedAccount(fake, options.availableMinor ?? 0)
  if (options.payoutsEnabled === false) fake.settleAccount(accountId, { payoutsEnabled: false })

  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: [orgRow({ suspended: options.suspended ?? false })],
    accounts:
      options.accountConnected === false ? [] : [accountRow({ stripeAccountId: accountId })],
  })
  const payoutRepo = makeMemoryOrgPayoutsRepository()

  const refusal = options.createPayoutRejectsWith
  const payments: Payments =
    refusal === undefined
      ? fake
      : ({
          retrieveBalance: (account: string) => fake.retrieveBalance(account),
          createPayout: () => Promise.reject(refusal),
          listPayouts: (account: string) => fake.listPayouts(account, {}),
        } as unknown as Payments)

  const service = makeOrgPayoutsService({
    orgs,
    payouts: payoutRepo,
    payments,
    counters: new InMemoryCounterStore(() => NOW.getTime()),
    env: { PAYMENTS_ENABLED: options.paymentsEnabled ?? true },
    now: () => NOW,
  })

  return { service, payouts: payoutRepo, payments: fake }
}

describe("org balance", () => {
  it("reports zero and no schedule when no payout account is connected", async () => {
    const { service } = await harness({ accountConnected: false })
    const balance = await service.getBalance(ORG_ID)
    expect(balance).toMatchObject({
      available: { amountMinor: 0, currency: "USD" },
      pending: { amountMinor: 0, currency: "USD" },
      payoutsEnabled: false,
      payoutSchedule: null,
    })
  })

  it("reports zero while payments are switched off, without calling the processor", async () => {
    const { service } = await harness({ availableMinor: 10_000, paymentsEnabled: false })
    const balance = await service.getBalance(ORG_ID)
    expect(balance.available.amountMinor).toBe(0)
    expect(balance.payoutsEnabled).toBe(false)
  })

  it("carries the settled balance and the payout schedule from the connected account", async () => {
    const { service } = await harness({ availableMinor: 10_000 })
    const balance = await service.getBalance(ORG_ID)
    expect(balance.available.amountMinor).toBe(10_000)
    expect(balance.available.currency).toBe("USD")
    expect(balance.payoutsEnabled).toBe(true)
    expect(balance.payoutSchedule).toEqual({ interval: "manual" })
  })

  it("404s for an organization that does not exist", async () => {
    const { service } = await harness()
    await expect(service.getBalance(USER_ID)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("creating a payout", () => {
  it("records the row, moves the money once and returns the stripe payout id", async () => {
    const { service, payouts } = await harness({ availableMinor: 10_000 })
    const payout = await service.createPayout(ORG_ID, USER_ID, {
      amountMinor: 4_000,
      currency: "USD",
      idempotencyKey: IDEMPOTENCY_KEY,
    })

    expect(payout.amount).toEqual({ amountMinor: 4_000, currency: "USD" })
    expect(payout.status).toBe("pending")
    expect(payout.stripePayoutId.length).toBeGreaterThan(0)
    expect(payouts.rows).toHaveLength(1)
    expect(payouts.rows[0]).toMatchObject({
      organizationId: ORG_ID,
      requestedBy: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      amountMinor: 4_000,
    })
  })

  it("pays out the whole available balance when no amount is given", async () => {
    const { service } = await harness({ availableMinor: 7_500 })
    const payout = await service.createPayout(ORG_ID, USER_ID, {
      currency: "USD",
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    expect(payout.amount.amountMinor).toBe(7_500)
  })

  it("replays the same idempotency key instead of moving money twice", async () => {
    const { service, payouts, payments } = await harness({ availableMinor: 10_000 })
    const first = await service.createPayout(ORG_ID, USER_ID, {
      amountMinor: 4_000,
      currency: "USD",
      idempotencyKey: IDEMPOTENCY_KEY,
    })
    const second = await service.createPayout(ORG_ID, USER_ID, {
      amountMinor: 4_000,
      currency: "USD",
      idempotencyKey: IDEMPOTENCY_KEY,
    })

    expect(second.id).toBe(first.id)
    expect(second.stripePayoutId).toBe(first.stripePayoutId)
    expect(payouts.rows).toHaveLength(1)
    const accountId = payouts.rows[0]?.stripeAccountId ?? ""
    const listed = await payments.listPayouts(accountId, {})
    expect(listed.items).toHaveLength(1)
  })

  it("refuses an amount above the available balance and records nothing", async () => {
    const { service, payouts } = await harness({ availableMinor: 1_000 })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 5_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(payouts.rows).toHaveLength(0)
  })

  it("refuses when there is nothing available at all", async () => {
    const { service } = await harness({ availableMinor: 0 })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("refuses while stripe has payouts switched off for the account", async () => {
    const { service, payouts } = await harness({ availableMinor: 10_000, payoutsEnabled: false })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(payouts.rows).toHaveLength(0)
  })

  it("refuses for a suspended organization", async () => {
    const { service } = await harness({ availableMinor: 10_000, suspended: true })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses when no payout account is connected", async () => {
    const { service } = await harness({ accountConnected: false })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
  })

  it("refuses while payments are switched off platform-wide", async () => {
    const { service } = await harness({ availableMinor: 10_000, paymentsEnabled: false })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" })
  })

  it("caps an organization at five payout requests an hour", async () => {
    const { service } = await harness({ availableMinor: 1_000_000 })
    for (let attempt = 0; attempt < ORG_PAYOUTS_PER_HOUR; attempt++) {
      await service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 100,
        currency: "USD",
        idempotencyKey: `aaaaaaaa-0000-4000-8000-00000000000${attempt}`,
      })
    }
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 100,
        currency: "USD",
        idempotencyKey: SECOND_KEY,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("marks the row failed with civfix copy when the processor refuses, and never stores stripe prose", async () => {
    const { service, payouts } = await harness({
      availableMinor: 10_000,
      createPayoutRejectsWith: new Error(
        "payouts_not_allowed for acct_1234567890 on bank account ****6789",
      ),
    })

    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" })

    expect(payouts.rows).toHaveLength(1)
    expect(payouts.rows[0]?.status).toBe("failed")
    expect(payouts.rows[0]?.failureMessage).not.toContain("acct_")
    expect(payouts.rows[0]?.stripePayoutId).toBeNull()
  })

  it("leaves the row PENDING when the processor outcome is unknown, so the money is never paid twice", async () => {
    const timeout = Object.assign(new Error("connection error"), {
      type: "StripeConnectionError",
    })
    const { service, payouts } = await harness({
      availableMinor: 10_000,
      createPayoutRejectsWith: timeout,
    })

    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" })

    expect(payouts.rows).toHaveLength(1)
    expect(payouts.rows[0]?.status).toBe("pending")
    expect(payouts.rows[0]?.stripePayoutId).toBeNull()
  })

  it("refuses a SECOND payout while an earlier one is still unconfirmed", async () => {
    const timeout = Object.assign(new Error("connection error"), {
      type: "StripeConnectionError",
    })
    const { service, payouts } = await harness({
      availableMinor: 10_000,
      createPayoutRejectsWith: timeout,
    })
    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE" })

    await expect(
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: SECOND_KEY,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(payouts.rows).toHaveLength(1)
  })

  it("re-raises the stored refusal on a replay of a failed key", async () => {
    const { service } = await harness({
      availableMinor: 10_000,
      createPayoutRejectsWith: new Error("balance_insufficient"),
    })
    const attempt = (): Promise<unknown> =>
      service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 1_000,
        currency: "USD",
        idempotencyKey: IDEMPOTENCY_KEY,
      })

    await expect(attempt()).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(attempt()).rejects.toMatchObject({ code: "CONFLICT" })
  })
})

describe("listing payouts", () => {
  it("returns newest first and pages with a keyset cursor", async () => {
    const { service, payouts } = await harness({ availableMinor: 1_000_000 })
    for (let attempt = 0; attempt < 3; attempt++) {
      await service.createPayout(ORG_ID, USER_ID, {
        amountMinor: 100 * (attempt + 1),
        currency: "USD",
        idempotencyKey: `bbbbbbbb-0000-4000-8000-00000000000${attempt}`,
      })
    }

    const first = await service.listPayouts({ organizationId: ORG_ID, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await service.listPayouts({
      organizationId: ORG_ID,
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(payouts.rows).toHaveLength(3)
  })

  it("hides a row whose processor call was never confirmed", async () => {
    const { service, payouts } = await harness({ availableMinor: 10_000 })
    await payouts.insertPending({
      organizationId: ORG_ID,
      stripeAccountId: "acct_orphan",
      amountMinor: 500,
      requestedBy: USER_ID,
      idempotencyKey: SECOND_KEY,
      now: NOW,
    })
    const page = await service.listPayouts({ organizationId: ORG_ID, limit: 25 })
    expect(page.items).toHaveLength(0)
  })
})

describe("the payout gate is owner-shaped", () => {
  it("gives manage_payments to the org owner only, and view_donations to owner and admin", () => {
    expect(can({ eventRole: null, orgRole: "owner" }, "manage_payments")).toBe(true)
    expect(can({ eventRole: null, orgRole: "admin" }, "manage_payments")).toBe(false)
    expect(can({ eventRole: null, orgRole: "member" }, "manage_payments")).toBe(false)
    expect(can({ eventRole: null, orgRole: "owner" }, "view_donations")).toBe(true)
    expect(can({ eventRole: null, orgRole: "admin" }, "view_donations")).toBe(true)
    expect(can({ eventRole: null, orgRole: "member" }, "view_donations")).toBe(false)
  })
})

describe("the payout audit mirror", () => {
  it("folds a webhook-created row into the row the request owns, instead of colliding on it", async () => {
    const payouts = makeMemoryOrgPayoutsRepository()
    const pending = await payouts.insertPending({
      organizationId: ORG_ID,
      stripeAccountId: "acct_1",
      amountMinor: 4_000,
      requestedBy: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      now: NOW,
    })
    await payouts.upsertFromProvider({
      organizationId: ORG_ID,
      stripeAccountId: "acct_1",
      stripePayoutId: "po_1",
      amountMinor: 4_000,
      status: "in_transit",
      arrivalDate: null,
      failureMessage: null,
      createdAt: NOW,
      now: NOW,
    })
    expect(payouts.rows).toHaveLength(2)

    const stored = await payouts.markSubmitted({
      id: pending.record.id,
      organizationId: ORG_ID,
      stripePayoutId: "po_1",
      status: "pending",
      arrivalDate: null,
      failureMessage: null,
      now: NOW,
    })

    expect(payouts.rows).toHaveLength(1)
    expect(stored?.id).toBe(pending.record.id)
    expect(stored?.requestedBy).toBe(USER_ID)
    expect(stored?.idempotencyKey).toBe(IDEMPOTENCY_KEY)
  })

  it("reports an unconfirmed payout only while it has no processor id", async () => {
    const payouts = makeMemoryOrgPayoutsRepository()
    expect(await payouts.findUnconfirmed(ORG_ID)).toBeNull()
    const pending = await payouts.insertPending({
      organizationId: ORG_ID,
      stripeAccountId: "acct_1",
      amountMinor: 1_000,
      requestedBy: USER_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      now: NOW,
    })
    expect(await payouts.findUnconfirmed(ORG_ID)).toMatchObject({ id: pending.record.id })
    await payouts.markSubmitted({
      id: pending.record.id,
      organizationId: ORG_ID,
      stripePayoutId: "po_1",
      status: "pending",
      arrivalDate: null,
      failureMessage: null,
      now: NOW,
    })
    expect(await payouts.findUnconfirmed(ORG_ID)).toBeNull()
  })
})
