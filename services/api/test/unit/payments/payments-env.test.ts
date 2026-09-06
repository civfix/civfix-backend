import { describe, expect, it } from "vitest"
import { loadPaymentsEnv, webhookSecretsOf } from "../../../src/env/payments-env.js"

const PROD_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PAYMENTS_ENABLED: "true",
  USE_FAKE_PAYMENTS: "false",
  STRIPE_SECRET_KEY_PAYMENTS: "rk_live_abc",
  STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_connect",
  STRIPE_WEBHOOK_SECRET_PLATFORM: "whsec_platform",
  DONATION_STATUS_TOKEN_KEY: "a-donation-status-token-key-of-32-chars",
  SESSION_SIGNING_KEY: "a-session-signing-key-of-at-least-32-chars",
  ANON_TOKEN_SIGNING_KEY: "an-anon-token-signing-key-of-32-chars-x",
}

function load(source: NodeJS.ProcessEnv): { errors: string[]; env: ReturnType<typeof loadPaymentsEnv> } {
  const errors: string[] = []
  const env = loadPaymentsEnv(source, errors)
  return { errors, env }
}

describe("payments env", () => {
  it("defaults everything off and usable outside production", () => {
    const { errors, env } = load({ NODE_ENV: "development" })
    expect(errors).toEqual([])
    expect(env.PAYMENTS_ENABLED).toBe(false)
    expect(env.DONATION_PLATFORM_FEE_BPS).toBe(500)
    expect(env.DONATION_MIN_MINOR).toBe(500)
    expect(env.DONATION_MAX_MINOR).toBe(1_000_000)
    expect(env.DONATION_REFUND_APP_FEE).toBe(true)
    expect(env.STRIPE_API_VERSION).toBe("2026-08-26.dahlia")
    expect(env.ELIGIBILITY_MNOS_CRON).toBe("0 17 * * 3")
    expect(env.DONATION_STATUS_TOKEN_KEY.length).toBeGreaterThan(0)
  })

  it("does not require Stripe credentials while payments are disabled in production", () => {
    const { errors } = load({ NODE_ENV: "production", PAYMENTS_ENABLED: "false" })
    expect(errors.filter((error) => error.includes("STRIPE_"))).toEqual([])
  })

  it("requires Stripe credentials once payments are enabled in production", () => {
    const { errors } = load({ NODE_ENV: "production", PAYMENTS_ENABLED: "true", USE_FAKE_PAYMENTS: "false" })
    expect(errors.some((error) => error.startsWith("STRIPE_SECRET_KEY_PAYMENTS"))).toBe(true)
    expect(errors.some((error) => error.startsWith("STRIPE_WEBHOOK_SECRET_CONNECT"))).toBe(true)
    expect(errors.some((error) => error.startsWith("STRIPE_WEBHOOK_SECRET_PLATFORM"))).toBe(true)
    expect(errors.some((error) => error.startsWith("DONATION_STATUS_TOKEN_KEY"))).toBe(true)
  })

  it("accepts a fully configured production environment", () => {
    const { errors, env } = load(PROD_BASE)
    expect(errors).toEqual([])
    expect(env.PAYMENTS_ENABLED).toBe(true)
  })

  it("refuses an unrestricted secret key", () => {
    const { errors } = load({ ...PROD_BASE, STRIPE_SECRET_KEY_PAYMENTS: "sk_live_abc" })
    expect(errors.some((error) => error.includes("RESTRICTED key"))).toBe(true)
  })

  it("refuses one shared webhook secret across both scopes", () => {
    const { errors } = load({ ...PROD_BASE, STRIPE_WEBHOOK_SECRET_PLATFORM: "whsec_connect" })
    expect(errors.some((error) => error.includes("must be DIFFERENT secrets"))).toBe(true)
  })

  it("refuses a status token key that is short, or shared with another signing key", () => {
    expect(
      load({ ...PROD_BASE, DONATION_STATUS_TOKEN_KEY: "short" }).errors.some((error) =>
        error.includes("at least 32 characters"),
      ),
    ).toBe(true)
    expect(
      load({
        ...PROD_BASE,
        DONATION_STATUS_TOKEN_KEY: PROD_BASE.SESSION_SIGNING_KEY as string,
      }).errors.some((error) => error.includes("DIFFERENT value")),
    ).toBe(true)
  })

  it("bounds the platform fee to 0..2000 basis points", () => {
    expect(load({ ...PROD_BASE, DONATION_PLATFORM_FEE_BPS: "2500" }).errors.length).toBeGreaterThan(0)
    expect(load({ ...PROD_BASE, DONATION_PLATFORM_FEE_BPS: "0" }).errors).toEqual([])
    expect(load({ ...PROD_BASE, DONATION_PLATFORM_FEE_BPS: "0" }).env.DONATION_PLATFORM_FEE_BPS).toBe(0)
  })

  it("refuses a maximum below the minimum", () => {
    const { errors } = load({ ...PROD_BASE, DONATION_MIN_MINOR: "10000", DONATION_MAX_MINOR: "500" })
    expect(errors.some((error) => error.startsWith("DONATION_MAX_MINOR"))).toBe(true)
  })

  it("validates every cron expression", () => {
    const { errors } = load({ ...PROD_BASE, PAYMENTS_RECONCILE_CRON: "not a cron" })
    expect(errors.some((error) => error.startsWith("PAYMENTS_RECONCILE_CRON"))).toBe(true)
  })

  it("parses a comma list of webhook secrets so a secret roll can overlap", () => {
    expect(webhookSecretsOf(" whsec_old , whsec_new ")).toEqual(["whsec_old", "whsec_new"])
    expect(webhookSecretsOf("")).toEqual([])
  })

  it("lowercases the payment method domains", () => {
    const { env } = load({ ...PROD_BASE, PAYMENT_METHOD_DOMAINS: "Civfix.org, WWW.civfix.org" })
    expect(env.PAYMENT_METHOD_DOMAINS).toEqual(["civfix.org", "www.civfix.org"])
  })
})

describe("signing key distinctness and webhook secret rolls", () => {
  it("rejects a status token key reused as the ticket or unsubscribe key", () => {
    for (const key of ["TICKET_TOKEN_SECRET", "UNSUBSCRIBE_SIGNING_KEY"]) {
      const { errors } = load({
        ...PROD_BASE,
        [key]: PROD_BASE.DONATION_STATUS_TOKEN_KEY as string,
      })
      expect(errors.some((error) => error.startsWith("DONATION_STATUS_TOKEN_KEY"))).toBe(true)
    }
  })

  it("accepts distinct ticket and unsubscribe keys", () => {
    const { errors } = load({
      ...PROD_BASE,
      TICKET_TOKEN_SECRET: "a-ticket-token-secret-of-at-least-32-chars",
      UNSUBSCRIBE_SIGNING_KEY: "an-unsubscribe-signing-key-of-32-chars",
    })
    expect(errors).toEqual([])
  })

  it("rejects a roll list that shares one secret between the two endpoints", () => {
    const { errors } = load({
      ...PROD_BASE,
      STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_old, whsec_shared",
      STRIPE_WEBHOOK_SECRET_PLATFORM: "whsec_shared ,whsec_new",
    })
    expect(errors.some((error) => error.startsWith("STRIPE_WEBHOOK_SECRET_CONNECT"))).toBe(true)
  })

  it("accepts overlapping-in-time roll lists that share no secret", () => {
    const { errors, env } = load({
      ...PROD_BASE,
      STRIPE_WEBHOOK_SECRET_CONNECT: "whsec_c_old,whsec_c_new",
      STRIPE_WEBHOOK_SECRET_PLATFORM: "whsec_p_old,whsec_p_new",
    })
    expect(errors).toEqual([])
    expect(webhookSecretsOf(env.STRIPE_WEBHOOK_SECRET_CONNECT)).toEqual([
      "whsec_c_old",
      "whsec_c_new",
    ])
  })
})
