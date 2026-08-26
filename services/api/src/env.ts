
import { z } from "zod"
import type { Env } from "./env/types.js"
import {
  isCronish,
  parseBool,
  parseBounds,
  parseCsv,
  parseCsvLower,
  parseIntOr,
  parsePositiveIntOr,
  parseTrustProxy,
} from "./env/parsers.js"

export type { Env } from "./env/types.js"
export type { TrustProxyValue } from "./env/parsers.js"
export {
  parseBool,
  parseCsv,
  parseCsvLower,
  parseIntOr,
  parsePositiveIntOr,
  parseBounds,
  parseTrustProxy,
  isCronish,
  DEFAULT_TRUSTED_PROXY_CIDRS,
} from "./env/parsers.js"

const DEV_SESSION_SIGNING_KEY = "dev-insecure-session-signing-key-do-not-use-in-prod"
const DEV_ANON_TOKEN_SIGNING_KEY = "dev-insecure-anon-token-signing-key-do-not-use-in-prod"

export const REVIEWER_OTP_CODE_MIN_LENGTH = 20

export const SIGNING_KEY_MIN_LENGTH = 32

const TLS_SSLMODES = new Set(["require", "verify-ca", "verify-full"])

const TILES_MIN_ZOOM_DEFAULT = 1
const TILES_MAX_ZOOM_DEFAULT = 19
const TILES_BOUNDS_DEFAULT: [number, number, number, number] = [-125, 24, -66, 50]

const NodeEnvSchema = z.enum(["development", "test", "production"]).default("development")
const PortSchema = z.coerce.number().int().positive().max(65535)

type FakeFlags = Pick<
  Env,
  | "USE_FAKE_STORAGE"
  | "USE_FAKE_MAILER"
  | "USE_FAKE_PUSH"
  | "USE_FAKE_ABUSE_NSFW"
  | "USE_FAKE_CHAT"
  | "USE_FAKE_JOBS"
  | "USE_FAKE_USER_CHANNEL"
  | "USE_FAKE_GEOCODER"
  | "USE_FAKE_SMS"
  | "USE_REAL_NSFW"
>

function deriveFakeFlags(source: NodeJS.ProcessEnv, isProd: boolean): FakeFlags {
  return {
    USE_FAKE_STORAGE: parseBool(source.USE_FAKE_STORAGE, !isProd),
    USE_FAKE_MAILER: parseBool(source.USE_FAKE_MAILER, !isProd),
    USE_FAKE_PUSH: parseBool(source.USE_FAKE_PUSH, !isProd),
    USE_FAKE_ABUSE_NSFW: parseBool(source.USE_FAKE_ABUSE_NSFW, !isProd),
    USE_FAKE_CHAT: parseBool(source.USE_FAKE_CHAT, !isProd),
    USE_FAKE_JOBS: parseBool(source.USE_FAKE_JOBS, !isProd),
    USE_FAKE_USER_CHANNEL: parseBool(source.USE_FAKE_USER_CHANNEL, !isProd),
    USE_FAKE_GEOCODER: parseBool(source.USE_FAKE_GEOCODER, !isProd),
    USE_FAKE_SMS: parseBool(source.USE_FAKE_SMS, !isProd),
    USE_REAL_NSFW: parseBool(source.USE_REAL_NSFW, false),
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = []

  const nodeEnvParsed = NodeEnvSchema.safeParse(source.NODE_ENV)
  if (!nodeEnvParsed.success) {
    errors.push("NODE_ENV: must be one of development | test | production")
  }
  const nodeEnv = nodeEnvParsed.success ? nodeEnvParsed.data : "development"
  const isProd = nodeEnv === "production"

  const fakeFlags = deriveFakeFlags(source, isProd)

  if (isProd) {
    for (const flag of [
      "USE_FAKE_ABUSE_NSFW",
      "USE_FAKE_CHAT",
      "USE_FAKE_MAILER",
      "USE_FAKE_STORAGE",
    ] as const) {
      if (fakeFlags[flag]) {
        errors.push(
          `${flag}: must not be true in production (it disables a real security or durability control)`,
        )
      }
    }
  }

  function reqStr(key: string, opts: { gatedOff?: boolean } = {}): string {
    const raw = source[key]
    const value = typeof raw === "string" ? raw.trim() : ""
    const required = isProd && !(opts.gatedOff ?? false)
    if (value.length === 0 && required) {
      errors.push(`${key}: required [BOOT] variable is missing`)
    }
    return value
  }

  function reqPort(key: string, fallback: number): number {
    const raw = source[key]
    if (raw === undefined || raw === "") return fallback
    const parsed = PortSchema.safeParse(raw)
    if (!parsed.success) {
      errors.push(`${key}: must be an integer between 1 and 65535`)
      return fallback
    }
    return parsed.data
  }

  function reqCron(key: string, fallback: string): string {
    const value = (source[key] ?? "").trim() || fallback
    if (!isCronish(value)) {
      errors.push(`${key}: must be a 5- or 6-field cron expression`)
    }
    return value
  }

  const PORT = reqPort("PORT", 8080)
  const PUBLIC_API_URL = reqStr("PUBLIC_API_URL")
  const WEB_ORIGINS = parseCsv(source.WEB_ORIGINS)
  if (isProd && WEB_ORIGINS.length === 0) {
    errors.push("WEB_ORIGINS: required [BOOT] CORS allowlist (comma list) is missing")
  }
  const DATABASE_URL = reqStr("DATABASE_URL")
  const REDIS_URL = reqStr("REDIS_URL")

  let SESSION_SIGNING_KEY = (source.SESSION_SIGNING_KEY ?? "").trim()
  let ANON_TOKEN_SIGNING_KEY = (source.ANON_TOKEN_SIGNING_KEY ?? "").trim()
  if (isProd) {
    if (SESSION_SIGNING_KEY.length === 0) {
      errors.push("SESSION_SIGNING_KEY: required [BOOT] variable is missing")
    } else if (SESSION_SIGNING_KEY === DEV_SESSION_SIGNING_KEY) {
      errors.push("SESSION_SIGNING_KEY: must not be the insecure dev default in production")
    } else if (SESSION_SIGNING_KEY.length < SIGNING_KEY_MIN_LENGTH) {
      errors.push(
        `SESSION_SIGNING_KEY: must be at least ${SIGNING_KEY_MIN_LENGTH} characters in production ` +
          "(it is the cookie-signing and session-bound CSRF HMAC secret)",
      )
    }
    if (ANON_TOKEN_SIGNING_KEY.length === 0) {
      errors.push("ANON_TOKEN_SIGNING_KEY: required [BOOT] variable is missing")
    } else if (ANON_TOKEN_SIGNING_KEY === DEV_ANON_TOKEN_SIGNING_KEY) {
      errors.push("ANON_TOKEN_SIGNING_KEY: must not be the insecure dev default in production")
    } else if (ANON_TOKEN_SIGNING_KEY.length < SIGNING_KEY_MIN_LENGTH) {
      errors.push(
        `ANON_TOKEN_SIGNING_KEY: must be at least ${SIGNING_KEY_MIN_LENGTH} characters in production ` +
          "(it signs the anon-report claim tokens)",
      )
    }
    if (
      SESSION_SIGNING_KEY.length > 0 &&
      SESSION_SIGNING_KEY === ANON_TOKEN_SIGNING_KEY
    ) {
      errors.push(
        "SESSION_SIGNING_KEY / ANON_TOKEN_SIGNING_KEY: must be DIFFERENT values in production " +
          "(one shared secret lets a session-cookie oracle and an anon-token oracle attack the same key)",
      )
    }
  } else {
    if (SESSION_SIGNING_KEY.length === 0) SESSION_SIGNING_KEY = DEV_SESSION_SIGNING_KEY
    if (ANON_TOKEN_SIGNING_KEY.length === 0) ANON_TOKEN_SIGNING_KEY = DEV_ANON_TOKEN_SIGNING_KEY
  }

  if (
    isProd &&
    DATABASE_URL.length > 0 &&
    !TLS_SSLMODES.has(sslModeOf(DATABASE_URL) ?? "") &&
    !isNonRoutableDbHost(DATABASE_URL)
  ) {
    errors.push(
      "DATABASE_URL: production requires TLS — append ?sslmode=require (or verify-ca / verify-full); " +
        "postgres.js otherwise connects in cleartext",
    )
  }

  const TRUST_PROXY = parseTrustProxy(source.TRUST_PROXY)
  if (isProd && TRUST_PROXY === true) {
    errors.push(
      "TRUST_PROXY: must not be `true` in production (it trusts any client-supplied X-Forwarded-For). " +
        "Use a hop count (e.g. 1) or an explicit CIDR list; leave unset for the safe internal-ranges default",
    )
  }

  const LOCAL_STORAGE_DIR = (source.LOCAL_STORAGE_DIR ?? "").trim()
  const usesLocalStorage = LOCAL_STORAGE_DIR.length > 0
  if (isProd && usesLocalStorage) {
    errors.push(
      "LOCAL_STORAGE_DIR: the local-disk storage driver is DEVELOPMENT ONLY and must not be set in " +
        "production; configure R2 (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)",
    )
  }
  if (usesLocalStorage && PUBLIC_API_URL.length === 0) {
    errors.push(
      "PUBLIC_API_URL: required whenever LOCAL_STORAGE_DIR is set — the local-disk driver's presigned " +
        "URLs must be absolute and reachable from the browser and the media worker",
    )
  }
  const LOCAL_STORAGE_SIGNING_KEY = (source.LOCAL_STORAGE_SIGNING_KEY ?? "").trim()

  if (!fakeFlags.USE_FAKE_GEOCODER && DATABASE_URL.length === 0) {
    errors.push(
      "DATABASE_URL: required whenever USE_FAKE_GEOCODER is false — the real geocoder resolves its " +
        "\"City, ST\" label from the jurisdictions PostGIS table, so there is nothing to query without a database",
    )
  }

  const R2_ACCOUNT_ID = reqStr("R2_ACCOUNT_ID", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_ACCESS_KEY_ID = reqStr("R2_ACCESS_KEY_ID", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_SECRET_ACCESS_KEY = reqStr("R2_SECRET_ACCESS_KEY", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_BUCKET = reqStr("R2_BUCKET", { gatedOff: fakeFlags.USE_FAKE_STORAGE })

  const R2_INBOUND_BUCKET = (source.R2_INBOUND_BUCKET ?? "").trim()
  const R2_PUBLIC_BASE = (source.R2_PUBLIC_BASE ?? "").trim()
  if (!fakeFlags.USE_FAKE_STORAGE && !usesLocalStorage) {
    if (R2_PUBLIC_BASE.length > 0 && R2_INBOUND_BUCKET.length === 0) {
      errors.push(
        "R2_INBOUND_BUCKET: required [BOOT] whenever R2_PUBLIC_BASE is set — a shared bucket would " +
          "publish raw inbound email and its attachments on the public CDN",
      )
    }
    if (R2_INBOUND_BUCKET.length > 0 && R2_INBOUND_BUCKET === R2_BUCKET) {
      errors.push(
        "R2_INBOUND_BUCKET: must be a DIFFERENT bucket from R2_BUCKET (inbound mail must never live in " +
          "the media bucket)",
      )
    }
  }

  const OCI_EMAIL_SMTP_HOST = reqStr("OCI_EMAIL_SMTP_HOST", { gatedOff: fakeFlags.USE_FAKE_MAILER })
  const OCI_EMAIL_SMTP_PORT = reqPort("OCI_EMAIL_SMTP_PORT", 587)
  const OCI_EMAIL_SMTP_USER = reqStr("OCI_EMAIL_SMTP_USER", { gatedOff: fakeFlags.USE_FAKE_MAILER })
  const OCI_EMAIL_SMTP_PASS = reqStr("OCI_EMAIL_SMTP_PASS", { gatedOff: fakeFlags.USE_FAKE_MAILER })

  const SMS_GUEST_ENABLED = parseBool(source.SMS_GUEST_ENABLED, false)
  const SMS_DAILY_CAP = parsePositiveIntOr(source.SMS_DAILY_CAP, 50)
  const smsCredentialsUnused = fakeFlags.USE_FAKE_SMS || !SMS_GUEST_ENABLED
  const TWILIO_ACCOUNT_SID = reqStr("TWILIO_ACCOUNT_SID", { gatedOff: smsCredentialsUnused })
  const TWILIO_AUTH_TOKEN = reqStr("TWILIO_AUTH_TOKEN", { gatedOff: smsCredentialsUnused })
  const TWILIO_SMS_FROM = reqStr("TWILIO_SMS_FROM", { gatedOff: smsCredentialsUnused })

  const OUTREACH_DIGEST_CRON = reqCron("OUTREACH_DIGEST_CRON", "0 14 * * *")
  const GUEST_RETENTION_CRON = reqCron("GUEST_RETENTION_CRON", "15 4 * * *")
  const INBOUND_SWEEP_CRON = reqCron("INBOUND_SWEEP_CRON", "*/5 * * * *")

  const OAUTH_REQUIRE_NONCE = parseBool(source.OAUTH_REQUIRE_NONCE, false)
  const REVIEWER_OTP_BYPASS = parseBool(source.REVIEWER_OTP_BYPASS, false)
  const REVIEWER_OTP_BYPASS_ACK = parseBool(source.REVIEWER_OTP_BYPASS_ACK, false)
  const REVIEWER_OTP_CODE = (source.REVIEWER_OTP_CODE ?? "").trim()
  if (REVIEWER_OTP_CODE.length > 0 && REVIEWER_OTP_CODE.length < REVIEWER_OTP_CODE_MIN_LENGTH) {
    errors.push(
      `REVIEWER_OTP_CODE: must be at least ${REVIEWER_OTP_CODE_MIN_LENGTH} characters ` +
        "(it is a login secret, not a 6-digit OTP)",
    )
  }
  if (isProd && REVIEWER_OTP_BYPASS) {
    if (!REVIEWER_OTP_BYPASS_ACK) {
      errors.push(
        "REVIEWER_OTP_BYPASS: refusing to enable an authentication bypass in production without the " +
          "explicit second opt-in REVIEWER_OTP_BYPASS_ACK=true",
      )
    }
    if (REVIEWER_OTP_CODE.length === 0) {
      errors.push(
        "REVIEWER_OTP_CODE: required whenever REVIEWER_OTP_BYPASS is on in production (a per-review, " +
          `rotated secret of at least ${REVIEWER_OTP_CODE_MIN_LENGTH} characters)`,
      )
    }
  }

  if (errors.length > 0) {
    const header =
      `Invalid environment for civfix API (NODE_ENV=${nodeEnv}). ` +
      `${errors.length} problem(s) found:`
    throw new Error([header, ...errors.map((e) => `  - ${e}`)].join("\n"))
  }

  const env: Env = {
    NODE_ENV: nodeEnv,
    PORT,
    PUBLIC_API_URL,
    WEB_ORIGINS,
    DATABASE_URL,
    REDIS_URL,
    SESSION_SIGNING_KEY,
    ANON_TOKEN_SIGNING_KEY,
    TRUST_PROXY,

    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET,
    ...(usesLocalStorage ? { LOCAL_STORAGE_DIR } : {}),
    ...(usesLocalStorage && LOCAL_STORAGE_SIGNING_KEY.length > 0
      ? { LOCAL_STORAGE_SIGNING_KEY }
      : {}),
    TILES_MIN_ZOOM: parseIntOr(source.TILES_MIN_ZOOM, TILES_MIN_ZOOM_DEFAULT),
    TILES_MAX_ZOOM: parseIntOr(source.TILES_MAX_ZOOM, TILES_MAX_ZOOM_DEFAULT),
    TILES_BOUNDS: parseBounds(source.TILES_BOUNDS, TILES_BOUNDS_DEFAULT),

    CENSUS_GEOCODER_URL:
      (source.CENSUS_GEOCODER_URL ?? "").trim() ||
      "https://geocoding.geo.census.gov/geocoder/geographies/coordinates",
    CENSUS_GEOCODER_TIMEOUT_MS: parsePositiveIntOr(source.CENSUS_GEOCODER_TIMEOUT_MS, 2500),

    OCI_EMAIL_SMTP_HOST,
    OCI_EMAIL_SMTP_PORT,
    OCI_EMAIL_SMTP_USER,
    OCI_EMAIL_SMTP_PASS,
    MAIL_FROM_NOREPLY: (source.MAIL_FROM_NOREPLY ?? "").trim() || "no-reply@civfix.org",
    MAIL_FROM_OUTREACH: (source.MAIL_FROM_OUTREACH ?? "").trim() || "outreach@civfix.org",
    HOME_TURF_MAIL_FROM: (source.HOME_TURF_MAIL_FROM ?? "").trim() || "donotreply@civfix.org",
    HOME_TURF_NOTIFY_TO: (source.HOME_TURF_NOTIFY_TO ?? "").trim() || "roman@reachoutla.org",

    ADMIN_EMAILS: parseCsvLower(source.ADMIN_EMAILS),
    MAIL_REPLY_DOMAIN: (source.MAIL_REPLY_DOMAIN ?? "").trim() || "civfix.org",
    OUTREACH_THROTTLE_DAYS: parsePositiveIntOr(source.OUTREACH_THROTTLE_DAYS, 7),
    OUTREACH_DIGEST_CRON,
    INBOUND_SWEEP_CRON,
    GUEST_RETENTION_CRON,

    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_SMS_FROM,
    SMS_GUEST_ENABLED,
    SMS_DAILY_CAP,

    CF_ACCESS_SERVICE_TOKENS: parseCsv(source.CF_ACCESS_SERVICE_TOKENS),

    CF_TURNSTILE_HOSTNAMES: parseCsvLower(source.CF_TURNSTILE_HOSTNAMES),

    OAUTH_REQUIRE_NONCE,
    REVIEWER_OTP_BYPASS,
    REVIEWER_OTP_BYPASS_ACK,
    ...(REVIEWER_OTP_CODE.length > 0 ? { REVIEWER_OTP_CODE } : {}),

    ...optGroup(source, [
      "R2_INBOUND_BUCKET",
      "R2_PUBLIC_BASE",
      "TILES_RASTER_URL",
      "CF_ACCESS_TEAM_DOMAIN",
      "CF_ACCESS_AUD",
      "CF_TURNSTILE_SECRET",
      "CF_EMAIL_WEBHOOK_SECRET",
      "CF_API_TOKEN",
      "MAPBOX_TOKEN",
      "APPLE_OAUTH_CLIENT_ID",
      "APPLE_OAUTH_TEAM_ID",
      "APPLE_OAUTH_KEY_ID",
      "APPLE_OAUTH_PRIVATE_KEY",
      "APPLE_OAUTH_WEB_CLIENT_ID",
      "APPLE_OAUTH_IOS_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REDIRECT_URI",
      "GOOGLE_OAUTH_IOS_CLIENT_ID",
      "GOOGLE_OAUTH_ANDROID_CLIENT_ID",
      "APNS_KEY_ID",
      "APNS_TEAM_ID",
      "APNS_PRIVATE_KEY",
      "APNS_BUNDLE_ID",
      "FCM_SERVICE_ACCOUNT_JSON",
      "FCM_PROJECT_ID",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
      "EXPO_ACCESS_TOKEN",
      "GLITCHTIP_DSN",
      "GLITCHTIP_DATABASE_URL",
    ]),
    ...(source.APNS_PRODUCTION !== undefined && source.APNS_PRODUCTION !== ""
      ? { APNS_PRODUCTION: parseBool(source.APNS_PRODUCTION, false) }
      : {}),

    ...fakeFlags,
  }

  return env
}

export function sslModeOf(databaseUrl: string): string | undefined {
  try {
    const value = new URL(databaseUrl).searchParams.get("sslmode")
    return value === null ? undefined : value.trim().toLowerCase()
  } catch {
    return undefined
  }
}

export function isNonRoutableDbHost(databaseUrl: string): boolean {
  let host: string
  try {
    host = new URL(databaseUrl).hostname.trim().toLowerCase()
  } catch {
    return false
  }
  if (host.length === 0) return false
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "localhost" || host === "::1") return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return /^[a-z0-9_-]+$/.test(host)
}

function optGroup(
  source: NodeJS.ProcessEnv,
  keys: ReadonlyArray<keyof Env & string>,
): Partial<Env> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const raw = source[key]
    if (typeof raw === "string" && raw.trim().length > 0) {
      out[key] = raw.trim()
    }
  }
  return out as Partial<Env>
}

let cached: Env | undefined

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    if (prop === "toJSON") return () => "[civfix env: redacted]"
    if (cached === undefined) cached = loadEnv()
    return cached[prop as keyof Env]
  },
  has(_target, prop: string) {
    if (cached === undefined) cached = loadEnv()
    return prop in cached
  },
  ownKeys() {
    if (cached === undefined) cached = loadEnv()
    return Reflect.ownKeys(cached)
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    if (cached === undefined) cached = loadEnv()
    return Object.getOwnPropertyDescriptor(cached, prop)
  },
})

export function isProd(): boolean {
  return env.NODE_ENV === "production"
}

export function resetEnvCache(): void {
  cached = undefined
}
