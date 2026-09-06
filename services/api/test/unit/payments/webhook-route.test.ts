import { describe, expect, it, beforeEach } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { FakePayments } from "@civfix/shared/fakes"
import type { Container } from "../../../src/di.js"
import {
  registerStripeWebhooks,
  STRIPE_WEBHOOK_CONNECT_PATH,
  STRIPE_WEBHOOK_PLATFORM_PATH,
  checkScopeInvariant,
} from "../../../src/routes/webhooks/stripe.routes.js"
import { makeMemoryStripeEventRepository } from "../../../src/services/payments/donation-repository.memory.js"
import type { StripeEventRepository } from "../../../src/services/payments/donation-repository.drizzle.js"

const CLOCK_MS = Date.UTC(2026, 5, 1, 12, 0, 0)

interface Harness {
  app: FastifyInstance
  payments: FakePayments
  events: StripeEventRepository
  enqueued: { name: string; data: unknown }[]
}

function connectEvent(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_connect_1",
    type: "checkout.session.completed",
    livemode: false,
    account: "acct_fake_1",
    created: Math.floor(CLOCK_MS / 1000),
    data: { object: { id: "cs_fake_1" } },
    ...patch,
  }
}

function platformEvent(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt_platform_1",
    type: "application_fee.created",
    livemode: false,
    created: Math.floor(CLOCK_MS / 1000),
    data: { object: { id: "fee_fake_1" } },
    ...patch,
  }
}

async function harness(options: {
  events?: StripeEventRepository
  enqueueThrows?: boolean
  paymentsEnabled?: boolean
  mode?: "live" | "test"
} = {}): Promise<Harness> {
  const payments = new FakePayments({
    now: () => CLOCK_MS,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  })
  const events = options.events ?? makeMemoryStripeEventRepository()
  const enqueued: { name: string; data: unknown }[] = []

  const container = {
    env: {
      NODE_ENV: "test",
      PAYMENTS_ENABLED: options.paymentsEnabled ?? true,
      STRIPE_API_VERSION: "2026-08-26.dahlia",
      DONATION_PLATFORM_FEE_BPS: 500,
      DONATION_MIN_MINOR: 500,
      DONATION_MAX_MINOR: 1_000_000,
      DONATION_REFUND_APP_FEE: true,
      DONATION_STATUS_TOKEN_KEY: "a-donation-status-token-key-of-32-chars",
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
      STRIPE_SECRET_KEY_PAYMENTS: "",
      STRIPE_WEBHOOK_SECRET_CONNECT: "",
      STRIPE_WEBHOOK_SECRET_PLATFORM: "",
      WEB_ORIGINS: ["https://civfix.org"],
    },
    payments,
    jobs: {
      enqueue: (name: string, data: unknown) => {
        if (options.enqueueThrows) return Promise.reject(new Error("queue is down"))
        enqueued.push({ name, data })
        return Promise.resolve("job-1")
      },
    },
    getDb: () => {
      throw new Error("the webhook route must not reach for the database when overridden")
    },
  } as unknown as Container

  const app = Fastify({ logger: false })
  app.decorate("stripeWebhookOverrides", { events, now: () => new Date(CLOCK_MS) })
  await registerStripeWebhooks(app, container)
  await app.ready()
  return { app, payments, events, enqueued }
}

describe("stripe webhook route", () => {
  let h: Harness

  beforeEach(async () => {
    h = await harness()
  })

  it("accepts a correctly signed connect event, stores it and enqueues processing", async () => {
    const signed = h.payments.signWebhook(connectEvent(), "connect")
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(200)
    expect(await h.events.find("evt_connect_1")).not.toBeNull()
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]?.name).toBe("stripe.event.process")
  })

  it("answers 400 with an empty body on a bad signature and stores nothing", async () => {
    const signed = h.payments.signWebhook(connectEvent(), "connect")
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: {
        "content-type": "application/json",
        "stripe-signature": signed.signatureHeader.replace(/.$/, "0"),
      },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toBe("")
    expect(await h.events.find("evt_connect_1")).toBeNull()
    expect(h.enqueued).toHaveLength(0)
  })

  it("answers 400 when the signature header is missing entirely", async () => {
    const signed = h.payments.signWebhook(connectEvent(), "connect")
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json" },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(400)
  })

  it("rejects a body that was re-serialized rather than passed through verbatim", async () => {
    const event = connectEvent()
    const signed = h.payments.signWebhook(event, "connect")
    const reparsed = JSON.stringify({ ...JSON.parse(signed.rawBody), extra: true })
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: reparsed,
    })
    expect(response.statusCode).toBe(400)
  })

  it("answers 200 and does nothing on a duplicate delivery", async () => {
    const signed = h.payments.signWebhook(connectEvent(), "connect")
    const send = () =>
      h.app.inject({
        method: "POST",
        url: STRIPE_WEBHOOK_CONNECT_PATH,
        headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
        payload: signed.rawBody,
      })
    expect((await send()).statusCode).toBe(200)
    const second = await send()
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ duplicate: true })
    expect(h.enqueued).toHaveLength(1)
  })

  it("answers 200 without storing when livemode does not match the environment", async () => {
    const signed = h.payments.signWebhook(connectEvent({ livemode: true }), "connect")
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(200)
    expect(await h.events.find("evt_connect_1")).toBeNull()
    expect(h.enqueued).toHaveLength(0)
  })

  it("takes the expected livemode from the configured key, not from NODE_ENV", async () => {
    const live = await harness({ mode: "live" })
    const testModeEvent = live.payments.signWebhook(connectEvent({ livemode: false }), "connect")
    const dropped = await live.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: {
        "content-type": "application/json",
        "stripe-signature": testModeEvent.signatureHeader,
      },
      payload: testModeEvent.rawBody,
    })
    expect(dropped.statusCode).toBe(200)
    expect(await live.events.find("evt_connect_1")).toBeNull()

    const liveEvent = live.payments.signWebhook(connectEvent({ livemode: true }), "connect")
    const stored = await live.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: {
        "content-type": "application/json",
        "stripe-signature": liveEvent.signatureHeader,
      },
      payload: liveEvent.rawBody,
    })
    expect(stored.statusCode).toBe(200)
    expect(await live.events.find("evt_connect_1")).not.toBeNull()
    expect(live.enqueued).toHaveLength(1)
  })

  it("answers 200 without storing when the scope invariant is violated", async () => {
    const noAccount = h.payments.signWebhook(connectEvent({ account: undefined }), "connect")
    const connectResponse = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": noAccount.signatureHeader },
      payload: noAccount.rawBody,
    })
    expect(connectResponse.statusCode).toBe(200)
    expect(await h.events.find("evt_connect_1")).toBeNull()

    const withAccount = h.payments.signWebhook(
      platformEvent({ account: "acct_fake_1" }),
      "platform",
    )
    const platformResponse = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_PLATFORM_PATH,
      headers: { "content-type": "application/json", "stripe-signature": withAccount.signatureHeader },
      payload: withAccount.rawBody,
    })
    expect(platformResponse.statusCode).toBe(200)
    expect(await h.events.find("evt_platform_1")).toBeNull()
  })

  it("accepts a well-formed platform event on the platform path", async () => {
    const signed = h.payments.signWebhook(platformEvent(), "platform")
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_PLATFORM_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(200)
    expect(await h.events.find("evt_platform_1")).not.toBeNull()
  })

  it("returns 5xx ONLY when the durable insert fails", async () => {
    const failing = makeMemoryStripeEventRepository()
    failing.insert = () => Promise.reject(new Error("insert failed"))
    const broken = await harness({ events: failing })
    const signed = broken.payments.signWebhook(connectEvent(), "connect")
    const response = await broken.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(500)
  })

  it("still answers 200 when the enqueue fails, because the row is already durable", async () => {
    const flaky = await harness({ enqueueThrows: true })
    const signed = flaky.payments.signWebhook(connectEvent(), "connect")
    const response = await flaky.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(200)
    expect(await flaky.events.find("evt_connect_1")).not.toBeNull()
  })

  it("registers no route at all when payments are disabled", async () => {
    const off = await harness({ paymentsEnabled: false })
    const response = await off.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
      payload: "{}",
    })
    expect(response.statusCode).toBe(404)
  })

  it("requires no CSRF token", async () => {
    const signed = h.payments.signWebhook(connectEvent(), "connect")
    const response = await h.app.inject({
      method: "POST",
      url: STRIPE_WEBHOOK_CONNECT_PATH,
      headers: { "content-type": "application/json", "stripe-signature": signed.signatureHeader },
      payload: signed.rawBody,
    })
    expect(response.statusCode).toBe(200)
  })
})

describe("scope invariant", () => {
  it("requires an account on connect and forbids one on platform", () => {
    const base = {
      id: "evt_1",
      type: "t",
      livemode: false,
      apiVersion: null,
      createdSec: 0,
      data: { object: {} },
    }
    expect(checkScopeInvariant({ ...base, scope: "connect", accountId: "acct_1" })).toBe("ok")
    expect(checkScopeInvariant({ ...base, scope: "connect", accountId: null })).toBe(
      "connect_without_account",
    )
    expect(checkScopeInvariant({ ...base, scope: "platform", accountId: null })).toBe("ok")
    expect(checkScopeInvariant({ ...base, scope: "platform", accountId: "acct_1" })).toBe(
      "platform_with_account",
    )
  })
})
