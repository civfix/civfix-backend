import { describe, expect, it } from "vitest"
import { FakeJobs, FakeMailer, FakePayments, FakeStorage } from "@civfix/shared/fakes"
import { loadPaymentsEnv } from "../../../src/env/payments-env.js"
import {
  processStripeEvent,
  payoutStatusOf,
  type PaymentsRuntime,
} from "../../../src/services/payments/payments-jobs.js"
import { makeMemoryStripeEventRepository } from "../../../src/services/payments/donation-repository.memory.js"
import { makeMemoryDonationRepository } from "../../../src/services/payments/donation-repository.memory.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { makeMemoryOrgPayoutsRepository } from "../../../src/services/payments/org-payouts-repository.memory.js"
import { NOW, ORG_ID, accountRow, orgRow } from "./helpers.js"

const ACCOUNT_ID = "acct_fake_1"

const PAYOUT_ID = "po_dashboard_1"

interface Harness {
  runtime: PaymentsRuntime
  events: ReturnType<typeof makeMemoryStripeEventRepository>
  payouts: ReturnType<typeof makeMemoryOrgPayoutsRepository>
}

function harness(): Harness {
  const events = makeMemoryStripeEventRepository()
  const payouts = makeMemoryOrgPayoutsRepository()
  const runtime: PaymentsRuntime = {
    sql: null as unknown as PaymentsRuntime["sql"],
    env: loadPaymentsEnv({ NODE_ENV: "test", PAYMENTS_ENABLED: "true" }, []),
    jobs: new FakeJobs(),
    donations: makeMemoryDonationRepository({ orgNameOf: () => "Reach Out LA" }),
    events,
    orgs: makeMemoryOrgPaymentsRepository({
      orgs: [orgRow()],
      accounts: [accountRow({ stripeAccountId: ACCOUNT_ID })],
    }),
    payouts,
    orgPayments: {} as PaymentsRuntime["orgPayments"],
    eligibility: {} as PaymentsRuntime["eligibility"],
    payments: new FakePayments({ now: () => NOW.getTime() }),
    mailer: new FakeMailer(),
    storage: new FakeStorage(),
    now: () => NOW,
  }
  return { runtime, events, payouts }
}

async function deliver(
  h: Harness,
  id: string,
  type: string,
  object: Record<string, unknown>,
  accountId: string | null = ACCOUNT_ID,
): Promise<void> {
  await h.events.insert({
    id,
    scope: "connect",
    type,
    accountId,
    objectId: typeof object.id === "string" ? object.id : null,
    livemode: false,
    apiVersion: null,
    payload: { id, type, data: { object } },
    retentionUntil: new Date(NOW.getTime() + 400 * 86400_000),
  })
  await processStripeEvent(h.runtime, id)
}

function payoutObject(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYOUT_ID,
    amount: 25_000,
    currency: "usd",
    status: "in_transit",
    arrival_date: 1_800_000_000,
    created: 1_700_000_000,
    ...patch,
  }
}

describe("payout webhooks on the connect endpoint", () => {
  it("records a payout the organization made from its own stripe dashboard", async () => {
    const h = harness()
    await deliver(h, "evt_1", "payout.updated", payoutObject())

    expect(h.payouts.rows).toHaveLength(1)
    expect(h.payouts.rows[0]).toMatchObject({
      organizationId: ORG_ID,
      stripeAccountId: ACCOUNT_ID,
      stripePayoutId: PAYOUT_ID,
      amountMinor: 25_000,
      status: "in_transit",
      requestedBy: null,
      idempotencyKey: null,
    })
    expect(h.payouts.rows[0]?.createdAt.toISOString()).toBe(
      new Date(1_700_000_000 * 1000).toISOString(),
    )
  })

  it("advances the same row rather than duplicating it", async () => {
    const h = harness()
    await deliver(h, "evt_1", "payout.updated", payoutObject())
    await deliver(h, "evt_2", "payout.paid", payoutObject({ status: "paid" }))

    expect(h.payouts.rows).toHaveLength(1)
    expect(h.payouts.rows[0]?.status).toBe("paid")
  })

  it("stores civfix copy for a failure, never the processor's own message", async () => {
    const h = harness()
    await deliver(
      h,
      "evt_1",
      "payout.failed",
      payoutObject({
        status: "failed",
        failure_message: "The bank account acct_1234567890 ****6789 was closed",
      }),
    )

    const failure = h.payouts.rows[0]?.failureMessage ?? ""
    expect(h.payouts.rows[0]?.status).toBe("failed")
    expect(failure.length).toBeGreaterThan(0)
    expect(failure).not.toContain("acct_")
    expect(failure).not.toContain("6789")
  })

  it("does not let an out-of-order event walk a settled payout backwards", async () => {
    const h = harness()
    await deliver(h, "evt_paid", "payout.paid", payoutObject({ status: "paid" }))
    await deliver(h, "evt_late", "payout.updated", payoutObject({ status: "pending" }))

    expect(h.payouts.rows[0]?.status).toBe("paid")
  })

  it("still records a genuine failure after a payout showed as paid", async () => {
    const h = harness()
    await deliver(h, "evt_paid", "payout.paid", payoutObject({ status: "paid" }))
    await deliver(h, "evt_failed", "payout.failed", payoutObject({ status: "failed" }))

    expect(h.payouts.rows[0]?.status).toBe("failed")
  })

  it("ignores a payout event for an account civfix does not know", async () => {
    const h = harness()
    await deliver(h, "evt_1", "payout.paid", payoutObject({ status: "paid" }), "acct_stranger")
    expect(h.payouts.rows).toHaveLength(0)
  })

  it("ignores a platform-scoped payout event that names no connected account", async () => {
    const h = harness()
    await deliver(h, "evt_1", "payout.paid", payoutObject({ status: "paid" }), null)
    expect(h.payouts.rows).toHaveLength(0)
  })

  it("maps only stripe's own payout vocabulary and defaults the rest to pending", () => {
    expect(payoutStatusOf("in_transit")).toBe("in_transit")
    expect(payoutStatusOf("paid")).toBe("paid")
    expect(payoutStatusOf("failed")).toBe("failed")
    expect(payoutStatusOf("canceled")).toBe("canceled")
    expect(payoutStatusOf("reversed")).toBe("pending")
    expect(payoutStatusOf(null)).toBe("pending")
  })
})
