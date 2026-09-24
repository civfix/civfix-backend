import { describe, it, expect } from "vitest"
import { DEFAULT_FEED_RANKING } from "@civfix/shared"
import { FAKE_SEAM_FLAGS, loadEnv } from "../../src/env.js"

// Characterization net for the loadEnv split into section loaders: the resolved Env, every aggregated
// error message and their ORDER must survive the refactor byte for byte. Expected messages spell the
// em dash the loader emits by code point so this file stays ASCII.

const DASH = String.fromCharCode(0x2014)

function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "8080",
    PUBLIC_API_URL: "https://api.civfix.org",
    WEB_ORIGINS: "https://civfix.org,https://app.civfix.org",
    DATABASE_URL: "postgres://user:pass@db:5432/civfix?sslmode=require",
    REDIS_URL: "redis://cache:6379",
    SESSION_SIGNING_KEY: "prod-session-signing-key-abcdefghijklmnop",
    ANON_TOKEN_SIGNING_KEY: "prod-anon-token-signing-key-abcdefghijklmnop",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "civfix-media",
    OCI_EMAIL_SMTP_HOST: "smtp.oci.example",
    OCI_EMAIL_SMTP_PORT: "587",
    OCI_EMAIL_SMTP_USER: "smtp-user",
    OCI_EMAIL_SMTP_PASS: "smtp-pass",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_SMS_FROM: "+15550001111",
    UNSUBSCRIBE_SIGNING_KEY: "prod-unsubscribe-signing-key-abcdefghijklmnop",
    TICKET_TOKEN_SECRET: "prod-ticket-token-secret-abcdefghijklmnop",
  }
}

const DEFAULT_TRUST_PROXY = [
  "127.0.0.1/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]

const ENVIRONMENT_INDEPENDENT_DEFAULTS = {
  PORT: 8080,
  TRUST_PROXY: DEFAULT_TRUST_PROXY,
  SHUTDOWN_DRAIN_MS: 0,
  TILES_MIN_ZOOM: 1,
  TILES_MAX_ZOOM: 19,
  TILES_BOUNDS: [-125, 24, -66, 50],
  HOME_REGION_LAT: 34.0522,
  HOME_REGION_LNG: -118.2437,
  HOME_REGION_RADIUS_KM: 40,
  FEED_RANKING: DEFAULT_FEED_RANKING,
  CENSUS_GEOCODER_URL: "https://geocoding.geo.census.gov/geocoder/geographies/coordinates",
  CENSUS_GEOCODER_TIMEOUT_MS: 2500,
  OCI_EMAIL_SMTP_PORT: 587,
  OCI_EMAIL_SMTP_TIMEOUT_MS: 15000,
  OUTBOUND_SEND_MIN_THROUGHPUT_BPS: 262144,
  VOLUNTEER_HOURS_WEEKLY_FLAG_HOURS: 60,
  MAIL_FROM_NOREPLY: "no-reply@civfix.org",
  MAIL_FROM_OUTREACH: "outreach@civfix.org",
  HOME_TURF_MAIL_FROM: "donotreply@civfix.org",
  HOME_TURF_NOTIFY_TO: "",
  ADMIN_EMAILS: [],
  MAIL_REPLY_DOMAIN: "civfix.org",
  OUTREACH_THROTTLE_DAYS: 7,
  OUTREACH_DIGEST_CRON: "0 14 * * *",
  OUTREACH_DIGEST_ENABLED: false,
  REPORT_AUTOFORWARD_ENABLED: false,
  INBOUND_SWEEP_CRON: "*/5 * * * *",
  GUEST_RETENTION_CRON: "15 4 * * *",
  SMS_GUEST_ENABLED: false,
  SMS_DAILY_CAP: 50,
  CF_ACCESS_SERVICE_TOKENS: [],
  CF_TURNSTILE_HOSTNAMES: [],
  OAUTH_REQUIRE_NONCE: false,
  REVIEWER_OTP_BYPASS: false,
  REVIEWER_OTP_BYPASS_ACK: false,
  USE_REAL_NSFW: false,
  MAIL_FROM_EVENTS: "events@civfix.org",
  BROADCAST_SWEEP_CRON: "*/2 * * * *",
  EVENT_REMINDERS_CRON: "*/10 * * * *",
  METRICS_ROLLUP_CRON: "7 * * * *",
  HOST_RETENTION_CRON: "35 4 * * *",
  HOST_EXPORT_REAP_CRON: "40 * * * *",
  HOST_BROADCAST_PER_EVENT_PER_DAY: 3,
  HOST_BROADCAST_RECIPIENTS_PER_DAY: 2000,
  HOST_BROADCAST_COOLDOWN_SEC: 900,
  HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS: 24,
  HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR: 3,
  BROADCAST_MAX_RECIPIENTS: 5000,
  BROADCAST_CHUNK_SIZE: 200,
  BROADCAST_EMAIL_CONCURRENCY: 4,
  BROADCAST_EMAIL_RATE_PER_SEC: 10,
  BROADCAST_LINK_ALLOWED_HOSTS: [],
  HOST_MESSAGING_KILL_SWITCH: false,
  HOST_ANALYTICS_CACHE_TTL_SEC: 120,
  PAGE_VIEW_DEDUPE_SEC: 0,
  METRICS_ROLLUP_LOOKBACK_DAYS: 3,
  HOST_EXPORT_MAX_ROWS: 50000,
  HOST_EXPORT_TTL_HOURS: 24,
  SMS_HOST_BROADCAST_ENABLED: false,
  WAITLIST_EXPIRE_CRON: "*/10 * * * *",
  CHECKIN_NOSHOW_CRON: "*/30 * * * *",
}

function fakeFlags(value: boolean): Record<string, boolean> {
  return {
    USE_FAKE_STORAGE: value,
    USE_FAKE_MAILER: value,
    USE_FAKE_PUSH: value,
    USE_FAKE_ABUSE_NSFW: value,
    USE_FAKE_CHAT: value,
    USE_FAKE_JOBS: value,
    USE_FAKE_USER_CHANNEL: value,
    USE_FAKE_GEOCODER: value,
    USE_FAKE_SMS: value,
  }
}

function nonProductionDefaults(nodeEnv: "development" | "test"): Record<string, unknown> {
  return {
    ...ENVIRONMENT_INDEPENDENT_DEFAULTS,
    ...fakeFlags(true),
    NODE_ENV: nodeEnv,
    PUBLIC_API_URL: "",
    WEB_ORIGINS: [],
    DATABASE_URL: "",
    REDIS_URL: "",
    SESSION_SIGNING_KEY: "dev-insecure-session-signing-key-do-not-use-in-prod",
    ANON_TOKEN_SIGNING_KEY: "dev-insecure-anon-token-signing-key-do-not-use-in-prod",
    R2_ACCOUNT_ID: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_BUCKET: "",
    OCI_EMAIL_SMTP_HOST: "",
    OCI_EMAIL_SMTP_USER: "",
    OCI_EMAIL_SMTP_PASS: "",
    TWILIO_ACCOUNT_SID: "",
    TWILIO_AUTH_TOKEN: "",
    TWILIO_SMS_FROM: "",
    UNSUBSCRIBE_SIGNING_KEY: "dev-insecure-unsubscribe-signing-key-do-not-use-in-prod",
    TICKET_TOKEN_SECRET: "dev-insecure-ticket-token-secret-do-not-use-in-prod",
  }
}

function loadError(source: NodeJS.ProcessEnv): string {
  try {
    loadEnv(source)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error("expected loadEnv to throw")
}

function aggregated(nodeEnv: string, problems: string[]): string {
  return [
    `Invalid environment for civfix API (NODE_ENV=${nodeEnv}). ${problems.length} problem(s) found:`,
    ...problems.map((p) => `  - ${p}`),
  ].join("\n")
}

const GEOCODER_NEEDS_DB =
  `DATABASE_URL: required whenever USE_FAKE_GEOCODER is false ${DASH} the real geocoder resolves its ` +
  `"City, ST" label from the jurisdictions PostGIS table, so there is nothing to query without a database`
const KEYS_EQUAL =
  "SESSION_SIGNING_KEY / ANON_TOKEN_SIGNING_KEY: must be DIFFERENT values in production " +
  "(one shared secret lets a session-cookie oracle and an anon-token oracle attack the same key)"
const TRUST_PROXY_TRUE =
  "TRUST_PROXY: must not be `true` in production (it trusts any client-supplied X-Forwarded-For). " +
  "Use an explicit CIDR list; leave unset for the safe internal-ranges default"
const SHORT_REVIEWER_CODE =
  "REVIEWER_OTP_CODE: must be at least 20 characters (it is a login secret, not a 6-digit OTP)"
const BAD_CRON = (key: string): string => `${key}: must be a 5- or 6-field cron expression`
const BAD_PORT = (key: string): string => `${key}: must be an integer between 1 and 65535`

describe("loadEnv characterization: resolved Env", () => {
  it("resolves a representative valid production env to exactly this object", () => {
    const env = loadEnv(validProdEnv())
    expect(env).toStrictEqual({
      ...ENVIRONMENT_INDEPENDENT_DEFAULTS,
      ...fakeFlags(false),
      NODE_ENV: "production",
      PUBLIC_API_URL: "https://api.civfix.org",
      WEB_ORIGINS: ["https://civfix.org", "https://app.civfix.org"],
      DATABASE_URL: "postgres://user:pass@db:5432/civfix?sslmode=require",
      REDIS_URL: "redis://cache:6379",
      SESSION_SIGNING_KEY: "prod-session-signing-key-abcdefghijklmnop",
      ANON_TOKEN_SIGNING_KEY: "prod-anon-token-signing-key-abcdefghijklmnop",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "akid",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "civfix-media",
      OCI_EMAIL_SMTP_HOST: "smtp.oci.example",
      OCI_EMAIL_SMTP_USER: "smtp-user",
      OCI_EMAIL_SMTP_PASS: "smtp-pass",
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: "twilio-token",
      TWILIO_SMS_FROM: "+15550001111",
      UNSUBSCRIBE_SIGNING_KEY: "prod-unsubscribe-signing-key-abcdefghijklmnop",
      TICKET_TOKEN_SECRET: "prod-ticket-token-secret-abcdefghijklmnop",
    })
    expect(env.FEED_RANKING).toBe(DEFAULT_FEED_RANKING)
  })

  it("resolves the empty test env to the non-production defaults", () => {
    expect(loadEnv({ NODE_ENV: "test" })).toStrictEqual(nonProductionDefaults("test"))
  })

  it("resolves a fully empty source to NODE_ENV=development and the same defaults", () => {
    expect(loadEnv({})).toStrictEqual(nonProductionDefaults("development"))
  })

  it("adds optional keys only when set to a non-blank value, trimmed", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      R2_PUBLIC_BASE: "  https://cdn.civfix.org  ",
      MAPBOX_TOKEN: "   ",
      GLITCHTIP_DSN: "https://dsn.example/1",
      REVIEWER_OTP_CODE: "  reviewer-code-at-least-20-chars  ",
      APNS_PRODUCTION: "yes",
      LOCAL_STORAGE_DIR: " /var/tmp/civfix ",
      LOCAL_STORAGE_SIGNING_KEY: "local-key",
      PUBLIC_API_URL: "http://localhost:8080",
    })
    expect(env).toStrictEqual({
      ...nonProductionDefaults("test"),
      PUBLIC_API_URL: "http://localhost:8080",
      R2_PUBLIC_BASE: "https://cdn.civfix.org",
      GLITCHTIP_DSN: "https://dsn.example/1",
      REVIEWER_OTP_CODE: "reviewer-code-at-least-20-chars",
      APNS_PRODUCTION: true,
      LOCAL_STORAGE_DIR: "/var/tmp/civfix",
      LOCAL_STORAGE_SIGNING_KEY: "local-key",
    })
  })

  it("drops LOCAL_STORAGE_SIGNING_KEY when LOCAL_STORAGE_DIR is unset", () => {
    const env = loadEnv({ NODE_ENV: "test", LOCAL_STORAGE_SIGNING_KEY: "local-key" })
    expect("LOCAL_STORAGE_SIGNING_KEY" in env).toBe(false)
    expect("LOCAL_STORAGE_DIR" in env).toBe(false)
  })
})

describe("loadEnv characterization: aggregated errors (text and order)", () => {
  it("lists every missing boot var for a bare production env, in this order", () => {
    expect(loadError({ NODE_ENV: "production" })).toBe(
      aggregated("production", [
        "PUBLIC_API_URL: required [BOOT] variable is missing",
        "WEB_ORIGINS: required [BOOT] CORS allowlist (comma list) is missing",
        "DATABASE_URL: required [BOOT] variable is missing",
        "REDIS_URL: required [BOOT] variable is missing",
        "SESSION_SIGNING_KEY: required [BOOT] variable is missing",
        "ANON_TOKEN_SIGNING_KEY: required [BOOT] variable is missing",
        GEOCODER_NEEDS_DB,
        "R2_ACCOUNT_ID: required [BOOT] variable is missing",
        "R2_ACCESS_KEY_ID: required [BOOT] variable is missing",
        "R2_SECRET_ACCESS_KEY: required [BOOT] variable is missing",
        "R2_BUCKET: required [BOOT] variable is missing",
        "OCI_EMAIL_SMTP_HOST: required [BOOT] variable is missing",
        "OCI_EMAIL_SMTP_USER: required [BOOT] variable is missing",
        "OCI_EMAIL_SMTP_PASS: required [BOOT] variable is missing",
        // Known-questionable: the comms section reports a missing PUBLIC_API_URL a second time.
        `PUBLIC_API_URL: required [BOOT] for host communications ${DASH} the RFC 8058 List-Unsubscribe ` +
          "header in every broadcast email is an API-origin URL, and a wrong origin makes one-click " +
          "unsubscribe fail for every recipient",
        "UNSUBSCRIBE_SIGNING_KEY: required [BOOT] variable is missing",
        "TICKET_TOKEN_SECRET: required [BOOT] variable is missing",
      ]),
    )
  })

  it("refuses USE_FAKE_* flags in production, one line each, in FAKE_SEAM_FLAGS order", () => {
    expect(loadError({ ...validProdEnv(), USE_FAKE_GEOCODER: "1", USE_FAKE_MAILER: "true" })).toBe(
      aggregated("production", [
        `USE_FAKE_MAILER: must not be true in production ${DASH} every outbound email is silently dropped`,
        `USE_FAKE_GEOCODER: must not be true in production ${DASH} every report is labeled ` +
          '"Los Angeles, CA" and that label is persisted as civic record',
      ]),
    )
  })

  it("refuses TRUST_PROXY=true in production", () => {
    expect(loadError({ ...validProdEnv(), TRUST_PROXY: "true" })).toBe(
      aggregated("production", [TRUST_PROXY_TRUE]),
    )
  })

  it("refuses equal SESSION and ANON signing keys in production", () => {
    expect(
      loadError({ ...validProdEnv(), ANON_TOKEN_SIGNING_KEY: validProdEnv().SESSION_SIGNING_KEY }),
    ).toBe(aggregated("production", [KEYS_EQUAL]))
  })

  it("refuses a short REVIEWER_OTP_CODE in production and outside it", () => {
    expect(loadError({ ...validProdEnv(), REVIEWER_OTP_CODE: "123456" })).toBe(
      aggregated("production", [SHORT_REVIEWER_CODE]),
    )
    expect(loadError({ NODE_ENV: "test", REVIEWER_OTP_CODE: "123456" })).toBe(
      aggregated("test", [SHORT_REVIEWER_CODE]),
    )
  })

  it("refuses bad crons across the core, comms and registration sections, in section order", () => {
    expect(
      loadError({
        ...validProdEnv(),
        WAITLIST_EXPIRE_CRON: "nope",
        BROADCAST_SWEEP_CRON: "* * *",
        OUTREACH_DIGEST_CRON: "every day",
      }),
    ).toBe(
      aggregated("production", [
        BAD_CRON("OUTREACH_DIGEST_CRON"),
        BAD_CRON("BROADCAST_SWEEP_CRON"),
        BAD_CRON("WAITLIST_EXPIRE_CRON"),
      ]),
    )
  })

  it("refuses out-of-range and non-numeric ports", () => {
    expect(loadError({ ...validProdEnv(), PORT: "70000", OCI_EMAIL_SMTP_PORT: "abc" })).toBe(
      aggregated("production", [BAD_PORT("PORT"), BAD_PORT("OCI_EMAIL_SMTP_PORT")]),
    )
    expect(loadError({ NODE_ENV: "test", PORT: "0" })).toBe(aggregated("test", [BAD_PORT("PORT")]))
  })

  it("pins (known-questionable) an unknown NODE_ENV reported under a NODE_ENV=development header", () => {
    expect(loadError({ NODE_ENV: "staging" })).toBe(
      aggregated("development", ["NODE_ENV: must be one of development | test | production"]),
    )
  })

  it("orders a mixed production failure: fake flags, boot vars, keys, proxy, geocoder, crons, reviewer", () => {
    expect(
      loadError({
        ...validProdEnv(),
        PORT: "-1",
        TRUST_PROXY: "TRUE",
        USE_FAKE_JOBS: "yes",
        SESSION_SIGNING_KEY: "short",
        ANON_TOKEN_SIGNING_KEY: "short",
        REVIEWER_OTP_CODE: "abc",
        REVIEWER_OTP_BYPASS: "true",
        INBOUND_SWEEP_CRON: "x",
        DATABASE_URL: "",
      }),
    ).toBe(
      aggregated("production", [
        `USE_FAKE_JOBS: must not be true in production ${DASH} background jobs run in-process and die ` +
          "with the request: media stays 'validating', data exports and report autoforwards never complete",
        BAD_PORT("PORT"),
        "DATABASE_URL: required [BOOT] variable is missing",
        "SESSION_SIGNING_KEY: must be at least 32 characters in production " +
          "(it is the cookie-signing and session-bound CSRF HMAC secret)",
        "ANON_TOKEN_SIGNING_KEY: must be at least 32 characters in production " +
          "(it signs the anon-report claim tokens)",
        KEYS_EQUAL,
        TRUST_PROXY_TRUE,
        GEOCODER_NEEDS_DB,
        BAD_CRON("INBOUND_SWEEP_CRON"),
        SHORT_REVIEWER_CODE,
        "REVIEWER_OTP_BYPASS: refusing to enable an authentication bypass in production without the " +
          "explicit second opt-in REVIEWER_OTP_BYPASS_ACK=true",
      ]),
    )
  })
})

describe("loadEnv characterization: FAKE_SEAM_FLAGS", () => {
  it("names exactly these flags, in this order, with these consequences", () => {
    expect(FAKE_SEAM_FLAGS).toEqual([
      {
        flag: "USE_FAKE_STORAGE",
        consequence: "uploaded media is kept in memory and lost on restart",
      },
      { flag: "USE_FAKE_MAILER", consequence: "every outbound email is silently dropped" },
      { flag: "USE_FAKE_PUSH", consequence: "every push notification is silently dropped" },
      { flag: "USE_FAKE_ABUSE_NSFW", consequence: "NSFW and abuse checks always pass" },
      {
        flag: "USE_FAKE_CHAT",
        consequence: "chat is in-process only: no persistence, no fan-out",
      },
      {
        flag: "USE_FAKE_JOBS",
        consequence:
          "background jobs run in-process and die with the request: media stays 'validating', data " +
          "exports and report autoforwards never complete",
      },
      {
        flag: "USE_FAKE_USER_CHANNEL",
        consequence: "realtime per-user signals never reach other API processes",
      },
      {
        flag: "USE_FAKE_GEOCODER",
        consequence:
          'every report is labeled "Los Angeles, CA" and that label is persisted as civic record',
      },
      {
        flag: "USE_FAKE_SMS",
        consequence:
          "guest-RSVP verification texts are swallowed and guests can never verify (turn SMS off " +
          "with SMS_GUEST_ENABLED=false instead)",
      },
    ])
  })

  it("defaults every flag ON outside production and OFF in production; USE_REAL_NSFW is always off", () => {
    const test = loadEnv({ NODE_ENV: "test" })
    const prod = loadEnv(validProdEnv())
    for (const { flag } of FAKE_SEAM_FLAGS) {
      expect(test[flag], flag).toBe(true)
      expect(prod[flag], flag).toBe(false)
    }
    expect(test.USE_REAL_NSFW).toBe(false)
    expect(prod.USE_REAL_NSFW).toBe(false)
  })

  it("lets an explicit falsy value turn a fake off outside production", () => {
    const env = loadEnv({ NODE_ENV: "test", USE_FAKE_MAILER: "0", USE_FAKE_SMS: "no" })
    expect(env.USE_FAKE_MAILER).toBe(false)
    expect(env.USE_FAKE_SMS).toBe(false)
    expect(env.USE_FAKE_STORAGE).toBe(true)
  })
})
