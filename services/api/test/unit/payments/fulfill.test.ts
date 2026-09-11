import { describe, expect, it } from "vitest"
import { FakePayments } from "@civfix/shared/fakes"
import {
  disputeStateOf,
  fulfillDonation,
  processStripeEvent,
  syncDispute,
  syncRefunds,
  type PaymentsRuntime,
} from "../../../src/services/payments/payments-jobs.js"
import { makeMemoryDonationRepository, makeMemoryStripeEventRepository } from "../../../src/services/payments/donation-repository.memory.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { makeMemoryOrgPayoutsRepository } from "../../../src/services/payments/org-payouts-repository.memory.js"
import { loadPaymentsEnv } from "../../../src/env/payments-env.js"
import {
  NOW,
  ORG_ID,
  accountRow,
  eligibilityRow,
  orgRow,
  settingsRow,
} from "./helpers.js"

const DONATION_ID = "dddddddd-4444-4444-8444-dddddddddddd"

interface Harness {
  runtime: PaymentsRuntime
  donations: ReturnType<typeof makeMemoryDonationRepository>
  events: ReturnType<typeof makeMemoryStripeEventRepository>
  payments: FakePayments
  enqueued: { name: string; data: unknown }[]
  sessionId: string
}

async function harness(options: { amountMinor?: number; feeMinor?: number } = {}): Promise<Harness> {
  const amountMinor = options.amountMinor ?? 10_000
  const feeMinor = options.feeMinor ?? 500
  const payments = new FakePayments({ now: () => NOW.getTime() })
  const created = await payments.createConnectedAccount({
    orgId: ORG_ID,
    email: "org@civfix.org",
    legalName: "REACH OUT LOS ANGELES INC",
    idempotencyKey: `acct:${ORG_ID}:v1`,
  })
  payments.settleAccount(created.accountId)

  const session = await payments.createDonationCheckout({
    accountId: created.accountId,
    donationId: DONATION_ID,
    orgId: ORG_ID,
    amountMinor,
    currency: "usd",
    productName: "Donation to REACH OUT LOS ANGELES INC",
    applicationFeeMinor: feeMinor,
    expiresAtSec: Math.floor(NOW.getTime() / 1000) + 1800,
    idempotencyKey: `donation:${DONATION_ID}:checkout:v1`,
  })

  const donations = makeMemoryDonationRepository({ orgNameOf: () => "Reach Out LA" })
  await donations.create({
    id: DONATION_ID,
    reference: "CFD-TEST",
    donorKey: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
    organizationId: ORG_ID,
    eventId: null,
    userId: null,
    donorEmail: "donor@example.org",
    donorName: "Donor",
    shareIdentityWithOrg: false,
    amountMinor,
    feeBps: 500,
    feePlatformMinor: feeMinor,
    stripeAccountId: created.accountId,
    sessionExpiresAt: new Date(NOW.getTime() + 1800_000),
    consentTermsVersion: "2026-09-06",
    consentDisclosureVersion: "2026-09-06",
    eligibilitySnapshot: {},
    idempotencyOwner: "donor:test",
    idempotencyKey: "idem-1",
    livemode: false,
    consents: [],
    consentSurface: "web_donate",
    consentScreenRoute: null,
    consentUiTemplateVersion: null,
    now: NOW,
  })
  await donations.attachCheckoutSession({
    donationId: DONATION_ID,
    sessionId: session.sessionId,
    paymentIntentId: session.paymentIntentId,
    expiresAt: new Date(session.expiresAtSec * 1000),
  })

  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: [orgRow()],
    accounts: [accountRow({ stripeAccountId: created.accountId })],
    settings: [settingsRow()],
    eligibility: [eligibilityRow()],
  })
  const events = makeMemoryStripeEventRepository()
  const enqueued: { name: string; data: unknown }[] = []

  const runtime: PaymentsRuntime = {
    sql: null as unknown as PaymentsRuntime["sql"],
    env: loadPaymentsEnv({ NODE_ENV: "test", PAYMENTS_ENABLED: "true" }, []),
    jobs: {
      enqueue: (name, data) => {
        enqueued.push({ name, data })
        return Promise.resolve("job")
      },
      schedule: () => Promise.resolve(),
      work: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      fail: () => Promise.resolve(),
    },
    donations,
    events,
    orgs,
    payouts: makeMemoryOrgPayoutsRepository(),
    orgPayments: {} as PaymentsRuntime["orgPayments"],
    eligibility: {} as PaymentsRuntime["eligibility"],
    payments,
    mailer: {} as PaymentsRuntime["mailer"],
    storage: {} as PaymentsRuntime["storage"],
    now: () => NOW,
  }

  return { runtime, donations, events, payments, enqueued, sessionId: session.sessionId }
}

describe("donation fulfillment", () => {
  it("does nothing while the session is unpaid", async () => {
    const h = await harness()
    await fulfillDonation(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("pending")
    expect(h.enqueued).toHaveLength(0)
  })

  it("advances a paid session to succeeded and enqueues exactly one receipt", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId, { stripeFeeMinor: 320, chargedAtSec: 1780000000 })
    await fulfillDonation(h.runtime, DONATION_ID)

    const row = h.donations.rows[0]
    expect(row?.status).toBe("succeeded")
    expect(row?.feeStripeMinor).toBe(320)
    expect(row?.chargedAt?.getTime()).toBe(1780000000 * 1000)
    expect(row?.stripeChargeId).not.toBeNull()
    expect(h.enqueued.filter((job) => job.name === "donation.receipt")).toHaveLength(1)
  })

  it("is idempotent: a duplicate delivery enqueues no second receipt", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    await fulfillDonation(h.runtime, DONATION_ID)
    await fulfillDonation(h.runtime, DONATION_ID)
    expect(h.enqueued.filter((job) => job.name === "donation.receipt")).toHaveLength(1)
  })

  it("uses the CHARGE date, not the arrival time, as the contribution date", async () => {
    const h = await harness()
    const chargedAtSec = Math.floor(Date.UTC(2026, 4, 20, 3, 0, 0) / 1000)
    h.payments.completeCheckout(h.sessionId, { chargedAtSec })
    await fulfillDonation(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.chargedAt?.toISOString()).toBe(
      new Date(chargedAtSec * 1000).toISOString(),
    )
  })

  it("ignores a livemode mismatch rather than recording a live charge in a test process", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    const original = h.payments.retrieveDonation.bind(h.payments)
    h.payments.retrieveDonation = async (accountId, sessionId) => ({
      ...(await original(accountId, sessionId)),
      livemode: true,
    })
    await fulfillDonation(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("pending")
  })
})

describe("out-of-order and duplicate webhook processing", () => {
  async function deliver(h: Harness, id: string, type: string, object: Record<string, unknown>) {
    await h.events.insert({
      id,
      scope: "connect",
      type,
      accountId: "acct_fake_1",
      objectId: typeof object.id === "string" ? object.id : null,
      livemode: false,
      apiVersion: null,
      payload: { id, type, data: { object } },
      retentionUntil: new Date(NOW.getTime() + 400 * 86400_000),
    })
    await processStripeEvent(h.runtime, id)
  }

  it("converges on one succeeded donation and one receipt when payment_intent lands before checkout", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    const paymentIntentId = h.donations.rows[0]?.stripePaymentIntentId as string

    await deliver(h, "evt_pi", "payment_intent.succeeded", { id: paymentIntentId })
    await deliver(h, "evt_cs", "checkout.session.completed", { id: h.sessionId })
    await deliver(h, "evt_pi_dup", "payment_intent.succeeded", { id: paymentIntentId })

    expect(h.donations.rows[0]?.status).toBe("succeeded")
    expect(h.enqueued.filter((job) => job.name === "donation.receipt")).toHaveLength(1)
  })

  it("does not fail a donation on payment_intent.payment_failed: the session may be retried", async () => {
    const h = await harness()
    const paymentIntentId = h.donations.rows[0]?.stripePaymentIntentId as string
    await deliver(h, "evt_failed", "payment_intent.payment_failed", { id: paymentIntentId })
    expect(h.donations.rows[0]?.status).toBe("pending")

    h.payments.completeCheckout(h.sessionId)
    await deliver(h, "evt_cs2", "checkout.session.completed", { id: h.sessionId })
    expect(h.donations.rows[0]?.status).toBe("succeeded")
  })

  it("fails a pending donation when the session expires", async () => {
    const h = await harness()
    await deliver(h, "evt_expired", "checkout.session.expired", { id: h.sessionId })
    expect(h.donations.rows[0]?.status).toBe("failed")
    expect(h.donations.rows[0]?.failureReason).toBe("session_expired")
  })

  it("never re-processes an event that is already marked processed", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    await deliver(h, "evt_once", "checkout.session.completed", { id: h.sessionId })
    await processStripeEvent(h.runtime, "evt_once")
    expect(h.enqueued.filter((job) => job.name === "donation.receipt")).toHaveLength(1)
  })

  it("records an early fraud warning without refunding anything", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    await fulfillDonation(h.runtime, DONATION_ID)
    const chargeId = h.donations.rows[0]?.stripeChargeId as string

    await deliver(h, "evt_efw", "radar.early_fraud_warning.created", {
      id: "issfr_1",
      charge: chargeId,
    })
    expect(h.donations.rows[0]?.disputeState).toBe("warning")
    expect(h.donations.rows[0]?.status).toBe("succeeded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(0)
  })
})

describe("refund and application-fee math", () => {
  async function settled(amountMinor: number, feeMinor: number): Promise<Harness> {
    const h = await harness({ amountMinor, feeMinor })
    h.payments.completeCheckout(h.sessionId)
    await fulfillDonation(h.runtime, DONATION_ID)
    return h
  }

  function refund(h: Harness, refundId: string, amountMinor: number): void {
    h.payments.refundCheckout(h.sessionId, amountMinor, { refundId })
  }

  it("refunds the platform fee proportionally on a partial refund", async () => {
    const h = await settled(10_000, 500)
    refund(h, "re_1", 2500)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("partially_refunded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(2500)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(125)
  })

  it("leaves a settled donation alone when Stripe reports no refunds at all", async () => {
    const h = await settled(10_000, 500)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("succeeded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(0)
    expect(h.donations.refunds).toHaveLength(0)
  })

  it("re-retrieves the refunds instead of trusting the webhook payload", async () => {
    const h = await settled(10_000, 500)
    refund(h, "re_1", 10_000)
    const chargeId = h.donations.rows[0]?.stripeChargeId as string
    await h.events.insert({
      id: "evt_refunded",
      scope: "connect",
      type: "charge.refunded",
      accountId: "acct_fake_1",
      objectId: chargeId,
      livemode: false,
      apiVersion: null,
      payload: {
        id: "evt_refunded",
        type: "charge.refunded",
        data: { object: { id: chargeId } },
      },
      retentionUntil: new Date(NOW.getTime() + 400 * 86400_000),
    })
    await processStripeEvent(h.runtime, "evt_refunded")
    expect(h.donations.rows[0]?.status).toBe("refunded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(10_000)
  })

  it("returns the residue when a partial refund is followed by a full one", async () => {
    const h = await settled(10_000, 500)
    refund(h, "re_1", 3333)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(167)
    refund(h, "re_2", 6667)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(10_000)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(500)
  })

  it("refunds the fee for EVERY refund that arrives in one delivery", async () => {
    const h = await settled(10_000, 500)
    refund(h, "re_1", 2500)
    refund(h, "re_2", 7500)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(500)
    expect(
      h.donations.refunds.every((entry) => entry.appFeeRefundState === "done"),
    ).toBe(true)
  })

  it("is idempotent: replaying the same refund returns nothing further", async () => {
    const h = await settled(10_000, 500)
    refund(h, "re_1", 10_000)
    await syncRefunds(h.runtime, DONATION_ID)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(500)
    expect(h.donations.refunds).toHaveLength(1)
  })

  it("does nothing to the fee when there is no platform fee to return", async () => {
    const h = await settled(10_000, 0)
    refund(h, "re_1", 10_000)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(0)
  })

  it("records the refund but skips the fee return when the flag is off", async () => {
    const h = await settled(10_000, 500)
    h.runtime.env = { ...h.runtime.env, DONATION_REFUND_APP_FEE: false }
    refund(h, "re_1", 10_000)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(0)
  })

  it("marks the fee refund skipped rather than failed when Stripe already reversed it", async () => {
    const h = await settled(10_000, 500)
    h.payments.refundApplicationFee = () =>
      Promise.resolve({ id: "fee_1", amountMinor: 0, status: "skipped" as const })
    refund(h, "re_1", 10_000)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(0)
    expect(h.donations.refunds[0]?.appFeeRefundState).toBe("skipped")
  })

  it("records a failed fee refund without losing the refund itself", async () => {
    const h = await settled(10_000, 500)
    h.payments.refundApplicationFee = () => Promise.reject(new Error("stripe down"))
    refund(h, "re_1", 10_000)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
    expect(h.donations.refunds[0]?.appFeeRefundState).toBe("failed")
  })

  it("stops counting a refund that Stripe later marks failed", async () => {
    const h = await settled(10_000, 500)
    h.payments.refundCheckout(h.sessionId, 10_000, { refundId: "re_1", status: "pending" })
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(10_000)

    h.payments.setRefundStatus("re_1", "failed")
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("succeeded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(0)
    expect(h.donations.refunds[0]?.status).toBe("failed")
  })

  it("flags the returned application fee as failed_after and never re-refunds it", async () => {
    const h = await settled(10_000, 500)
    h.payments.refundCheckout(h.sessionId, 10_000, { refundId: "re_1", status: "pending" })
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(500)

    h.payments.setRefundStatus("re_1", "failed")
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.refunds[0]?.appFeeRefundState).toBe("failed_after")
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(500)

    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.refunds[0]?.appFeeRefundState).toBe("failed_after")
    expect(h.donations.rows[0]?.feeRefundedMinor).toBe(500)
  })

  it("keeps a partial refund counted when a second refund fails", async () => {
    const h = await settled(10_000, 500)
    h.payments.refundCheckout(h.sessionId, 2500, { refundId: "re_1" })
    h.payments.refundCheckout(h.sessionId, 7500, { refundId: "re_2", status: "pending" })
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")

    h.payments.setRefundStatus("re_2", "failed")
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("partially_refunded")
    expect(h.donations.rows[0]?.refundedTotalMinor).toBe(2500)
  })

  it("still marks a refund that lands before fulfilment, without un-settling it later", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    const chargeId = h.payments.checkoutFor(DONATION_ID)?.chargeId as string
    const row = h.donations.rows[0]
    if (row !== undefined) row.stripeChargeId = chargeId
    h.payments.refundCheckout(h.sessionId, 10_000, { refundId: "re_1" })

    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
  })

  it("never lets a refund rewind the donation status below its rank", async () => {
    const h = await settled(10_000, 500)
    refund(h, "re_1", 10_000)
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
    await syncRefunds(h.runtime, DONATION_ID)
    expect(h.donations.rows[0]?.status).toBe("refunded")
  })
})

describe("dispute state mapping", () => {
  it("keeps an inquiry as a warning and closes it out when the inquiry closes", async () => {
    const h = await harness()
    h.payments.completeCheckout(h.sessionId)
    await fulfillDonation(h.runtime, DONATION_ID)
    const chargeId = h.donations.rows[0]?.stripeChargeId as string

    await syncDispute(h.runtime, {
      id: "dp_1",
      charge: chargeId,
      amount: 10_000,
      status: "warning_needs_response",
      created: 1780000000,
      evidence_details: { due_by: 1780600000 },
    })
    expect(h.donations.rows[0]?.disputeState).toBe("warning")

    await syncDispute(h.runtime, {
      id: "dp_1",
      charge: chargeId,
      amount: 10_000,
      status: "warning_closed",
      created: 1780000000,
      evidence_details: { due_by: 0 },
    })
    expect(h.donations.rows[0]?.disputeState).toBe("none")
  })

  it("maps every terminal Stripe dispute status to a terminal state", () => {
    expect(disputeStateOf("won")).toBe("won")
    expect(disputeStateOf("lost")).toBe("lost")
    expect(disputeStateOf("prevented")).toBe("lost")
    expect(disputeStateOf("charge_refunded")).toBe("none")
    expect(disputeStateOf("warning_closed")).toBe("none")
    expect(disputeStateOf("needs_response")).toBe("open")
    expect(disputeStateOf("something_new_from_stripe")).toBe("open")
  })
})
