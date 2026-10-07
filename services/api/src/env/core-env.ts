import { DEFAULT_FEED_RANKING, FeedRankingConfigSchema } from "@civfix/shared"
import type { FeedRankingConfig } from "@civfix/shared"
import type { Env } from "./types.js"
import type { EnvReader } from "./reader.js"
import {
  assertOutboundSendPolicy,
  OUTBOUND_SEND_MIN_THROUGHPUT_BPS,
} from "../services/admin/outbound-send-policy.js"
import { CENSUS_DEFAULT_TIMEOUT_MS } from "../adapters/jurisdiction-lookup.census.js"
import { OCI_MAILER_DEFAULT_TIMEOUT_MS } from "../adapters/mailer-defaults.js"
import { DEFAULT_API_PORT } from "../lib/base-url.js"
import {
  parseBool,
  parseCsv,
  parseCsvLower,
  parseDrainMs,
  parseIntOr,
  parseStrictBool,
  parseTrustProxy,
  STRICT_BOOL_ACCEPTED_FORMS,
} from "./parsers.js"

const DEV_SESSION_SIGNING_KEY = "dev-insecure-session-signing-key-do-not-use-in-prod"
const DEV_ANON_TOKEN_SIGNING_KEY = "dev-insecure-anon-token-signing-key-do-not-use-in-prod"

const SIGNING_KEY_MIN_LENGTH = 32

const SMTP_PORT_DEFAULT = 587
const SMS_DAILY_CAP_DEFAULT = 50
const VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS_DEFAULT = 60
const OUTREACH_THROTTLE_DAYS_DEFAULT = 7

const OUTREACH_DIGEST_CRON_DEFAULT = "0 14 * * *"
const GUEST_RETENTION_CRON_DEFAULT = "15 4 * * *"
const INBOUND_SWEEP_CRON_DEFAULT = "*/5 * * * *"

const CENSUS_GEOCODER_URL_DEFAULT =
  "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"

const MAIL_FROM_NOREPLY_DEFAULT = "no-reply@civfix.org"
const MAIL_FROM_OUTREACH_DEFAULT = "outreach@civfix.org"
const HOME_TURF_MAIL_FROM_DEFAULT = "donotreply@civfix.org"
const MAIL_REPLY_DOMAIN_DEFAULT = "civfix.org"

const TLS_SSLMODES = new Set(["require", "verify-ca", "verify-full"])
const LOOPBACK_IPV4_PATTERN = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const SINGLE_LABEL_HOST_PATTERN = /^[a-z0-9_-]+$/

const TILES_MIN_ZOOM_DEFAULT = 1
const TILES_MAX_ZOOM_DEFAULT = 19

const MAX_LATITUDE = 90
const MAX_LONGITUDE = 180
const HOME_REGION_LAT_DEFAULT = 34.0522
const HOME_REGION_LNG_DEFAULT = -118.2437
const HOME_REGION_RADIUS_KM_DEFAULT = 40
const HOME_REGION_RADIUS_KM_MAX = 20_000

const APNS_CREDENTIAL_KEYS = [
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_PRIVATE_KEY",
  "APNS_BUNDLE_ID",
] as const

export type FakeFlags = Pick<
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

export function loadCoreEnv(
  r: EnvReader,
): Pick<Env, "PORT" | "PUBLIC_API_URL" | "WEB_ORIGINS" | "DATABASE_URL" | "REDIS_URL"> {
  const PORT = r.port("PORT", DEFAULT_API_PORT)
  const PUBLIC_API_URL = r.requiredString("PUBLIC_API_URL")
  const WEB_ORIGINS = parseCsv(r.source.WEB_ORIGINS)
  if (r.isProd && WEB_ORIGINS.length === 0) {
    r.errors.push("WEB_ORIGINS: required [BOOT] CORS allowlist (comma list) is missing")
  }
  const DATABASE_URL = r.requiredString("DATABASE_URL")
  const REDIS_URL = r.requiredString("REDIS_URL")
  return { PORT, PUBLIC_API_URL, WEB_ORIGINS, DATABASE_URL, REDIS_URL }
}

export function loadSigningKeys(
  r: EnvReader,
): Pick<Env, "SESSION_SIGNING_KEY" | "ANON_TOKEN_SIGNING_KEY"> {
  const session = r.trimmed("SESSION_SIGNING_KEY")
  const anon = r.trimmed("ANON_TOKEN_SIGNING_KEY")
  if (!r.isProd) {
    return {
      SESSION_SIGNING_KEY: session.length > 0 ? session : DEV_SESSION_SIGNING_KEY,
      ANON_TOKEN_SIGNING_KEY: anon.length > 0 ? anon : DEV_ANON_TOKEN_SIGNING_KEY,
    }
  }

  checkProductionSigningKey(r, {
    key: "SESSION_SIGNING_KEY",
    value: session,
    devDefault: DEV_SESSION_SIGNING_KEY,
    purpose: "it is the cookie-signing and session-bound CSRF HMAC secret",
  })
  checkProductionSigningKey(r, {
    key: "ANON_TOKEN_SIGNING_KEY",
    value: anon,
    devDefault: DEV_ANON_TOKEN_SIGNING_KEY,
    purpose: "it signs the anon-report claim tokens",
  })
  if (session.length > 0 && session === anon) {
    r.errors.push(
      "SESSION_SIGNING_KEY / ANON_TOKEN_SIGNING_KEY: must be DIFFERENT values in production " +
        "(one shared secret lets a session-cookie oracle and an anon-token oracle attack the same key)",
    )
  }
  return { SESSION_SIGNING_KEY: session, ANON_TOKEN_SIGNING_KEY: anon }
}

function checkProductionSigningKey(
  r: EnvReader,
  spec: { key: string; value: string; devDefault: string; purpose: string },
): void {
  if (spec.value.length === 0) {
    r.errors.push(`${spec.key}: required [BOOT] variable is missing`)
  } else if (spec.value === spec.devDefault) {
    r.errors.push(`${spec.key}: must not be the insecure dev default in production`)
  } else if (spec.value.length < SIGNING_KEY_MIN_LENGTH) {
    r.errors.push(
      `${spec.key}: must be at least ${SIGNING_KEY_MIN_LENGTH} characters in production ` +
        `(${spec.purpose})`,
    )
  }
}

export function checkDatabaseTls(r: EnvReader, databaseUrl: string): void {
  if (
    r.isProd &&
    databaseUrl.length > 0 &&
    !TLS_SSLMODES.has(sslModeOf(databaseUrl) ?? "") &&
    !isNonRoutableDbHost(databaseUrl)
  ) {
    r.errors.push(
      "DATABASE_URL: production requires TLS; append ?sslmode=require (or verify-ca / verify-full); " +
        "postgres.js otherwise connects in cleartext",
    )
  }
}

function sslModeOf(databaseUrl: string): string | undefined {
  try {
    const value = new URL(databaseUrl).searchParams.get("sslmode")
    return value === null ? undefined : value.trim().toLowerCase()
  } catch {
    return undefined
  }
}

function isNonRoutableDbHost(databaseUrl: string): boolean {
  let host: string
  try {
    host = new URL(databaseUrl).hostname.trim().toLowerCase()
  } catch {
    return false
  }
  if (host.length === 0) return false
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "localhost" || host === "::1") return true
  if (LOOPBACK_IPV4_PATTERN.test(host)) return true
  return SINGLE_LABEL_HOST_PATTERN.test(host)
}

export function loadTrustProxy(r: EnvReader): Env["TRUST_PROXY"] {
  const TRUST_PROXY = parseTrustProxy(r.source.TRUST_PROXY)
  if (r.isProd && TRUST_PROXY === true) {
    r.errors.push(
      "TRUST_PROXY: must not be `true` in production (it trusts any client-supplied X-Forwarded-For). " +
        "Use an explicit CIDR list; leave unset for the safe internal-ranges default",
    )
  }
  return TRUST_PROXY
}

export function loadHomeRegion(
  r: EnvReader,
): Pick<Env, "HOME_REGION_LAT" | "HOME_REGION_LNG" | "HOME_REGION_RADIUS_KM"> {
  return {
    HOME_REGION_LAT: r.boundedNumber("HOME_REGION_LAT", HOME_REGION_LAT_DEFAULT, {
      min: -MAX_LATITUDE,
      max: MAX_LATITUDE,
    }),
    HOME_REGION_LNG: r.boundedNumber("HOME_REGION_LNG", HOME_REGION_LNG_DEFAULT, {
      min: -MAX_LONGITUDE,
      max: MAX_LONGITUDE,
    }),
    HOME_REGION_RADIUS_KM: r.boundedNumber("HOME_REGION_RADIUS_KM", HOME_REGION_RADIUS_KM_DEFAULT, {
      min: 0,
      max: HOME_REGION_RADIUS_KM_MAX,
      exclusiveMin: true,
    }),
  }
}

export function loadFeedRanking(r: EnvReader, key: string): FeedRankingConfig {
  const raw = r.trimmed(key)
  if (raw.length === 0) return DEFAULT_FEED_RANKING
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    r.errors.push(`${key}: must be a JSON object of feed-ranking overrides`)
    return DEFAULT_FEED_RANKING
  }
  const parsed = FeedRankingConfigSchema.safeParse(decoded)
  if (parsed.success) return parsed.data
  for (const issue of parsed.error.issues) {
    const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : ""
    r.errors.push(`${key}${path}: ${issue.message}`)
  }
  return DEFAULT_FEED_RANKING
}

export interface LocalStorageSection {
  usesLocalStorage: boolean
  fields: Pick<Env, "LOCAL_STORAGE_DIR" | "LOCAL_STORAGE_SIGNING_KEY">
}

export function loadLocalStorage(r: EnvReader, publicApiUrl: string): LocalStorageSection {
  const LOCAL_STORAGE_DIR = r.trimmed("LOCAL_STORAGE_DIR")
  const usesLocalStorage = LOCAL_STORAGE_DIR.length > 0
  if (r.isProd && usesLocalStorage) {
    r.errors.push(
      "LOCAL_STORAGE_DIR: the local-disk storage driver is DEVELOPMENT ONLY and must not be set in " +
        "production; configure R2 (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)",
    )
  }
  if (usesLocalStorage && publicApiUrl.length === 0) {
    r.errors.push(
      "PUBLIC_API_URL: required whenever LOCAL_STORAGE_DIR is set: the local-disk driver's presigned " +
        "URLs must be absolute and reachable from the browser and the media worker",
    )
  }
  const LOCAL_STORAGE_SIGNING_KEY = r.trimmed("LOCAL_STORAGE_SIGNING_KEY")
  if (!usesLocalStorage) return { usesLocalStorage, fields: {} }
  return {
    usesLocalStorage,
    fields: {
      LOCAL_STORAGE_DIR,
      ...(LOCAL_STORAGE_SIGNING_KEY.length > 0 ? { LOCAL_STORAGE_SIGNING_KEY } : {}),
    },
  }
}

export function checkGeocoderDatabase(
  r: EnvReader,
  fakeFlags: FakeFlags,
  databaseUrl: string,
): void {
  if (!fakeFlags.USE_FAKE_GEOCODER && databaseUrl.length === 0) {
    r.errors.push(
      "DATABASE_URL: required whenever USE_FAKE_GEOCODER is false: the real geocoder resolves its " +
        '"City, ST" label from the jurisdictions PostGIS table, so there is nothing to query without a database',
    )
  }
}

export function loadR2Env(
  r: EnvReader,
  useFakeStorage: boolean,
  usesLocalStorage: boolean,
): Pick<Env, "R2_ACCOUNT_ID" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY" | "R2_BUCKET"> {
  const gated = { gatedOff: useFakeStorage }
  const R2_ACCOUNT_ID = r.requiredString("R2_ACCOUNT_ID", gated)
  const R2_ACCESS_KEY_ID = r.requiredString("R2_ACCESS_KEY_ID", gated)
  const R2_SECRET_ACCESS_KEY = r.requiredString("R2_SECRET_ACCESS_KEY", gated)
  const R2_BUCKET = r.requiredString("R2_BUCKET", gated)

  if (!useFakeStorage && !usesLocalStorage) {
    checkInboundBucket(r, R2_BUCKET)
  }
  return { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET }
}

function checkInboundBucket(r: EnvReader, mediaBucket: string): void {
  const inboundBucket = r.trimmed("R2_INBOUND_BUCKET")
  const publicBase = r.trimmed("R2_PUBLIC_BASE")
  if (publicBase.length > 0 && inboundBucket.length === 0) {
    r.errors.push(
      "R2_INBOUND_BUCKET: required [BOOT] whenever R2_PUBLIC_BASE is set: a shared bucket would " +
        "publish raw inbound email and its attachments on the public CDN",
    )
  }
  if (inboundBucket.length > 0 && inboundBucket === mediaBucket) {
    r.errors.push(
      "R2_INBOUND_BUCKET: must be a DIFFERENT bucket from R2_BUCKET (inbound mail must never live in " +
        "the media bucket)",
    )
  }
}

export function loadMailEnv(
  r: EnvReader,
  useFakeMailer: boolean,
): Pick<
  Env,
  | "OCI_EMAIL_SMTP_HOST"
  | "OCI_EMAIL_SMTP_PORT"
  | "OCI_EMAIL_SMTP_USER"
  | "OCI_EMAIL_SMTP_PASS"
  | "OCI_EMAIL_SMTP_TIMEOUT_MS"
  | "OUTBOUND_SEND_MIN_THROUGHPUT_BPS"
  | "MAIL_FROM_NOREPLY"
  | "MAIL_FROM_OUTREACH"
  | "HOME_TURF_MAIL_FROM"
  | "HOME_TURF_NOTIFY_TO"
  | "MAIL_REPLY_DOMAIN"
> {
  const gated = { gatedOff: useFakeMailer }
  const OCI_EMAIL_SMTP_HOST = r.requiredString("OCI_EMAIL_SMTP_HOST", gated)
  const OCI_EMAIL_SMTP_PORT = r.port("OCI_EMAIL_SMTP_PORT", SMTP_PORT_DEFAULT)
  const OCI_EMAIL_SMTP_USER = r.requiredString("OCI_EMAIL_SMTP_USER", gated)
  const OCI_EMAIL_SMTP_PASS = r.requiredString("OCI_EMAIL_SMTP_PASS", gated)
  const OCI_EMAIL_SMTP_TIMEOUT_MS = r.positiveInt(
    "OCI_EMAIL_SMTP_TIMEOUT_MS",
    OCI_MAILER_DEFAULT_TIMEOUT_MS,
  )
  const minThroughput = r.positiveInt(
    "OUTBOUND_SEND_MIN_THROUGHPUT_BPS",
    OUTBOUND_SEND_MIN_THROUGHPUT_BPS,
  )
  r.errors.push(
    ...assertOutboundSendPolicy({
      smtpTimeoutMs: OCI_EMAIL_SMTP_TIMEOUT_MS,
      minThroughputBytesPerSec: minThroughput,
    }),
  )

  return {
    OCI_EMAIL_SMTP_HOST,
    OCI_EMAIL_SMTP_PORT,
    OCI_EMAIL_SMTP_USER,
    OCI_EMAIL_SMTP_PASS,
    OCI_EMAIL_SMTP_TIMEOUT_MS,
    OUTBOUND_SEND_MIN_THROUGHPUT_BPS: minThroughput,
    MAIL_FROM_NOREPLY: r.trimmed("MAIL_FROM_NOREPLY") || MAIL_FROM_NOREPLY_DEFAULT,
    MAIL_FROM_OUTREACH: r.trimmed("MAIL_FROM_OUTREACH") || MAIL_FROM_OUTREACH_DEFAULT,
    HOME_TURF_MAIL_FROM: r.trimmed("HOME_TURF_MAIL_FROM") || HOME_TURF_MAIL_FROM_DEFAULT,
    HOME_TURF_NOTIFY_TO: r.trimmed("HOME_TURF_NOTIFY_TO"),
    MAIL_REPLY_DOMAIN: r.trimmed("MAIL_REPLY_DOMAIN") || MAIL_REPLY_DOMAIN_DEFAULT,
  }
}

export function loadSmsEnv(
  r: EnvReader,
  useFakeSms: boolean,
): Pick<
  Env,
  | "SMS_GUEST_ENABLED"
  | "SMS_DAILY_CAP"
  | "TWILIO_ACCOUNT_SID"
  | "TWILIO_AUTH_TOKEN"
  | "TWILIO_SMS_FROM"
> {
  const SMS_GUEST_ENABLED = parseBool(r.source.SMS_GUEST_ENABLED, false)
  const SMS_DAILY_CAP = r.positiveInt("SMS_DAILY_CAP", SMS_DAILY_CAP_DEFAULT)
  const gated = { gatedOff: useFakeSms || !SMS_GUEST_ENABLED }
  return {
    SMS_GUEST_ENABLED,
    SMS_DAILY_CAP,
    TWILIO_ACCOUNT_SID: r.requiredString("TWILIO_ACCOUNT_SID", gated),
    TWILIO_AUTH_TOKEN: r.requiredString("TWILIO_AUTH_TOKEN", gated),
    TWILIO_SMS_FROM: r.requiredString("TWILIO_SMS_FROM", gated),
  }
}

export function loadScheduleEnv(
  r: EnvReader,
): Pick<
  Env,
  | "OUTREACH_DIGEST_CRON"
  | "OUTREACH_DIGEST_ENABLED"
  | "REPORT_AUTOFORWARD_ENABLED"
  | "GUEST_RETENTION_CRON"
  | "INBOUND_SWEEP_CRON"
> {
  return {
    OUTREACH_DIGEST_CRON: r.cron("OUTREACH_DIGEST_CRON", OUTREACH_DIGEST_CRON_DEFAULT),
    OUTREACH_DIGEST_ENABLED: parseBool(r.source.OUTREACH_DIGEST_ENABLED, false),
    REPORT_AUTOFORWARD_ENABLED: parseBool(r.source.REPORT_AUTOFORWARD_ENABLED, false),
    GUEST_RETENTION_CRON: r.cron("GUEST_RETENTION_CRON", GUEST_RETENTION_CRON_DEFAULT),
    INBOUND_SWEEP_CRON: r.cron("INBOUND_SWEEP_CRON", INBOUND_SWEEP_CRON_DEFAULT),
  }
}

export function loadTuningEnv(
  r: EnvReader,
): Pick<
  Env,
  | "SHUTDOWN_DRAIN_MS"
  | "TILES_MIN_ZOOM"
  | "TILES_MAX_ZOOM"
  | "CENSUS_GEOCODER_URL"
  | "CENSUS_GEOCODER_TIMEOUT_MS"
  | "VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS"
  | "OUTREACH_THROTTLE_DAYS"
> {
  return {
    SHUTDOWN_DRAIN_MS: parseDrainMs(r.source.SHUTDOWN_DRAIN_MS),
    TILES_MIN_ZOOM: parseIntOr(r.source.TILES_MIN_ZOOM, TILES_MIN_ZOOM_DEFAULT, {
      key: "TILES_MIN_ZOOM",
      errors: r.errors,
    }),
    TILES_MAX_ZOOM: parseIntOr(r.source.TILES_MAX_ZOOM, TILES_MAX_ZOOM_DEFAULT, {
      key: "TILES_MAX_ZOOM",
      errors: r.errors,
    }),
    CENSUS_GEOCODER_URL: r.trimmed("CENSUS_GEOCODER_URL") || CENSUS_GEOCODER_URL_DEFAULT,
    CENSUS_GEOCODER_TIMEOUT_MS: r.positiveInt(
      "CENSUS_GEOCODER_TIMEOUT_MS",
      CENSUS_DEFAULT_TIMEOUT_MS,
    ),
    VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS: r.positiveInt(
      "VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS",
      VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS_DEFAULT,
    ),
    OUTREACH_THROTTLE_DAYS: r.positiveInt("OUTREACH_THROTTLE_DAYS", OUTREACH_THROTTLE_DAYS_DEFAULT),
  }
}

export function loadApnsProduction(r: EnvReader): Pick<Env, "APNS_PRODUCTION"> {
  const raw = r.trimmed("APNS_PRODUCTION")
  if (raw.length === 0) {
    const apnsConfigured = APNS_CREDENTIAL_KEYS.every((key) => r.trimmed(key).length > 0)
    if (r.isProd && apnsConfigured) {
      r.errors.push(
        "APNS_PRODUCTION: required [BOOT] once APNs credentials are set (true for App Store and " +
          "TestFlight builds; a gateway mismatch makes APNs reject every token as BadDeviceToken)",
      )
    }
    return {}
  }
  const APNS_PRODUCTION = parseStrictBool(raw)
  if (APNS_PRODUCTION === undefined) {
    r.errors.push(`APNS_PRODUCTION: must be one of ${STRICT_BOOL_ACCEPTED_FORMS}`)
    return {}
  }
  return { APNS_PRODUCTION }
}

export function loadAccessLists(
  r: EnvReader,
): Pick<Env, "ADMIN_EMAILS" | "CF_ACCESS_SERVICE_TOKENS" | "CF_TURNSTILE_HOSTNAMES"> {
  return {
    ADMIN_EMAILS: parseCsvLower(r.source.ADMIN_EMAILS),
    CF_ACCESS_SERVICE_TOKENS: parseCsv(r.source.CF_ACCESS_SERVICE_TOKENS),
    CF_TURNSTILE_HOSTNAMES: parseCsvLower(r.source.CF_TURNSTILE_HOSTNAMES),
  }
}
