import { describe, expect, it, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakeAbuseChecks, FakeJobs, FakePayments, FakeStorage } from "@civfix/shared/fakes"
import { makeErrorHandler, makeNotFoundHandler } from "../../../src/errors/http-mapper.js"
import type { Container } from "../../../src/di.js"
import { registerDonationRoutes } from "../../../src/routes/donations.routes.js"
import { registerLegalRoutes } from "../../../src/routes/legal.routes.js"
import { makeMemoryDonationRepository } from "../../../src/services/payments/donation-repository.memory.js"
import { makeMemoryOrgPaymentsRepository } from "../../../src/services/payments/org-payments-repository.memory.js"
import { mintDonationStatusToken } from "../../../src/services/payments/donation-status-token.js"
import {
  NOW,
  ORG_SLUG,
  STATUS_TOKEN_KEY,
  accountRow,
  currentConsent,
  eligibilityRow,
  orgRow,
  settingsRow,
} from "./helpers.js"

const PAYMENTS_ENV = {
  PAYMENTS_ENABLED: true,
  STRIPE_API_VERSION: "2026-08-26.dahlia",
  STRIPE_SECRET_KEY_PAYMENTS: "",
  STRIPE_WEBHOOK_SECRET_CONNECT: "",
  STRIPE_WEBHOOK_SECRET_PLATFORM: "",
  DONATION_PLATFORM_FEE_BPS: 500,
  DONATION_MIN_MINOR: 500,
  DONATION_MAX_MINOR: 1_000_000,
  DONATION_REFUND_APP_FEE: true,
  DONATION_STATUS_TOKEN_KEY: STATUS_TOKEN_KEY,
  PAYMENT_METHOD_DOMAINS: [],
  MAIL_FROM_RECEIPTS: "receipts@civfix.org",
  ELIGIBILITY_STALE_GRACE_HOURS: 72,
  STRIPE_EVENTS_SWEEP_CRON: "*/5 * * * *",
  PAYMENTS_RECONCILE_CRON: "20 5 * * *",
  ELIGIBILITY_IRS_CRON: "0 9 5 * *",
  ELIGIBILITY_FTB_CRON: "30 9 5 * *",
  ELIGIBILITY_MNOS_CRON: "0 17 * * 3",
  ELIGIBILITY_OFAC_CRON: "0 10 5 * *",
  DONATION_RETENTION_CRON: "50 4 * * *",
  CA_CFP_REGISTRATION_NUMBER: "CFP-123456",
}

interface Harness {
  app: FastifyInstance
  donations: ReturnType<typeof makeMemoryDonationRepository>
  abuse: FakeAbuseChecks
  counters: Map<string, number>
}

async function harness(
  options: { turnstilePasses?: boolean; countersThrow?: boolean } = {},
): Promise<Harness> {
  const payments = new FakePayments({ now: () => NOW.getTime() })
  const created = await payments.createConnectedAccount({
    orgId: orgRow().id,
    email: "org@civfix.org",
    legalName: "REACH OUT LOS ANGELES INC",
    idempotencyKey: "acct:test:v1",
  })
  payments.settleAccount(created.accountId)

  const orgs = makeMemoryOrgPaymentsRepository({
    orgs: [orgRow()],
    accounts: [accountRow({ stripeAccountId: created.accountId })],
    settings: [settingsRow()],
    eligibility: [eligibilityRow()],
  })
  const donations = makeMemoryDonationRepository({ orgNameOf: () => "Reach Out LA" })
  const abuse = new FakeAbuseChecks()
  if (options.turnstilePasses === false) {
    abuse.verifyTurnstile = () => Promise.resolve(false)
  }
  const counters = new Map<string, number>()

  const container = {
    env: { ...PAYMENTS_ENV, NODE_ENV: "test", WEB_ORIGINS: ["https://civfix.org"] },
    payments,
    jobs: new FakeJobs(),
    storage: new FakeStorage(),
    abuseChecks: abuse,
    csrf: { protect: (_req: unknown, _reply: unknown, done: () => void) => done() },
    getCounterStore: () => ({
      incr: (key: string) => {
        if (options.countersThrow) return Promise.reject(new Error("redis down"))
        const next = (counters.get(key) ?? 0) + 1
        counters.set(key, next)
        return Promise.resolve(next)
      },
    }),
    getDb: () => {
      throw new Error("routes must not reach the database when overrides are installed")
    },
  } as unknown as Container

  const app = Fastify({ logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  const alwaysAllowed = () => () => Promise.resolve({ isAllowed: true, isExceeded: false, max: 1, remaining: 1, ttlInSeconds: 0 })
  ;(app.decorate as (name: string, value: unknown) => void)("createRateLimit", alwaysAllowed)
  app.decorate("donationOverrides", {
    donations,
    orgs,
    storage: new FakeStorage(),
    now: () => NOW,
    newId: () => "aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa",
  })
  ;(app.decorateRequest as (name: string, value: unknown) => void)("auth", null)
  await registerDonationRoutes(app, container)
  await registerLegalRoutes(app, container)
  await app.ready()

  return { app, donations, abuse, counters }
}

function checkoutBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgSlug: ORG_SLUG,
    amountMinor: 5000,
    currency: "USD",
    email: "donor@example.org",
    shareIdentity: false,
    idempotencyKey: "idem-key-0001",
    consent: currentConsent(),
    turnstileToken: "turnstile-ok",
    ...patch,
  }
}

describe("donation routes", () => {
  let h: Harness

  beforeEach(async () => {
    h = await harness()
  })

  it("serves the public donate page without a session", async () => {
    const response = await h.app.inject({ method: "GET", url: `/v1/orgs/by-slug/${ORG_SLUG}/donate` })
    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.json()).toMatchObject({ donateState: "READY", registrationNumber: "CFP-123456" })
  })

  it("404s an unknown slug", async () => {
    const response = await h.app.inject({ method: "GET", url: "/v1/orgs/by-slug/unknown-org/donate" })
    expect(response.statusCode).toBe(404)
  })

  it("creates a checkout for a guest that passes Turnstile", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/donations/checkout",
      payload: checkoutBody(),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.donationId).toBe("aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa")
    expect(body.clientSecret.length).toBeGreaterThan(0)
    expect(body.feeBreakdown.platformFeeMinor).toBe(250)
    expect(h.donations.rows).toHaveLength(1)
  })

  it("refuses a guest checkout with no Turnstile token", async () => {
    const body = checkoutBody()
    delete body.turnstileToken
    const response = await h.app.inject({ method: "POST", url: "/v1/donations/checkout", payload: body })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe("TURNSTILE_FAILED")
    expect(h.donations.rows).toHaveLength(0)
  })

  it("refuses a guest checkout whose Turnstile token does not verify", async () => {
    const failing = await harness({ turnstilePasses: false })
    const response = await failing.app.inject({
      method: "POST",
      url: "/v1/donations/checkout",
      payload: checkoutBody(),
    })
    expect(response.statusCode).toBe(403)
    expect(failing.donations.rows).toHaveLength(0)
  })

  it("counts the organization cap and fails CLOSED when the counter store is down", async () => {
    await h.app.inject({ method: "POST", url: "/v1/donations/checkout", payload: checkoutBody() })
    expect([...h.counters.values()][0]).toBe(1)

    const broken = await harness({ countersThrow: true })
    const response = await broken.app.inject({
      method: "POST",
      url: "/v1/donations/checkout",
      payload: checkoutBody(),
    })
    expect(response.statusCode).toBe(429)
    expect(broken.donations.rows).toHaveLength(0)
  })

  it("422s a body that is not strictly valid", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/donations/checkout",
      payload: { ...checkoutBody(), unexpected: true },
    })
    expect(response.statusCode).toBe(422)
  })

  it("answers the status endpoint identically for a wrong, forged or unknown pair", async () => {
    await h.app.inject({ method: "POST", url: "/v1/donations/checkout", payload: checkoutBody() })
    const donationId = h.donations.rows[0]?.id as string

    const withToken = await h.app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/status?token=${mintDonationStatusToken(STATUS_TOKEN_KEY, donationId)}`,
    })
    expect(withToken.statusCode).toBe(200)
    expect(withToken.json().maskedEmail).not.toBe("donor@example.org")

    const forged = await h.app.inject({
      method: "GET",
      url: `/v1/donations/${donationId}/status?token=${"v1.".padEnd(40, "x")}`,
    })
    const unknown = await h.app.inject({
      method: "GET",
      url: `/v1/donations/11111111-1111-4111-8111-111111111111/status?token=${"v1.".padEnd(40, "x")}`,
    })
    const missing = await h.app.inject({ method: "GET", url: `/v1/donations/${donationId}/status` })

    for (const response of [forged, unknown, missing]) {
      expect(response.statusCode).toBe(404)
    }
    expect(forged.json().message).toBe(unknown.json().message)
    expect(forged.json().message).toBe(missing.json().message)
  })

  it("requires a session for the donor's own donation list and receipt", async () => {
    expect((await h.app.inject({ method: "GET", url: "/v1/me/donations" })).statusCode).toBe(401)
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: "/v1/me/donations/11111111-1111-4111-8111-111111111111/receipt",
        })
      ).statusCode,
    ).toBe(401)
  })
})

describe("legal versions route", () => {
  it("serves the document set publicly and cacheably", async () => {
    const h = await harness()
    const response = await h.app.inject({ method: "GET", url: "/v1/legal/versions" })
    expect(response.statusCode).toBe(200)
    expect(response.headers["cache-control"]).toContain("max-age=300")
    const body = response.json()
    expect(body.documents.length).toBeGreaterThan(0)
    expect(body.documents[0]).toHaveProperty("sha256")
  })
})
