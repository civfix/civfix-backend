/**
 * Environment loader for the civfix API — the single source of truth for backend configuration.
 *
 *   [BOOT] required for the server to boot in production.
 *   [OPT]  optional; a feature degrades or is disabled when it is absent.
 *
 * In production every [BOOT] var must be present or `loadEnv()` throws ONE aggregated error listing
 * every problem. Outside production the loader supplies insecure DEV DEFAULTS for the signing keys and
 * defaults all USE_FAKE_* flags ON, so the server boots fully offline with no credentials. A [BOOT] var
 * gated by a USE_FAKE_* flag is only required when that fake is OFF.
 */

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

/**
 * Insecure development defaults. NEVER used when NODE_ENV === "production": the production branch
 * requires the real values and throws if they are missing or equal to these.
 */
const DEV_SESSION_SIGNING_KEY = "dev-insecure-session-signing-key-do-not-use-in-prod"
const DEV_ANON_TOKEN_SIGNING_KEY = "dev-insecure-anon-token-signing-key-do-not-use-in-prod"

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
  | "USE_REAL_NSFW"
>

/** Fake flags default ON outside production so the server boots offline; OFF in production. */
function deriveFakeFlags(source: NodeJS.ProcessEnv, isProd: boolean): FakeFlags {
  return {
    USE_FAKE_STORAGE: parseBool(source.USE_FAKE_STORAGE, !isProd),
    USE_FAKE_MAILER: parseBool(source.USE_FAKE_MAILER, !isProd),
    USE_FAKE_PUSH: parseBool(source.USE_FAKE_PUSH, !isProd),
    USE_FAKE_ABUSE_NSFW: parseBool(source.USE_FAKE_ABUSE_NSFW, !isProd),
    USE_FAKE_CHAT: parseBool(source.USE_FAKE_CHAT, !isProd),
    USE_FAKE_JOBS: parseBool(source.USE_FAKE_JOBS, !isProd),
    USE_FAKE_USER_CHANNEL: parseBool(source.USE_FAKE_USER_CHANNEL, !isProd),
    // Real NSFW is opt-in and defaults OFF in ALL environments (prod publishes benign by default).
    USE_REAL_NSFW: parseBool(source.USE_REAL_NSFW, false),
  }
}

/**
 * Load and validate process environment into a typed `Env`. Throws an aggregated Error when any
 * required value is missing or invalid. Pass an explicit `source` (defaults to process.env) for tests.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = []

  const nodeEnvParsed = NodeEnvSchema.safeParse(source.NODE_ENV)
  if (!nodeEnvParsed.success) {
    errors.push("NODE_ENV: must be one of development | test | production")
  }
  const nodeEnv = nodeEnvParsed.success ? nodeEnvParsed.data : "development"
  const isProd = nodeEnv === "production"

  const fakeFlags = deriveFakeFlags(source, isProd)

  /**
   * Require a [BOOT] string. `gatedOff` true means a fake bypasses it (only required when the fake is
   * OFF). Returns the trimmed value, or "" when missing (callers do not read missing-and-recorded values
   * because an error is already queued).
   */
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

  // Signing keys: dev defaults outside prod, hard-required in prod (and the publicly-known dev default
  // is rejected so an attacker who knows it can't forge signed cookies).
  let SESSION_SIGNING_KEY = (source.SESSION_SIGNING_KEY ?? "").trim()
  let ANON_TOKEN_SIGNING_KEY = (source.ANON_TOKEN_SIGNING_KEY ?? "").trim()
  if (isProd) {
    if (SESSION_SIGNING_KEY.length === 0) {
      errors.push("SESSION_SIGNING_KEY: required [BOOT] variable is missing")
    } else if (SESSION_SIGNING_KEY === DEV_SESSION_SIGNING_KEY) {
      errors.push("SESSION_SIGNING_KEY: must not be the insecure dev default in production")
    }
    if (ANON_TOKEN_SIGNING_KEY.length === 0) {
      errors.push("ANON_TOKEN_SIGNING_KEY: required [BOOT] variable is missing")
    } else if (ANON_TOKEN_SIGNING_KEY === DEV_ANON_TOKEN_SIGNING_KEY) {
      errors.push("ANON_TOKEN_SIGNING_KEY: must not be the insecure dev default in production")
    }
  } else {
    if (SESSION_SIGNING_KEY.length === 0) SESSION_SIGNING_KEY = DEV_SESSION_SIGNING_KEY
    if (ANON_TOKEN_SIGNING_KEY.length === 0) ANON_TOKEN_SIGNING_KEY = DEV_ANON_TOKEN_SIGNING_KEY
  }

  const TRUST_PROXY = parseTrustProxy(source.TRUST_PROXY)

  const R2_ACCOUNT_ID = reqStr("R2_ACCOUNT_ID", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_ACCESS_KEY_ID = reqStr("R2_ACCESS_KEY_ID", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_SECRET_ACCESS_KEY = reqStr("R2_SECRET_ACCESS_KEY", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_BUCKET = reqStr("R2_BUCKET", { gatedOff: fakeFlags.USE_FAKE_STORAGE })

  const OCI_EMAIL_SMTP_HOST = reqStr("OCI_EMAIL_SMTP_HOST", { gatedOff: fakeFlags.USE_FAKE_MAILER })
  const OCI_EMAIL_SMTP_PORT = reqPort("OCI_EMAIL_SMTP_PORT", 587)
  const OCI_EMAIL_SMTP_USER = reqStr("OCI_EMAIL_SMTP_USER", { gatedOff: fakeFlags.USE_FAKE_MAILER })
  const OCI_EMAIL_SMTP_PASS = reqStr("OCI_EMAIL_SMTP_PASS", { gatedOff: fakeFlags.USE_FAKE_MAILER })

  const OUTREACH_DIGEST_CRON = reqCron("OUTREACH_DIGEST_CRON", "0 14 * * *")
  const INBOUND_SWEEP_CRON = reqCron("INBOUND_SWEEP_CRON", "*/5 * * * *")

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

    ADMIN_EMAILS: parseCsvLower(source.ADMIN_EMAILS),
    MAIL_REPLY_DOMAIN: (source.MAIL_REPLY_DOMAIN ?? "").trim() || "civfix.org",
    OUTREACH_THROTTLE_DAYS: parsePositiveIntOr(source.OUTREACH_THROTTLE_DAYS, 7),
    OUTREACH_DIGEST_CRON,
    INBOUND_SWEEP_CRON,

    CF_ACCESS_SERVICE_TOKENS: parseCsv(source.CF_ACCESS_SERVICE_TOKENS),

    // Reviewer-OTP bypass (App Review): ON by default; set REVIEWER_OTP_BYPASS=false to disable.
    REVIEWER_OTP_BYPASS: parseBool(source.REVIEWER_OTP_BYPASS, true),

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

/** Build a partial object of the present optional string keys, trimming values (blank/absent omitted). */
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

/**
 * Lazily-loaded, cached singleton env. Importing this module does NOT load env; the first property
 * access does, so tests can call `loadEnv(customSource)` without tripping process.env validation.
 *
 * SECURITY: `toJSON` returns a placeholder so an accidental JSON.stringify(env) / log.info({ env }) can
 * never spill the full decrypted secret set. Read individual fields, never serialize the whole env.
 */
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

/**
 * True when the validated env reports production. Use this (NOT a raw `process.env.NODE_ENV` read) as the
 * single source of truth for prod-only behavior, so it tracks the same value the [BOOT] gating uses.
 */
export function isProd(): boolean {
  return env.NODE_ENV === "production"
}

/** Test/HMR helper: drop the cached singleton so the next access reloads from process.env. */
export function resetEnvCache(): void {
  cached = undefined
}
