import { describe, expect, it } from "vitest"
import { loadEnv } from "../../src/env.js"
import { buildContainer } from "../../src/di.js"

function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "8080",
    PUBLIC_API_URL: "https://api.civfix.org",
    WEB_ORIGINS: "https://civfix.org",
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
    UNSUBSCRIBE_SIGNING_KEY: "prod-unsubscribe-signing-key-abcdefghijklmnop",
    TICKET_TOKEN_SECRET: "prod-ticket-token-secret-abcdefghijklmnop",
  }
}

const APNS_QUARTET = {
  APNS_KEY_ID: "KEY123",
  APNS_TEAM_ID: "TEAM123",
  APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  APNS_BUNDLE_ID: "org.civfix.app",
}

describe("loadEnv: APNS_PRODUCTION", () => {
  it("requires an explicit APNS_PRODUCTION in production once APNs credentials are set", () => {
    expect(() => loadEnv({ ...validProdEnv(), ...APNS_QUARTET })).toThrow(/APNS_PRODUCTION/)
  })

  it("rejects a value that is neither true nor false instead of reading it as sandbox", () => {
    expect(() => loadEnv({ ...validProdEnv(), ...APNS_QUARTET, APNS_PRODUCTION: "prod" })).toThrow(
      /APNS_PRODUCTION/,
    )
  })

  it("accepts an explicit sandbox choice in production", () => {
    const env = loadEnv({ ...validProdEnv(), ...APNS_QUARTET, APNS_PRODUCTION: "false" })
    expect(env.APNS_PRODUCTION).toBe(false)
  })

  it("does not demand the flag when APNs is not configured", () => {
    expect(() => loadEnv(validProdEnv())).not.toThrow()
  })
})

describe("push config: APNs gateway default", () => {
  it("targets the production gateway when APNS_PRODUCTION is unset", () => {
    const container = buildContainer(
      loadEnv({
        NODE_ENV: "test",
        USE_FAKE_PUSH: "0",
        DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
        ...APNS_QUARTET,
      }),
    )
    const config = (
      container.pushSender as unknown as { config: { apns?: { production: boolean } } }
    ).config
    expect(config.apns?.production).toBe(true)
  })
})

describe("loadEnv: integer variables", () => {
  it("rejects trailing garbage instead of reading the leading digits", () => {
    expect(() => loadEnv({ ...validProdEnv(), OCI_EMAIL_SMTP_TIMEOUT_MS: "15s" })).toThrow(
      /OCI_EMAIL_SMTP_TIMEOUT_MS/,
    )
  })

  it("rejects a non-positive value for a positive-only setting instead of using the default", () => {
    expect(() => loadEnv({ NODE_ENV: "test", SMS_DAILY_CAP: "-5" })).toThrow(/SMS_DAILY_CAP/)
  })

  it("rejects a non-numeric value instead of silently using the default", () => {
    expect(() => loadEnv({ NODE_ENV: "test", TILES_MIN_ZOOM: "abc" })).toThrow(/TILES_MIN_ZOOM/)
    expect(() => loadEnv({ NODE_ENV: "test", HOST_EXPORT_TTL_HOURS: "24h" })).toThrow(
      /HOST_EXPORT_TTL_HOURS/,
    )
  })

  it("still reads well-formed integers and defaults blank values", () => {
    const env = loadEnv({ NODE_ENV: "test", SMS_DAILY_CAP: " 20 ", TILES_MIN_ZOOM: "" })
    expect(env.SMS_DAILY_CAP).toBe(20)
    expect(env.TILES_MIN_ZOOM).toBe(1)
  })
})
