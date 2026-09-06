import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { makeErrorHandler, makeNotFoundHandler } from "../../../src/errors/http-mapper.js"
import type { Container } from "../../../src/di.js"
import { registerAdminPaymentsRoutes } from "../../../src/routes/admin/payments.routes.js"
import {
  makeMemoryDonationRepository,
  type MemoryDonationSeed,
} from "../../../src/services/payments/donation-repository.memory.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { accountRow, eligibilityRow, orgRow, settingsRow } from "./helpers.js"

const OPERATOR = "11111111-1111-1111-1111-111111111111"
const ORG_A = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
const ORG_B = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb"

const PAYMENTS_ENV = {
  PAYMENTS_ENABLED: true,
  DONATION_PLATFORM_FEE_BPS: 500,
  DONATION_MIN_MINOR: 500,
  DONATION_MAX_MINOR: 1_000_000,
  ELIGIBILITY_STALE_GRACE_HOURS: 72,
  PAYMENT_METHOD_DOMAINS: ["civfix.org"],
  CA_CFP_REGISTRATION_NUMBER: "CFP-123456",
}

type DonationSeedRow = NonNullable<MemoryDonationSeed["donations"]>[number]

function donation(patch: Partial<DonationSeedRow> & { id: string }): DonationSeedRow {
  return {
    reference: `DON-${patch.id.slice(0, 4)}`,
    donorKey: "dddddddd-0000-4000-8000-dddddddddddd",
    organizationId: ORG_A,
    orgName: "Reach Out LA",
    eventId: null,
    userId: null,
    donorEmail: null,
    donorName: null,
    shareIdentityWithOrg: false,
    amountMinor: 10_000,
    currency: "USD" as const,
    feeBps: 500,
    feePlatformMinor: 500,
    feeStripeMinor: 320,
    netMinor: 9180,
    status: "succeeded" as const,
    failureReason: null,
    disputeState: "none" as const,
    refundedTotalMinor: 0,
    feeRefundedMinor: 0,
    stripeAccountId: "acct_test",
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    stripeApplicationFeeId: null,
    cardBrand: null,
    cardLast4: null,
    livemode: false,
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
  } as DonationSeedRow
}

async function harness(
  rows: DonationSeedRow[],
  mode: "live" | "test" = "test",
): Promise<FastifyInstance> {
  const donations = makeMemoryDonationRepository({
    donations: rows,
    orgNameOf: (id) => (id === ORG_A ? "Reach Out LA" : "Second Org"),
  })
  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: [orgRow()],
    accounts: [accountRow()],
    settings: [settingsRow()],
    eligibility: [eligibilityRow()],
  })

  const container = {
    env: { ...PAYMENTS_ENV, NODE_ENV: "test", WEB_ORIGINS: ["https://civfix.org"] },
    payments: { mode: () => mode },
    csrf: { protect: (_req: unknown, _reply: unknown, done: () => void) => done() },
    getDb: () => {
      throw new Error("admin payments routes must not reach the DB when overrides are installed")
    },
  } as unknown as Container

  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  const alwaysAllowed = () => () =>
    Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(app.decorate as (name: string, value: unknown) => void)("createRateLimit", alwaysAllowed)
  ;(app.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  app.addHook("onRequest", (request, _reply, done) => {
    ;(request as { auth?: unknown }).auth = { userId: OPERATOR, roles: ["operator"] }
    done()
  })
  app.decorate("adminPaymentsOverrides", { donations, orgs })
  await registerAdminPaymentsRoutes(app, container)
  await app.ready()
  return app
}

const WINDOW = "from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.000Z"

describe("admin per-organization donation totals", () => {
  it("aggregates a whole period server-side, one row per organization", async () => {
    const app = await harness([
      donation({ id: "d1" }),
      donation({ id: "d2", amountMinor: 2_500, feePlatformMinor: 125 }),
      donation({ id: "d3", organizationId: ORG_B, amountMinor: 4_000, feePlatformMinor: 200 }),
    ])

    const res = await app.inject({ method: "GET", url: `/v1/admin/donations/summary?${WINDOW}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      items: { organizationId: string; count: number; grossMinor: number; netMinor: number }[]
      truncated: boolean
      totals: { count: number; grossMinor: number }
    }
    expect(body.truncated).toBe(false)
    expect(body.totals.count).toBe(3)
    expect(body.totals.grossMinor).toBe(16_500)
    const a = body.items.find((row) => row.organizationId === ORG_A)
    expect(a?.count).toBe(2)
    expect(a?.grossMinor).toBe(12_500)
    expect(a?.netMinor).toBe(12_500 - 625)
  })

  it("excludes donations charged outside the requested period", async () => {
    const app = await harness([
      donation({
        id: "d1",
        chargedAt: new Date("2025-06-01T00:00:00.000Z"),
        createdAt: new Date("2025-06-01T00:00:00.000Z"),
      }),
      donation({ id: "d2" }),
    ])
    const res = await app.inject({ method: "GET", url: `/v1/admin/donations/summary?${WINDOW}` })
    expect((res.json() as { totals: { count: number } }).totals.count).toBe(1)
  })

  it("uses the charge date, not the row creation date, as the filing basis", async () => {
    const app = await harness([
      donation({
        id: "d1",
        createdAt: new Date("2025-12-31T23:00:00.000Z"),
        chargedAt: new Date("2026-01-01T01:00:00.000Z"),
      }),
      donation({
        id: "d2",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        chargedAt: new Date("2027-01-01T00:00:00.000Z"),
      }),
    ])
    const res = await app.inject({ method: "GET", url: `/v1/admin/donations/summary?${WINDOW}` })
    expect((res.json() as { totals: { count: number } }).totals.count).toBe(1)
  })

  it("never lets a test-mode donation into a filing total", async () => {
    const app = await harness(
      [donation({ id: "d1" }), donation({ id: "d2", livemode: true, amountMinor: 7_000 })],
      "live",
    )
    const res = await app.inject({ method: "GET", url: `/v1/admin/donations/summary?${WINDOW}` })
    const body = res.json() as { totals: { count: number; grossMinor: number } }
    expect(body.totals.count).toBe(1)
    expect(body.totals.grossMinor).toBe(7_000)
  })

  it("keeps test-mode rows out of the operator donation list in a live deployment", async () => {
    const app = await harness(
      [donation({ id: "d1" }), donation({ id: "d2", livemode: true })],
      "live",
    )
    const res = await app.inject({ method: "GET", url: "/v1/admin/donations" })
    const body = res.json() as { items: { id: string }[]; totals: { count: number } }
    expect(body.items.map((item) => item.id)).toEqual(["d2"])
    expect(body.totals.count).toBe(1)
  })

  it("422s a malformed page cursor rather than 500ing on the timestamp cast", async () => {
    const app = await harness([donation({ id: "d1" })])
    const res = await app.inject({ method: "GET", url: "/v1/admin/donations?cursor=zzzz" })
    expect(res.statusCode).toBe(422)
  })

  it("422s a malformed eligibility cursor rather than 500ing on the uuid cast", async () => {
    const app = await harness([])
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/payments/eligibility?cursor=not-a-uuid",
    })
    expect(res.statusCode).toBe(422)
  })

  it("422s a period whose end precedes its start rather than reporting zero", async () => {
    const app = await harness([donation({ id: "d1" })])
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/donations/summary?from=2026-12-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
    })
    expect(res.statusCode).toBe(422)
  })

  it("requires both period bounds — a filing total has no implicit window", async () => {
    const app = await harness([donation({ id: "d1" })])
    const res = await app.inject({ method: "GET", url: "/v1/admin/donations/summary" })
    expect(res.statusCode).toBe(422)
  })
})

describe("admin platform donation settings", () => {
  it("exposes the registration number and the fee configuration, and no secret", async () => {
    const app = await harness([])
    const res = await app.inject({ method: "GET", url: "/v1/admin/payments/settings" })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.registrationNumber).toBe("CFP-123456")
    expect(body.platformFeeBps).toBe(500)
    expect(body.paymentsEnabled).toBe(true)
    expect(body.currency).toBe("USD")
    const serialized = JSON.stringify(body)
    for (const secret of ["STRIPE", "whsec", "rk_", "sk_", "TOKEN_KEY"]) {
      expect(serialized).not.toContain(secret)
    }
  })
})
