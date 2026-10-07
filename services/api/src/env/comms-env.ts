import { parseBool, parseCsvLower, parseIntOr } from "./parsers.js"
import { makeEnvReader, type EnvReader, type EnvSource } from "./reader.js"

const UNSUBSCRIBE_SIGNING_KEY_MIN_LENGTH = 32

const DEFAULT_MAIL_FROM_EVENTS = "events@civfix.org"

const PAGE_VIEW_DEDUPE_SEC_MAX = 3600

const COMMS_CRON_DEFAULTS = {
  BROADCAST_SWEEP_CRON: "*/2 * * * *",
  EVENT_REMINDERS_CRON: "*/10 * * * *",
  METRICS_ROLLUP_CRON: "7 * * * *",
  HOST_RETENTION_CRON: "35 4 * * *",
  HOST_EXPORT_REAP_CRON: "40 * * * *",
} as const

interface IntLimit {
  fallback: number
  min: number
  max: number
}

const COMMS_INT_LIMITS = {
  HOST_BROADCAST_PER_EVENT_PER_DAY: { fallback: 3, min: 1, max: 100 },
  HOST_BROADCAST_RECIPIENTS_PER_DAY: { fallback: 2000, min: 1, max: 1_000_000 },
  HOST_BROADCAST_COOLDOWN_SEC: { fallback: 900, min: 1, max: 86_400 },
  HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS: { fallback: 24, min: 0, max: 8760 },
  HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR: { fallback: 3, min: 1, max: 100 },
  BROADCAST_MAX_RECIPIENTS: { fallback: 5000, min: 1, max: 100_000 },
  BROADCAST_CHUNK_SIZE: { fallback: 200, min: 1, max: 1000 },
  BROADCAST_EMAIL_CONCURRENCY: { fallback: 4, min: 1, max: 32 },
  BROADCAST_EMAIL_RATE_PER_SEC: { fallback: 10, min: 1, max: 500 },
  HOST_ANALYTICS_CACHE_TTL_SEC: { fallback: 120, min: 1, max: 3600 },
  METRICS_ROLLUP_LOOKBACK_DAYS: { fallback: 3, min: 1, max: 90 },
  HOST_EXPORT_MAX_ROWS: { fallback: 50_000, min: 1, max: 1_000_000 },
  HOST_EXPORT_TTL_HOURS: { fallback: 24, min: 1, max: 168 },
} as const satisfies Record<string, IntLimit>

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

export function loadCommsEnv(source: EnvSource, errors: string[]): CommsEnv {
  const isProd = (source.NODE_ENV ?? "").trim() === "production"
  const r = makeEnvReader(source, errors, isProd)
  const cron = (key: keyof typeof COMMS_CRON_DEFAULTS): string =>
    r.cron(key, COMMS_CRON_DEFAULTS[key])
  const bounded = (key: keyof typeof COMMS_INT_LIMITS): number =>
    boundedInt(r, key, COMMS_INT_LIMITS[key])

  if (isProd && r.trimmed("PUBLIC_API_URL").length === 0) {
    errors.push(
      "PUBLIC_API_URL: required [BOOT] for host communications: the RFC 8058 List-Unsubscribe " +
        "header in every broadcast email is an API-origin URL, and a wrong origin makes one-click " +
        "unsubscribe fail for every recipient",
    )
  }

  const mailFromEvents = r.trimmed("MAIL_FROM_EVENTS") || DEFAULT_MAIL_FROM_EVENTS
  if (!mailFromEvents.includes("@")) {
    errors.push(
      "MAIL_FROM_EVENTS: must be an email address (it is the From of every host broadcast)",
    )
  }

  const unsubscribeKey = loadUnsubscribeSigningKey(r)

  return {
    MAIL_FROM_EVENTS: mailFromEvents,
    UNSUBSCRIBE_SIGNING_KEY: unsubscribeKey,

    BROADCAST_SWEEP_CRON: cron("BROADCAST_SWEEP_CRON"),
    EVENT_REMINDERS_CRON: cron("EVENT_REMINDERS_CRON"),
    METRICS_ROLLUP_CRON: cron("METRICS_ROLLUP_CRON"),
    HOST_RETENTION_CRON: cron("HOST_RETENTION_CRON"),
    HOST_EXPORT_REAP_CRON: cron("HOST_EXPORT_REAP_CRON"),

    HOST_BROADCAST_PER_EVENT_PER_DAY: bounded("HOST_BROADCAST_PER_EVENT_PER_DAY"),
    HOST_BROADCAST_RECIPIENTS_PER_DAY: bounded("HOST_BROADCAST_RECIPIENTS_PER_DAY"),
    HOST_BROADCAST_COOLDOWN_SEC: bounded("HOST_BROADCAST_COOLDOWN_SEC"),
    HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS: bounded("HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS"),
    HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR: bounded("HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR"),

    BROADCAST_MAX_RECIPIENTS: bounded("BROADCAST_MAX_RECIPIENTS"),
    BROADCAST_CHUNK_SIZE: bounded("BROADCAST_CHUNK_SIZE"),
    BROADCAST_EMAIL_CONCURRENCY: bounded("BROADCAST_EMAIL_CONCURRENCY"),
    BROADCAST_EMAIL_RATE_PER_SEC: bounded("BROADCAST_EMAIL_RATE_PER_SEC"),
    BROADCAST_LINK_ALLOWED_HOSTS: parseCsvLower(source.BROADCAST_LINK_ALLOWED_HOSTS),

    HOST_MESSAGING_KILL_SWITCH: parseBool(source.HOST_MESSAGING_KILL_SWITCH, false),

    HOST_ANALYTICS_CACHE_TTL_SEC: bounded("HOST_ANALYTICS_CACHE_TTL_SEC"),
    PAGE_VIEW_DEDUPE_SEC: clampDedupeSeconds(source.PAGE_VIEW_DEDUPE_SEC, errors),
    METRICS_ROLLUP_LOOKBACK_DAYS: bounded("METRICS_ROLLUP_LOOKBACK_DAYS"),

    HOST_EXPORT_MAX_ROWS: bounded("HOST_EXPORT_MAX_ROWS"),
    HOST_EXPORT_TTL_HOURS: bounded("HOST_EXPORT_TTL_HOURS"),

    SMS_HOST_BROADCAST_ENABLED: parseBool(source.SMS_HOST_BROADCAST_ENABLED, false),
  }
}

function loadUnsubscribeSigningKey(r: EnvReader): string {
  const unsubscribeKey = r.trimmed("UNSUBSCRIBE_SIGNING_KEY")
  if (!r.isProd) {
    return unsubscribeKey.length > 0 ? unsubscribeKey : DEV_UNSUBSCRIBE_SIGNING_KEY
  }
  if (unsubscribeKey.length === 0) {
    r.errors.push("UNSUBSCRIBE_SIGNING_KEY: required [BOOT] variable is missing")
  } else if (unsubscribeKey === DEV_UNSUBSCRIBE_SIGNING_KEY) {
    r.errors.push("UNSUBSCRIBE_SIGNING_KEY: must not be the insecure dev default in production")
  } else if (unsubscribeKey.length < UNSUBSCRIBE_SIGNING_KEY_MIN_LENGTH) {
    r.errors.push(
      `UNSUBSCRIBE_SIGNING_KEY: must be at least ${UNSUBSCRIBE_SIGNING_KEY_MIN_LENGTH} characters in ` +
        "production (it signs the one-click unsubscribe capability carried in every broadcast email)",
    )
  } else if (
    unsubscribeKey === r.trimmed("SESSION_SIGNING_KEY") ||
    unsubscribeKey === r.trimmed("ANON_TOKEN_SIGNING_KEY")
  ) {
    r.errors.push(
      "UNSUBSCRIBE_SIGNING_KEY: must be a DIFFERENT value from SESSION_SIGNING_KEY and " +
        "ANON_TOKEN_SIGNING_KEY (one shared secret lets an oracle on either surface attack the other, " +
        "and rotating it after a mail incident would silently invalidate every live session)",
    )
  }
  return unsubscribeKey
}

function boundedInt(r: EnvReader, key: string, limit: IntLimit): number {
  const value = parseIntOr(r.source[key], limit.fallback, { key, errors: r.errors })
  if (value < limit.min || value > limit.max) {
    r.errors.push(`${key}: must be an integer between ${limit.min} and ${limit.max}`)
    return limit.fallback
  }
  return value
}

function clampDedupeSeconds(raw: string | undefined, errors: string[]): number {
  const value = parseIntOr(raw, 0, { key: "PAGE_VIEW_DEDUPE_SEC", errors })
  if (value < 0 || value > PAGE_VIEW_DEDUPE_SEC_MAX) {
    errors.push(
      `PAGE_VIEW_DEDUPE_SEC: must be an integer between 0 (off) and ${PAGE_VIEW_DEDUPE_SEC_MAX}`,
    )
    return 0
  }
  return value
}
