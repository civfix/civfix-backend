import { describe, it, expect } from "vitest"
import { loadEnv } from "../../src/env.js"

/**
 * Minimal, deterministic env source for production tests. The helper starts from a fully-valid
 * production env and lets each case delete keys to assert the aggregated error.
 */
function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PORT: "8080",
    PUBLIC_API_URL: "https://api.civfix.org",
    WEB_ORIGINS: "https://civfix.org,https://app.civfix.org",
    DATABASE_URL: "postgres://user:pass@db:5432/civfix",
    REDIS_URL: "redis://cache:6379",
    SESSION_SIGNING_KEY: "prod-session-key",
    ANON_TOKEN_SIGNING_KEY: "prod-anon-key",
    // All fakes off in prod by default, so storage + mailer BOOT vars are required.
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "akid",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "civfix-media",
    OCI_EMAIL_SMTP_HOST: "smtp.oci.example",
    OCI_EMAIL_SMTP_PORT: "587",
    OCI_EMAIL_SMTP_USER: "smtp-user",
    OCI_EMAIL_SMTP_PASS: "smtp-pass",
  }
}

describe("loadEnv", () => {
  it("loads a complete production env", () => {
    const env = loadEnv(validProdEnv())
    expect(env.NODE_ENV).toBe("production")
    expect(env.PORT).toBe(8080)
    expect(env.WEB_ORIGINS).toEqual(["https://civfix.org", "https://app.civfix.org"])
    // Fakes default OFF in production.
    expect(env.USE_FAKE_STORAGE).toBe(false)
    expect(env.USE_FAKE_JOBS).toBe(false)
    // Optional defaults applied.
    expect(env.MAIL_FROM_NOREPLY).toBe("no-reply@civfix.org")
    expect(env.MAIL_FROM_OUTREACH).toBe("outreach@civfix.org")
    // TRUST_PROXY defaults to the safe internal CIDR set, NEVER trust-all, even in production.
    expect(env.TRUST_PROXY).not.toBe(true)
    expect(Array.isArray(env.TRUST_PROXY)).toBe(true)
  })

  it("honors an explicit TRUST_PROXY hop count", () => {
    const source = validProdEnv()
    source.TRUST_PROXY = "1"
    expect(loadEnv(source).TRUST_PROXY).toBe(1)
  })

  it("throws an aggregated error listing every missing BOOT var in production", () => {
    const source = validProdEnv()
    delete source.DATABASE_URL
    delete source.SESSION_SIGNING_KEY
    delete source.R2_BUCKET
    let caught: Error | undefined
    try {
      loadEnv(source)
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    const msg = caught!.message
    expect(msg).toContain("DATABASE_URL")
    expect(msg).toContain("SESSION_SIGNING_KEY")
    expect(msg).toContain("R2_BUCKET")
    // Aggregated: mentions a count of problems.
    expect(msg).toMatch(/problem\(s\) found/)
  })

  it("does NOT require R2/mailer BOOT vars in production when their fakes are on", () => {
    const source = validProdEnv()
    source.USE_FAKE_STORAGE = "1"
    source.USE_FAKE_MAILER = "true"
    delete source.R2_ACCOUNT_ID
    delete source.R2_BUCKET
    delete source.OCI_EMAIL_SMTP_HOST
    const env = loadEnv(source)
    expect(env.USE_FAKE_STORAGE).toBe(true)
    expect(env.USE_FAKE_MAILER).toBe(true)
  })

  it("supplies insecure dev defaults and turns fakes on outside production", () => {
    const env = loadEnv({ NODE_ENV: "development" })
    // Dev defaults for signing keys exist (non-empty) so the server can boot.
    expect(env.SESSION_SIGNING_KEY.length).toBeGreaterThan(0)
    expect(env.ANON_TOKEN_SIGNING_KEY.length).toBeGreaterThan(0)
    // Fakes default ON outside production.
    expect(env.USE_FAKE_STORAGE).toBe(true)
    expect(env.USE_FAKE_MAILER).toBe(true)
    expect(env.USE_FAKE_PUSH).toBe(true)
    expect(env.USE_FAKE_ABUSE_NSFW).toBe(true)
    expect(env.USE_FAKE_CHAT).toBe(true)
    expect(env.USE_FAKE_JOBS).toBe(true)
    // PORT default.
    expect(env.PORT).toBe(8080)
  })

  it("parses boolean flags from 1/true and rejects an out-of-range PORT", () => {
    const env = loadEnv({ NODE_ENV: "test", USE_FAKE_JOBS: "0", USE_FAKE_CHAT: "yes" })
    expect(env.USE_FAKE_JOBS).toBe(false)
    expect(env.USE_FAKE_CHAT).toBe(true)

    let caught: Error | undefined
    try {
      loadEnv({ NODE_ENV: "test", PORT: "99999" })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain("PORT")
  })
})
