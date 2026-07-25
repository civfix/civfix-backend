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

/**
 * Minimum length of REVIEWER_OTP_CODE. The reviewer bypass is an authentication bypass, so its code is
 * held to secret-material standards (not OTP standards): long enough that online guessing is hopeless even
 * with the route's rate limit removed. auth-services re-checks this before wiring the bypass at all.
 */
export const REVIEWER_OTP_CODE_MIN_LENGTH = 20

/** sslmode values that actually negotiate TLS. `prefer`/`allow`/`disable` are silent-plaintext modes. */
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

  // M15: Postgres must speak TLS in production. postgres.js defaults to ssl:false and will happily send
  // credentials + every row in cleartext, so the ONLY thing standing between us and a plaintext link is
  // the connection string. Require an sslmode that actually negotiates TLS (db/client.ts then turns that
  // sslmode into an explicit postgres() `ssl` option). Not enforced outside production: local dev and the
  // testcontainers integration suite connect to a loopback container with no TLS at all.
  //
  // EXEMPTION — a link that never leaves the host (see isNonRoutableDbHost). The deployed topology is a
  // compose stack where the API reaches Postgres as `postgres:5432` on a private bridge network, and the
  // image is the stock postgres:16-bookworm + PostGIS with NO server certificate: demanding
  // sslmode=require there does not encrypt the link, it just makes libpq refuse to connect, so the
  // assertion took the whole API down rather than protecting anything. Requiring TLS is still the right
  // rule for any hop that crosses a machine, which is exactly what this exemption does NOT cover.
  //
  // The residual risk is deliberate and bounded: cleartext on the docker bridge is readable only by
  // something that already has root on the box (or CAP_NET_ADMIN in the netns), at which point the
  // Postgres password in the same env file is already exposed. To close it properly, give the postgres
  // service a cert and set `ssl=on`, then put sslmode=require back in DATABASE_URL — this exemption is
  // written so that doing so needs no code change.
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
  // L20: `TRUST_PROXY=true` tells Fastify to believe ANY X-Forwarded-For, so every request.ip becomes
  // attacker-chosen and every per-IP control (rate limits, OTP caps, anon report caps, audit IPs) is
  // defeated by a header. There is no legitimate production shape for it: name the real proxy CIDRs, or
  // use a hop count. Rejected at boot rather than warned about, because the failure is silent.
  if (isProd && TRUST_PROXY === true) {
    errors.push(
      "TRUST_PROXY: must not be `true` in production (it trusts any client-supplied X-Forwarded-For). " +
        "Use a hop count (e.g. 1) or an explicit CIDR list; leave unset for the safe internal-ranges default",
    )
  }

  const R2_ACCOUNT_ID = reqStr("R2_ACCOUNT_ID", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_ACCESS_KEY_ID = reqStr("R2_ACCESS_KEY_ID", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_SECRET_ACCESS_KEY = reqStr("R2_SECRET_ACCESS_KEY", { gatedOff: fakeFlags.USE_FAKE_STORAGE })
  const R2_BUCKET = reqStr("R2_BUCKET", { gatedOff: fakeFlags.USE_FAKE_STORAGE })

  // H10: the inbound-mail buffer holds raw .eml bodies and every emailed attachment — citizen<->city
  // correspondence. R2_PUBLIC_BASE makes objects in the media bucket addressable on the CDN with NO
  // signature, so sharing one bucket between media and inbound mail publishes that correspondence at a
  // guessable URL. Two invariants, checked whenever storage is real:
  //   (1) R2_PUBLIC_BASE set  => R2_INBOUND_BUCKET is required (it is only [OPT] while nothing is public);
  //   (2) the two buckets must never be the same name.
  const R2_INBOUND_BUCKET = (source.R2_INBOUND_BUCKET ?? "").trim()
  const R2_PUBLIC_BASE = (source.R2_PUBLIC_BASE ?? "").trim()
  if (!fakeFlags.USE_FAKE_STORAGE) {
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

  const OUTREACH_DIGEST_CRON = reqCron("OUTREACH_DIGEST_CRON", "0 14 * * *")
  const INBOUND_SWEEP_CRON = reqCron("INBOUND_SWEEP_CRON", "*/5 * * * *")

  // C1: the reviewer-OTP bypass is a full authentication bypass (it mints a real 30-day session for a
  // fixed address with no mailbox proof). It therefore defaults OFF everywhere — the old default-ON
  // shipped a universal login backdoor to production — and production additionally demands a second,
  // deliberate opt-in plus a real secret. Same fail-closed idiom as the signing keys above: aggregate an
  // error and refuse to boot rather than degrade silently to "backdoor open".
  // H1 TRANSITION: mandatory server-issued sign-in nonces for the NATIVE Apple/Google flows. Defaults OFF
  // because no shipped mobile build sends a nonce yet and flipping it on would 422 every installed app's
  // sign-in until an EAS build cleared App Store review. A nonce that IS presented is always validated,
  // so updated clients are protected immediately; flip this to true once they are the store floor.
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

    CF_ACCESS_SERVICE_TOKENS: parseCsv(source.CF_ACCESS_SERVICE_TOKENS),

    // L16: hostnames a Turnstile token may have been minted on. Lowercased (hostnames are
    // case-insensitive and abuse-checks compares normalized), and EMPTY is a valid configuration — the
    // hostname assertion is then skipped with a one-time notice rather than refusing every token, so
    // adding the variable cannot brick an existing deployment's captcha.
    CF_TURNSTILE_HOSTNAMES: parseCsvLower(source.CF_TURNSTILE_HOSTNAMES),

    // Reviewer-OTP bypass (App Review): OFF by default in EVERY environment; see the C1 block above for
    // the production opt-in pair (REVIEWER_OTP_BYPASS_ACK + REVIEWER_OTP_CODE) it additionally requires.
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

/**
 * Extract the lowercased `sslmode` query parameter from a Postgres connection string, or undefined when
 * the URL is unparseable or carries no sslmode. Kept tolerant (never throws): a malformed DATABASE_URL is
 * already reported by the connection attempt, and here a missing/unreadable sslmode simply means "no TLS
 * was requested", which is exactly what the production check rejects.
 */
export function sslModeOf(databaseUrl: string): string | undefined {
  try {
    const value = new URL(databaseUrl).searchParams.get("sslmode")
    return value === null ? undefined : value.trim().toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Does this DATABASE_URL name a host the packets can never leave the machine to reach?
 *
 * Exists only to scope the production TLS assertion above. Two shapes qualify, both of which are
 * unroutable by construction rather than by convention:
 *
 *   - LOOPBACK — `localhost`, any `127.0.0.0/8` address, or `::1`. The kernel never puts these on a wire.
 *   - A SINGLE-LABEL hostname — `postgres`, the compose service alias. A name with no dot cannot be a
 *     public DNS name; it resolves only through the container's own resolver on the private bridge.
 *
 * Everything else keeps requiring TLS, INCLUDING the RFC1918 ranges (10/8, 172.16/12, 192.168/16) and
 * anything with a dot. Those are the shapes that traverse a real network — a VPC peer, a managed
 * Postgres, a second box — and "it is a private IP" has never meant "nobody can see the wire". Fail
 * closed on anything unparseable, so a malformed URL is asserted against rather than exempted.
 *
 * A trailing-dot FQDN (`postgres.`) contains a dot and is therefore NOT exempt: the conservative answer
 * for a name we did not anticipate is to demand TLS.
 */
export function isNonRoutableDbHost(databaseUrl: string): boolean {
  let host: string
  try {
    host = new URL(databaseUrl).hostname.trim().toLowerCase()
  } catch {
    return false
  }
  if (host.length === 0) return false
  // `new URL` KEEPS the brackets around an IPv6 literal (hostname is `[::1]`, not `::1`), so strip them
  // before comparing. Doing it unconditionally is safe: no other host shape here contains brackets.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "localhost" || host === "::1") return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  // Single-label container alias: letters/digits/hyphen/underscore only, and crucially no dot or colon.
  return /^[a-z0-9_-]+$/.test(host)
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
