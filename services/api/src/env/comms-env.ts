import { isCronish, parseBool, parseCsvLower, parseIntOr } from "./parsers.js"

export const UNSUBSCRIBE_SIGNING_KEY_MIN_LENGTH = 32

export const DEFAULT_MAIL_FROM_EVENTS = "events@civfix.org"

export interface CommsEnv {
  MAIL_FROM_EVENTS: string
  UNSUBSCRIBE_SIGNING_KEY: string

  BROADCAST_SWEEP_CRON: string
  EVENT_REMINDERS_CRON: string
  METRICS_ROLLUP_CRON: string
  HOST_RETENTION_CRON: string
  HOST_EXPORT_REAP_CRON: string

  HOST_BROADCAST_PER_EVENT_PER_DAY: number
  HOST_BROADCAST_RECIPIENTS_PER_DAY: number
  HOST_BROADCAST_COOLDOWN_SEC: number
  HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS: number
  HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR: number

  BROADCAST_MAX_RECIPIENTS: number
  BROADCAST_CHUNK_SIZE: number
  BROADCAST_EMAIL_CONCURRENCY: number
  BROADCAST_EMAIL_RATE_PER_SEC: number
  BROADCAST_LINK_ALLOWED_HOSTS: string[]

  HOST_MESSAGING_KILL_SWITCH: boolean

  HOST_ANALYTICS_CACHE_TTL_SEC: number
  PAGE_VIEW_DEDUPE_SEC: number
  METRICS_ROLLUP_LOOKBACK_DAYS: number

  HOST_EXPORT_MAX_ROWS: number
  HOST_EXPORT_TTL_HOURS: number

  SMS_HOST_BROADCAST_ENABLED: boolean
}

const DEV_UNSUBSCRIBE_SIGNING_KEY = "dev-insecure-unsubscribe-signing-key-do-not-use-in-prod"

export function loadCommsEnv(source: NodeJS.ProcessEnv, errors: string[]): CommsEnv {
  const isProd = (source.NODE_ENV ?? "").trim() === "production"

  function cron(key: string, fallback: string): string {
    const value = (source[key] ?? "").trim() || fallback
    if (!isCronish(value)) errors.push(`${key}: must be a 5- or 6-field cron expression`)
    return value
  }

  function bounded(key: string, fallback: number, min: number, max: number): number {
    const raw = parseIntOr(source[key], fallback)
    if (raw < min || raw > max) {
      errors.push(`${key}: must be an integer between ${min} and ${max}`)
      return fallback
    }
    return raw
  }

  if (isProd && (source.PUBLIC_API_URL ?? "").trim().length === 0) {
    errors.push(
      "PUBLIC_API_URL: required [BOOT] for host communications — the RFC 8058 List-Unsubscribe " +
        "header in every broadcast email is an API-origin URL, and a wrong origin makes one-click " +
        "unsubscribe fail for every recipient",
    )
  }

  const mailFromEvents = (source.MAIL_FROM_EVENTS ?? "").trim() || DEFAULT_MAIL_FROM_EVENTS
  if (!mailFromEvents.includes("@")) {
    errors.push("MAIL_FROM_EVENTS: must be an email address (it is the From of every host broadcast)")
  }

  let unsubscribeKey = (source.UNSUBSCRIBE_SIGNING_KEY ?? "").trim()
  if (isProd) {
    const sessionKey = (source.SESSION_SIGNING_KEY ?? "").trim()
    const anonKey = (source.ANON_TOKEN_SIGNING_KEY ?? "").trim()
    if (unsubscribeKey.length === 0) {
      errors.push("UNSUBSCRIBE_SIGNING_KEY: required [BOOT] variable is missing")
    } else if (unsubscribeKey === DEV_UNSUBSCRIBE_SIGNING_KEY) {
      errors.push("UNSUBSCRIBE_SIGNING_KEY: must not be the insecure dev default in production")
    } else if (unsubscribeKey.length < UNSUBSCRIBE_SIGNING_KEY_MIN_LENGTH) {
      errors.push(
        `UNSUBSCRIBE_SIGNING_KEY: must be at least ${UNSUBSCRIBE_SIGNING_KEY_MIN_LENGTH} characters in ` +
          "production (it signs the one-click unsubscribe capability carried in every broadcast email)",
      )
    } else if (unsubscribeKey === sessionKey || unsubscribeKey === anonKey) {
      errors.push(
        "UNSUBSCRIBE_SIGNING_KEY: must be a DIFFERENT value from SESSION_SIGNING_KEY and " +
          "ANON_TOKEN_SIGNING_KEY (one shared secret lets an oracle on either surface attack the other, " +
          "and rotating it after a mail incident would silently invalidate every live session)",
      )
    }
  } else if (unsubscribeKey.length === 0) {
    unsubscribeKey = DEV_UNSUBSCRIBE_SIGNING_KEY
  }

  return {
    MAIL_FROM_EVENTS: mailFromEvents,
    UNSUBSCRIBE_SIGNING_KEY: unsubscribeKey,

    BROADCAST_SWEEP_CRON: cron("BROADCAST_SWEEP_CRON", "*/2 * * * *"),
    EVENT_REMINDERS_CRON: cron("EVENT_REMINDERS_CRON", "*/10 * * * *"),
    METRICS_ROLLUP_CRON: cron("METRICS_ROLLUP_CRON", "7 * * * *"),
    HOST_RETENTION_CRON: cron("HOST_RETENTION_CRON", "35 4 * * *"),
    HOST_EXPORT_REAP_CRON: cron("HOST_EXPORT_REAP_CRON", "40 * * * *"),

    HOST_BROADCAST_PER_EVENT_PER_DAY: bounded("HOST_BROADCAST_PER_EVENT_PER_DAY", 3, 1, 100),
    HOST_BROADCAST_RECIPIENTS_PER_DAY: bounded(
      "HOST_BROADCAST_RECIPIENTS_PER_DAY",
      2000,
      1,
      1_000_000,
    ),
    HOST_BROADCAST_COOLDOWN_SEC: bounded("HOST_BROADCAST_COOLDOWN_SEC", 900, 1, 86_400),
    HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS: bounded(
      "HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS",
      24,
      0,
      8760,
    ),
    HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR: bounded(
      "HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR",
      3,
      1,
      100,
    ),

    BROADCAST_MAX_RECIPIENTS: bounded("BROADCAST_MAX_RECIPIENTS", 5000, 1, 100_000),
    BROADCAST_CHUNK_SIZE: bounded("BROADCAST_CHUNK_SIZE", 200, 1, 1000),
    BROADCAST_EMAIL_CONCURRENCY: bounded("BROADCAST_EMAIL_CONCURRENCY", 4, 1, 32),
    BROADCAST_EMAIL_RATE_PER_SEC: bounded("BROADCAST_EMAIL_RATE_PER_SEC", 10, 1, 500),
    BROADCAST_LINK_ALLOWED_HOSTS: parseCsvLower(source.BROADCAST_LINK_ALLOWED_HOSTS),

    HOST_MESSAGING_KILL_SWITCH: parseBool(source.HOST_MESSAGING_KILL_SWITCH, false),

    HOST_ANALYTICS_CACHE_TTL_SEC: bounded("HOST_ANALYTICS_CACHE_TTL_SEC", 120, 1, 3600),
    PAGE_VIEW_DEDUPE_SEC: clampDedupeSeconds(source.PAGE_VIEW_DEDUPE_SEC, errors),
    METRICS_ROLLUP_LOOKBACK_DAYS: bounded("METRICS_ROLLUP_LOOKBACK_DAYS", 3, 1, 90),

    HOST_EXPORT_MAX_ROWS: bounded("HOST_EXPORT_MAX_ROWS", 50_000, 1, 1_000_000),
    HOST_EXPORT_TTL_HOURS: bounded("HOST_EXPORT_TTL_HOURS", 24, 1, 168),

    SMS_HOST_BROADCAST_ENABLED: parseBool(source.SMS_HOST_BROADCAST_ENABLED, false),
  }
}

function clampDedupeSeconds(raw: string | undefined, errors: string[]): number {
  const value = parseIntOr(raw, 0)
  if (value < 0 || value > 3600) {
    errors.push("PAGE_VIEW_DEDUPE_SEC: must be an integer between 0 (off) and 3600")
    return 0
  }
  return value
}

