import { isCronish, parseBool, parseCsvLower, parseIntOr } from "./parsers.js"


export const PAYMENTS_SIGNING_KEY_MIN_LENGTH = 32

export const DEFAULT_STRIPE_API_VERSION = "2026-08-26.dahlia"

export interface PaymentsEnv {
  PAYMENTS_ENABLED: boolean
  STRIPE_SECRET_KEY_PAYMENTS: string
  STRIPE_WEBHOOK_SECRET_CONNECT: string
  STRIPE_WEBHOOK_SECRET_PLATFORM: string
  STRIPE_API_VERSION: string
  DONATION_PLATFORM_FEE_BPS: number
  DONATION_MIN_MINOR: number
  DONATION_MAX_MINOR: number
  DONATION_REFUND_APP_FEE: boolean
  DONATION_STATUS_TOKEN_KEY: string
  PAYMENT_METHOD_DOMAINS: string[]
  MAIL_FROM_RECEIPTS: string
  ELIGIBILITY_STALE_GRACE_HOURS: number
  STRIPE_EVENTS_SWEEP_CRON: string
  PAYMENTS_RECONCILE_CRON: string
  ELIGIBILITY_IRS_CRON: string
  ELIGIBILITY_FTB_CRON: string
  ELIGIBILITY_MNOS_CRON: string
  ELIGIBILITY_OFAC_CRON: string
  DONATION_RETENTION_CRON: string
  CA_CFP_REGISTRATION_NUMBER?: string
}

export const SIGNING_KEYS_THAT_MUST_DIFFER = [
  "SESSION_SIGNING_KEY",
  "ANON_TOKEN_SIGNING_KEY",
  "TICKET_TOKEN_SECRET",
  "UNSUBSCRIBE_SIGNING_KEY",
] as const

const DEV_STATUS_TOKEN_KEY = "dev-insecure-donation-status-token-key-do-not-use-in-prod"

function trimmed(source: NodeJS.ProcessEnv, key: string): string {
  const raw = source[key]
  return typeof raw === "string" ? raw.trim() : ""
}

function secretList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function webhookSecretsOf(value: string): string[] {
  return secretList(value)
}

export function loadPaymentsEnv(source: NodeJS.ProcessEnv, errors: string[]): PaymentsEnv {
  const isProd = trimmed(source, "NODE_ENV") === "production"
  const PAYMENTS_ENABLED = parseBool(source.PAYMENTS_ENABLED, false)
  const useFakePayments = parseBool(source.USE_FAKE_PAYMENTS, !isProd)
  const needsStripe = PAYMENTS_ENABLED && !useFakePayments

  function reqStr(key: string, opts: { gatedOff?: boolean } = {}): string {
    const value = trimmed(source, key)
    const required = isProd && !(opts.gatedOff ?? false)
    if (value.length === 0 && required) {
      errors.push(`${key}: required [BOOT] variable is missing`)
    }
    return value
  }

  function reqCron(key: string, fallback: string): string {
    const value = trimmed(source, key) || fallback
    if (!isCronish(value)) {
      errors.push(`${key}: must be a 5- or 6-field cron expression`)
    }
    return value
  }

  function minorAmount(key: string, fallback: number): number {
    const value = parseIntOr(source[key], fallback)
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(`${key}: must be a positive integer number of minor units (cents)`)
      return fallback
    }
    return value
  }

  const STRIPE_SECRET_KEY_PAYMENTS = reqStr("STRIPE_SECRET_KEY_PAYMENTS", { gatedOff: !needsStripe })
  const STRIPE_WEBHOOK_SECRET_CONNECT = reqStr("STRIPE_WEBHOOK_SECRET_CONNECT", {
    gatedOff: !needsStripe,
  })
  const STRIPE_WEBHOOK_SECRET_PLATFORM = reqStr("STRIPE_WEBHOOK_SECRET_PLATFORM", {
    gatedOff: !needsStripe,
  })

  if (needsStripe && STRIPE_SECRET_KEY_PAYMENTS.startsWith("sk_")) {
    errors.push(
      "STRIPE_SECRET_KEY_PAYMENTS: use a RESTRICTED key (rk_...) scoped to payments + connect, " +
        "never an unrestricted secret key",
    )
  }
  const connectSecrets = new Set(secretList(STRIPE_WEBHOOK_SECRET_CONNECT))
  const platformSecrets = new Set(secretList(STRIPE_WEBHOOK_SECRET_PLATFORM))
  const sharedSecrets = [...connectSecrets].filter((secret) => platformSecrets.has(secret))
  if (needsStripe && sharedSecrets.length > 0) {
    errors.push(
      "STRIPE_WEBHOOK_SECRET_CONNECT / STRIPE_WEBHOOK_SECRET_PLATFORM: must be DIFFERENT secrets — " +
        "one shared secret lets a platform-scope event be replayed onto the connect endpoint, " +
        "defeating the scope invariant",
    )
  }

  const DONATION_PLATFORM_FEE_BPS = parseIntOr(source.DONATION_PLATFORM_FEE_BPS, 500)
  if (
    !Number.isSafeInteger(DONATION_PLATFORM_FEE_BPS) ||
    DONATION_PLATFORM_FEE_BPS < 0 ||
    DONATION_PLATFORM_FEE_BPS > 2000
  ) {
    errors.push("DONATION_PLATFORM_FEE_BPS: must be an integer between 0 and 2000 basis points")
  }

  const DONATION_MIN_MINOR = minorAmount("DONATION_MIN_MINOR", 500)
  const DONATION_MAX_MINOR = minorAmount("DONATION_MAX_MINOR", 1_000_000)
  if (DONATION_MAX_MINOR < DONATION_MIN_MINOR) {
    errors.push("DONATION_MAX_MINOR: must be greater than or equal to DONATION_MIN_MINOR")
  }

  let DONATION_STATUS_TOKEN_KEY = trimmed(source, "DONATION_STATUS_TOKEN_KEY")
  if (isProd && PAYMENTS_ENABLED) {
    if (DONATION_STATUS_TOKEN_KEY.length === 0) {
      errors.push("DONATION_STATUS_TOKEN_KEY: required [BOOT] whenever PAYMENTS_ENABLED is true")
    } else if (DONATION_STATUS_TOKEN_KEY === DEV_STATUS_TOKEN_KEY) {
      errors.push("DONATION_STATUS_TOKEN_KEY: must not be the insecure dev default in production")
    } else if (DONATION_STATUS_TOKEN_KEY.length < PAYMENTS_SIGNING_KEY_MIN_LENGTH) {
      errors.push(
        `DONATION_STATUS_TOKEN_KEY: must be at least ${PAYMENTS_SIGNING_KEY_MIN_LENGTH} characters ` +
          "(it is the capability key a guest donor uses to read their own donation status)",
      )
    }
    const otherKeys = SIGNING_KEYS_THAT_MUST_DIFFER.map((key) => trimmed(source, key))
    if (
      DONATION_STATUS_TOKEN_KEY.length > 0 &&
      otherKeys.some((value) => value.length > 0 && value === DONATION_STATUS_TOKEN_KEY)
    ) {
      errors.push(
        `DONATION_STATUS_TOKEN_KEY: must be a DIFFERENT value from ${SIGNING_KEYS_THAT_MUST_DIFFER.join(", ")} ` +
          "(one shared secret turns a status-token oracle into a session, ticket or unsubscribe oracle)",
      )
    }
  } else if (DONATION_STATUS_TOKEN_KEY.length === 0) {
    DONATION_STATUS_TOKEN_KEY = DEV_STATUS_TOKEN_KEY
  }

  const ELIGIBILITY_STALE_GRACE_HOURS = parseIntOr(source.ELIGIBILITY_STALE_GRACE_HOURS, 72)
  if (!Number.isSafeInteger(ELIGIBILITY_STALE_GRACE_HOURS) || ELIGIBILITY_STALE_GRACE_HOURS < 0) {
    errors.push("ELIGIBILITY_STALE_GRACE_HOURS: must be a non-negative integer number of hours")
  }

  const CA_CFP_REGISTRATION_NUMBER = trimmed(source, "CA_CFP_REGISTRATION_NUMBER")

  return {
    PAYMENTS_ENABLED,
    STRIPE_SECRET_KEY_PAYMENTS,
    STRIPE_WEBHOOK_SECRET_CONNECT,
    STRIPE_WEBHOOK_SECRET_PLATFORM,
    STRIPE_API_VERSION: trimmed(source, "STRIPE_API_VERSION") || DEFAULT_STRIPE_API_VERSION,
    DONATION_PLATFORM_FEE_BPS,
    DONATION_MIN_MINOR,
    DONATION_MAX_MINOR,
    DONATION_REFUND_APP_FEE: parseBool(source.DONATION_REFUND_APP_FEE, true),
    DONATION_STATUS_TOKEN_KEY,
    PAYMENT_METHOD_DOMAINS: parseCsvLower(source.PAYMENT_METHOD_DOMAINS),
    MAIL_FROM_RECEIPTS: trimmed(source, "MAIL_FROM_RECEIPTS") || "no-reply@civfix.org",
    ELIGIBILITY_STALE_GRACE_HOURS,
    STRIPE_EVENTS_SWEEP_CRON: reqCron("STRIPE_EVENTS_SWEEP_CRON", "*/5 * * * *"),
    PAYMENTS_RECONCILE_CRON: reqCron("PAYMENTS_RECONCILE_CRON", "20 5 * * *"),
    ELIGIBILITY_IRS_CRON: reqCron("ELIGIBILITY_IRS_CRON", "0 9 5 * *"),
    ELIGIBILITY_FTB_CRON: reqCron("ELIGIBILITY_FTB_CRON", "30 9 5 * *"),
    ELIGIBILITY_MNOS_CRON: reqCron("ELIGIBILITY_MNOS_CRON", "0 17 * * 3"),
    ELIGIBILITY_OFAC_CRON: reqCron("ELIGIBILITY_OFAC_CRON", "0 10 5 * *"),
    DONATION_RETENTION_CRON: reqCron("DONATION_RETENTION_CRON", "50 4 * * *"),
    ...(CA_CFP_REGISTRATION_NUMBER.length > 0 ? { CA_CFP_REGISTRATION_NUMBER } : {}),
  }
}

