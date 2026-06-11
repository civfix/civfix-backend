/**
 * Environment loader for the civfix API.
 *
 * This file is the single source of truth for backend configuration. Later steps READ from the
 * exported `Env` type and the `env` singleton; they do not redefine env vars here.
 *
 * Conventions used in the comments below:
 *   [BOOT] required for the server to boot in production.
 *   [OPT]  optional; a feature degrades or is disabled when it is absent.
 *
 * Behavior:
 *   - In production (NODE_ENV === "production"), every [BOOT] var must be present or `loadEnv()`
 *     throws a single aggregated error listing every missing var.
 *   - Outside production, the loader provides insecure DEV DEFAULTS for the signing keys and
 *     defaults all USE_FAKE_* flags to ON, so the server boots fully offline with no credentials.
 *   - A [BOOT] var that is gated by a USE_FAKE_* flag is only required when that fake is OFF.
 */

import { z } from "zod"
import { parseTrustProxy, type TrustProxyValue } from "./plugins/trust-proxy.js"

/** Parse "1"/"true"/"yes"/"on" (case-insensitive) as true; everything else false. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

/** Split a comma list into a trimmed, non-empty array. */
function parseCsv(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Split a comma list into a normalized (trimmed, lowercased) de-duplicated array. Used for
 * ADMIN_EMAILS so the allowlist compare is case-insensitive and free of duplicates regardless of how
 * the operator typed the .env value.
 */
function parseCsvLower(raw: string | undefined): string[] {
  const seen = new Set<string>()
  for (const item of parseCsv(raw)) {
    seen.add(item.toLowerCase())
  }
  return [...seen]
}

/**
 * Parse a non-negative integer from an env string, falling back when blank/invalid. Used for the
 * optional tile zoom levels; an unparseable value silently uses the default rather than blocking boot
 * (these are [OPT], not [BOOT]).
 */
function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse a "west,south,east,north" bounds string into a 4-tuple. Falls back to `fallback` unless the
 * input is exactly four finite numbers. [OPT], so a malformed value degrades to the default.
 */
function parseBounds(
  raw: string | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (raw === undefined || raw.trim() === "") return fallback
  const parts = raw.split(",").map((s) => Number.parseFloat(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return fallback
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

/**
 * Insecure development defaults. NEVER used when NODE_ENV === "production": the production branch
 * requires the real values and throws if they are missing.
 */
const DEV_SESSION_SIGNING_KEY = "dev-insecure-session-signing-key-do-not-use-in-prod"
const DEV_ANON_TOKEN_SIGNING_KEY = "dev-insecure-anon-token-signing-key-do-not-use-in-prod"

/**
 * Map basemap defaults. Used by GET /map/tileinfo when the optional TILES_* vars are unset so the route
 * never 500s on missing config (the raster URL itself defaults in map.routes). Bounds are the
 * continental-US-ish envelope [west, south, east, north]; zoom range covers a typical web slippy map.
 */
const TILES_MIN_ZOOM_DEFAULT = 1
const TILES_MAX_ZOOM_DEFAULT = 19
const TILES_BOUNDS_DEFAULT: [number, number, number, number] = [-125, 24, -66, 50]

const NodeEnvSchema = z.enum(["development", "test", "production"]).default("development")

/**
 * The validated, typed environment. Field comments carry the [BOOT]/[OPT] marker and the fake flag
 * (if any) that bypasses the requirement.
 */
export interface Env {
  // ----- core [BOOT] -----
  NODE_ENV: "development" | "test" | "production"
  PORT: number
  PUBLIC_API_URL: string
  /** CORS allowlist, parsed from a comma list in WEB_ORIGINS. */
  WEB_ORIGINS: string[]
  DATABASE_URL: string
  REDIS_URL: string
  SESSION_SIGNING_KEY: string
  ANON_TOKEN_SIGNING_KEY: string
  /**
   * Which upstream hops Fastify trusts for X-Forwarded-* (drives request.ip). Parsed from TRUST_PROXY:
   * a hop count, a CIDR/IP comma list, or true/false. Defaults to the internal loopback+private ranges
   * so a client-supplied X-Forwarded-For from the public internet is never honored. See plugins/trust-proxy.
   */
  TRUST_PROXY: TrustProxyValue

  // ----- storage (R2 - MEDIA ONLY: report photos/videos): [BOOT] unless USE_FAKE_STORAGE -----
  // R2 is NOT used for map tiles. The map uses the OpenStreetMap (CARTO Voyager) raster basemap loaded
  // directly by the clients (plan override; see GET /map/tileinfo and TILES_RASTER_URL below).
  R2_ACCOUNT_ID: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  /**
   * Optional DEDICATED R2 bucket for the inbound-mail buffer (the Cloudflare Email Worker writes raw
   * .eml to `inbound/pending/` here + extracted attachments to `inbound-emails/`). When unset, the
   * inbound pipeline shares R2_BUCKET. The Email Worker must bind THIS bucket. [OPT]
   */
  R2_INBOUND_BUCKET?: string
  R2_PUBLIC_BASE?: string

  // ----- map basemap (all [OPT]) -----
  // The map uses the OpenStreetMap (CARTO Voyager) RASTER basemap directly in the clients (plan
  // override; the platform does NOT host its own vector/pmtiles tiles). These vars only tune what
  // GET /map/tileinfo advertises; the clients hardcode the CARTO Voyager raster and need no config.
  /**
   * OPTIONAL override of the default OpenStreetMap/CARTO Voyager raster XYZ template that
   * GET /map/tileinfo advertises. Absent -> the built-in CARTO Voyager default (CARTO_VOYAGER_RASTER_URL
   * in map.routes). Set this only to point at a different raster basemap.
   */
  TILES_RASTER_URL?: string
  /** Min zoom advertised by tileinfo. Defaults to TILES_MIN_ZOOM_DEFAULT. */
  TILES_MIN_ZOOM: number
  /** Max zoom advertised by tileinfo. Defaults to TILES_MAX_ZOOM_DEFAULT. */
  TILES_MAX_ZOOM: number
  /** Map bounds [west, south, east, north] advertised by tileinfo. Defaults to TILES_BOUNDS_DEFAULT. */
  TILES_BOUNDS: [number, number, number, number]

  // ----- mailer (OCI SMTP): [BOOT] unless USE_FAKE_MAILER -----
  OCI_EMAIL_SMTP_HOST: string
  OCI_EMAIL_SMTP_PORT: number
  OCI_EMAIL_SMTP_USER: string
  OCI_EMAIL_SMTP_PASS: string
  MAIL_FROM_NOREPLY: string
  MAIL_FROM_OUTREACH: string

  // ----- admin / operator (Phase 2) [OPT] -----
  /**
   * Allowlist of emails authorized to sign in to the admin/operator dashboard. Parsed from a
   * comma-separated ADMIN_EMAILS into a normalized (trimmed, lowercased, de-duplicated) array. NOT
   * required at boot: an EMPTY allowlist means NO ONE can log in to admin (admin login request returns
   * the generic { sent: true } without issuing, and verify rejects). Document + set this in deployment
   * to enable operator access.
   */
  ADMIN_EMAILS: string[]
  /**
   * Reply domain used to mint reply+{threadToken}@{MAIL_REPLY_DOMAIN} inbound addresses for the mail
   * threads. Defaults to "civfix.org".
   */
  MAIL_REPLY_DOMAIN: string
  /**
   * Outreach throttle window in days: at most one outreach per jurisdiction per this many days.
   * Defaults to 7.
   */
  OUTREACH_THROTTLE_DAYS: number
  /**
   * Cron expression for the daily outreach digest sweep (the "outreach.digest" pg-boss job). Defaults
   * to "0 14 * * *" (14:00 daily). Not validated as a cron string here; the scheduler owns that.
   */
  OUTREACH_DIGEST_CRON: string
  /**
   * Cron expression for the inbound-mail reconciliation sweep (the "inbound.sweep" pg-boss job that
   * LISTs R2 inbound/pending/ and processes anything the webhook missed). Defaults to every 5 minutes.
   */
  INBOUND_SWEEP_CRON: string

  // ----- admin auth: Cloudflare Access (Zero Trust) SSO (doc 16) [OPT] -----
  /**
   * The team Access domain. Used as BOTH the expected JWT `iss` and the JWKS base
   * (`${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`), e.g. https://civfix.cloudflareaccess.com.
   * The admin Access exchange route (`/admin/auth/access/exchange`) is enabled ONLY when both this and
   * CF_ACCESS_AUD are present; otherwise the POST exchange fails loudly (503) so a half-configured deploy
   * is obvious rather than silently accepting nothing. [OPT]
   */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** The Application Audience (AUD) tag of the path-scoped Access app on api.civfix.org/admin. [OPT] */
  CF_ACCESS_AUD?: string
  /**
   * Optional comma list of permitted Cloudflare Access service-token client IDs (the `common_name`
   * claim) for non-interactive admin access. Empty => no service tokens accepted. Service-token support
   * is NOT yet wired into the exchange (deferred, doc 16 §6.6); this is parsed and reserved only. [OPT]
   */
  CF_ACCESS_SERVICE_TOKENS: string[]

  // ----- feature / integration [OPT] -----
  CF_TURNSTILE_SECRET?: string
  CF_EMAIL_WEBHOOK_SECRET?: string
  CF_API_TOKEN?: string

  APPLE_OAUTH_CLIENT_ID?: string
  APPLE_OAUTH_TEAM_ID?: string
  APPLE_OAUTH_KEY_ID?: string
  APPLE_OAUTH_PRIVATE_KEY?: string

  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_REDIRECT_URI?: string
  /**
   * iOS / Android native OAuth client ids. Separate Google clients from the web one; the native sign-in
   * SDK can mint ID tokens whose `aud` is one of these, so the backend accepts them as valid audiences
   * alongside GOOGLE_OAUTH_CLIENT_ID. [OPT] — set per platform you ship native Google sign-in on.
   */
  GOOGLE_OAUTH_IOS_CLIENT_ID?: string
  GOOGLE_OAUTH_ANDROID_CLIENT_ID?: string

  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_PRIVATE_KEY?: string
  APNS_BUNDLE_ID?: string
  APNS_PRODUCTION?: boolean

  FCM_SERVICE_ACCOUNT_JSON?: string
  FCM_PROJECT_ID?: string

  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string

  GLITCHTIP_DSN?: string
  GLITCHTIP_DATABASE_URL?: string

  // ----- fake-seam flags -----
  USE_FAKE_STORAGE: boolean
  USE_FAKE_MAILER: boolean
  USE_FAKE_PUSH: boolean
  USE_FAKE_ABUSE_NSFW: boolean
  USE_FAKE_CHAT: boolean
  USE_FAKE_JOBS: boolean
  /**
   * Use the in-memory FakeUserChannel instead of the Redis-backed RedisUserChannel for the per-user
   * realtime invalidate-signal channel. Defaults ON outside production (so dev/tests boot offline with
   * the fake) and OFF in production. The real impl needs only Redis, which is already required when chat
   * is real, so this adds no new [BOOT] var.
   */
  USE_FAKE_USER_CHANNEL: boolean

  /**
   * Opt-in real NSFW scoring. Default false EVEN in production: with the flag off (or on but with no
   * model wired) RealAbuseChecks.nsfwScore returns benign (0), so default-flag production publishes
   * media instead of holding all of it. Flipping this to true is a flag-gated follow-up that also
   * requires a real model behind the seam. The media-worker reads the same flag from its own env.
   */
  USE_REAL_NSFW: boolean
}

/** Optional-string schema that treats "" as undefined so blank env entries do not satisfy [BOOT]. */
const optStr = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined))

const PortSchema = z.coerce.number().int().positive().max(65535)

/**
 * Load and validate process environment into a typed `Env`. Throws an aggregated Error when any
 * required value is missing or invalid. Pass an explicit `source` (defaults to process.env) for
 * tests so they do not have to mutate the real environment.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = []

  const nodeEnvParsed = NodeEnvSchema.safeParse(source.NODE_ENV)
  if (!nodeEnvParsed.success) {
    errors.push("NODE_ENV: must be one of development | test | production")
  }
  const nodeEnv = nodeEnvParsed.success ? nodeEnvParsed.data : "development"
  const isProd = nodeEnv === "production"

  // Fake flags. Default ON outside production so the server boots offline; OFF in production.
  const useFakeStorage = parseBool(source.USE_FAKE_STORAGE, !isProd)
  const useFakeMailer = parseBool(source.USE_FAKE_MAILER, !isProd)
  const useFakePush = parseBool(source.USE_FAKE_PUSH, !isProd)
  const useFakeAbuseNsfw = parseBool(source.USE_FAKE_ABUSE_NSFW, !isProd)
  const useFakeChat = parseBool(source.USE_FAKE_CHAT, !isProd)
  const useFakeJobs = parseBool(source.USE_FAKE_JOBS, !isProd)
  const useFakeUserChannel = parseBool(source.USE_FAKE_USER_CHANNEL, !isProd)
  // Real NSFW is opt-in and defaults OFF in ALL environments (production publishes benign by default).
  const useRealNsfw = parseBool(source.USE_REAL_NSFW, false)

  /**
   * Require a [BOOT] string. `gatedOff` true means a fake bypasses it (so it is only required when
   * the fake is OFF). Returns the value, "" when missing (callers do not read missing-and-recorded
   * values because an error is already queued).
   */
  function reqStr(key: keyof NodeJS.ProcessEnv, opts: { gatedOff?: boolean } = {}): string {
    const gatedOff = opts.gatedOff ?? false
    const raw = source[key as string]
    const value = typeof raw === "string" ? raw.trim() : ""
    const required = isProd && !gatedOff
    if (value.length === 0 && required) {
      errors.push(`${String(key)}: required [BOOT] variable is missing`)
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

  // ----- core [BOOT] -----
  const PORT = reqPort("PORT", 8080)
  const PUBLIC_API_URL = reqStr("PUBLIC_API_URL")
  const WEB_ORIGINS = parseCsv(source.WEB_ORIGINS)
  if (isProd && WEB_ORIGINS.length === 0) {
    errors.push("WEB_ORIGINS: required [BOOT] CORS allowlist (comma list) is missing")
  }
  const DATABASE_URL = reqStr("DATABASE_URL")
  const REDIS_URL = reqStr("REDIS_URL")

  // Signing keys: dev defaults outside prod, hard-required in prod.
  let SESSION_SIGNING_KEY = (source.SESSION_SIGNING_KEY ?? "").trim()
  let ANON_TOKEN_SIGNING_KEY = (source.ANON_TOKEN_SIGNING_KEY ?? "").trim()
  if (isProd) {
    if (SESSION_SIGNING_KEY.length === 0) {
      errors.push("SESSION_SIGNING_KEY: required [BOOT] variable is missing")
    }
    if (ANON_TOKEN_SIGNING_KEY.length === 0) {
      errors.push("ANON_TOKEN_SIGNING_KEY: required [BOOT] variable is missing")
    }
  } else {
    if (SESSION_SIGNING_KEY.length === 0) SESSION_SIGNING_KEY = DEV_SESSION_SIGNING_KEY
    if (ANON_TOKEN_SIGNING_KEY.length === 0) ANON_TOKEN_SIGNING_KEY = DEV_ANON_TOKEN_SIGNING_KEY
  }

  // Trusted-proxy setting for Fastify's request.ip resolution. Defaults to internal-only ranges so a
  // forged X-Forwarded-For from a public client is never trusted (see plugins/trust-proxy).
  const TRUST_PROXY = parseTrustProxy(source.TRUST_PROXY)

  // ----- storage (R2) -----
  const R2_ACCOUNT_ID = reqStr("R2_ACCOUNT_ID", { gatedOff: useFakeStorage })
  const R2_ACCESS_KEY_ID = reqStr("R2_ACCESS_KEY_ID", { gatedOff: useFakeStorage })
  const R2_SECRET_ACCESS_KEY = reqStr("R2_SECRET_ACCESS_KEY", { gatedOff: useFakeStorage })
  const R2_BUCKET = reqStr("R2_BUCKET", { gatedOff: useFakeStorage })

  // ----- mailer (OCI SMTP) -----
  const OCI_EMAIL_SMTP_HOST = reqStr("OCI_EMAIL_SMTP_HOST", { gatedOff: useFakeMailer })
  const OCI_EMAIL_SMTP_PORT = reqPort("OCI_EMAIL_SMTP_PORT", 587)
  const OCI_EMAIL_SMTP_USER = reqStr("OCI_EMAIL_SMTP_USER", { gatedOff: useFakeMailer })
  const OCI_EMAIL_SMTP_PASS = reqStr("OCI_EMAIL_SMTP_PASS", { gatedOff: useFakeMailer })

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
    ...(optStr.parse(source.R2_INBOUND_BUCKET) !== undefined
      ? { R2_INBOUND_BUCKET: source.R2_INBOUND_BUCKET!.trim() }
      : {}),
    ...(optStr.parse(source.R2_PUBLIC_BASE) !== undefined
      ? { R2_PUBLIC_BASE: source.R2_PUBLIC_BASE!.trim() }
      : {}),
    ...(optStr.parse(source.TILES_RASTER_URL) !== undefined
      ? { TILES_RASTER_URL: source.TILES_RASTER_URL!.trim() }
      : {}),
    TILES_MIN_ZOOM: parseIntOr(source.TILES_MIN_ZOOM, TILES_MIN_ZOOM_DEFAULT),
    TILES_MAX_ZOOM: parseIntOr(source.TILES_MAX_ZOOM, TILES_MAX_ZOOM_DEFAULT),
    TILES_BOUNDS: parseBounds(source.TILES_BOUNDS, TILES_BOUNDS_DEFAULT),

    OCI_EMAIL_SMTP_HOST,
    OCI_EMAIL_SMTP_PORT,
    OCI_EMAIL_SMTP_USER,
    OCI_EMAIL_SMTP_PASS,
    MAIL_FROM_NOREPLY: (source.MAIL_FROM_NOREPLY ?? "").trim() || "no-reply@civfix.org",
    MAIL_FROM_OUTREACH: (source.MAIL_FROM_OUTREACH ?? "").trim() || "outreach@civfix.org",

    // Admin / operator (Phase 2). ADMIN_EMAILS is normalized (lowercased) + de-duped; empty is allowed
    // (no admin can log in). The rest carry sane defaults so the dashboard backend boots with no config.
    ADMIN_EMAILS: parseCsvLower(source.ADMIN_EMAILS),
    MAIL_REPLY_DOMAIN: (source.MAIL_REPLY_DOMAIN ?? "").trim() || "civfix.org",
    OUTREACH_THROTTLE_DAYS: parseIntOr(source.OUTREACH_THROTTLE_DAYS, 7),
    OUTREACH_DIGEST_CRON: (source.OUTREACH_DIGEST_CRON ?? "").trim() || "0 14 * * *",
    INBOUND_SWEEP_CRON: (source.INBOUND_SWEEP_CRON ?? "").trim() || "*/5 * * * *",

    // Admin auth: Cloudflare Access (doc 16). Team domain + AUD are optional strings (the exchange route
    // self-gates on both being present). Service-token client IDs are parsed but not yet consumed.
    CF_ACCESS_SERVICE_TOKENS: parseCsv(source.CF_ACCESS_SERVICE_TOKENS),

    ...optGroup(source, [
      "CF_ACCESS_TEAM_DOMAIN",
      "CF_ACCESS_AUD",
      "CF_TURNSTILE_SECRET",
      "CF_EMAIL_WEBHOOK_SECRET",
      "CF_API_TOKEN",
      "APPLE_OAUTH_CLIENT_ID",
      "APPLE_OAUTH_TEAM_ID",
      "APPLE_OAUTH_KEY_ID",
      "APPLE_OAUTH_PRIVATE_KEY",
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
      "GLITCHTIP_DSN",
      "GLITCHTIP_DATABASE_URL",
    ]),
    ...(source.APNS_PRODUCTION !== undefined && source.APNS_PRODUCTION !== ""
      ? { APNS_PRODUCTION: parseBool(source.APNS_PRODUCTION, false) }
      : {}),

    USE_FAKE_STORAGE: useFakeStorage,
    USE_FAKE_MAILER: useFakeMailer,
    USE_FAKE_PUSH: useFakePush,
    USE_FAKE_ABUSE_NSFW: useFakeAbuseNsfw,
    USE_FAKE_CHAT: useFakeChat,
    USE_FAKE_JOBS: useFakeJobs,
    USE_FAKE_USER_CHANNEL: useFakeUserChannel,
    USE_REAL_NSFW: useRealNsfw,
  }

  return env
}

/** Build a partial object of the present optional string keys, trimming values. */
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
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
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

/** Test/HMR helper: drop the cached singleton so the next access reloads from process.env. */
export function resetEnvCache(): void {
  cached = undefined
}
