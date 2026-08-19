import { describe, it, expect } from "vitest"
import { loadEnv, REVIEWER_OTP_CODE_MIN_LENGTH } from "../../src/env.js"

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
  }
}

describe("loadEnv", () => {
  it("loads a complete production env", () => {
    const env = loadEnv(validProdEnv())
    expect(env.NODE_ENV).toBe("production")
    expect(env.PORT).toBe(8080)
    expect(env.WEB_ORIGINS).toEqual(["https://civfix.org", "https://app.civfix.org"])
    expect(env.USE_FAKE_STORAGE).toBe(false)
    expect(env.USE_FAKE_JOBS).toBe(false)
    expect(env.MAIL_FROM_NOREPLY).toBe("no-reply@civfix.org")
    expect(env.MAIL_FROM_OUTREACH).toBe("outreach@civfix.org")
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
    expect(msg).toMatch(/problem\(s\) found/)
  })

  it("refuses to boot production when a security/durability fake is explicitly enabled (F030)", () => {
    for (const flag of ["USE_FAKE_ABUSE_NSFW", "USE_FAKE_CHAT", "USE_FAKE_MAILER", "USE_FAKE_STORAGE"]) {
      const source = validProdEnv()
      source[flag] = "1"
      expect(() => loadEnv(source), flag).toThrow(
        new RegExp(`${flag}: must not be true in production`),
      )
    }
  })

  it("still defaults fakes ON (and never rejects them) outside production (F030)", () => {
    const env = loadEnv({ NODE_ENV: "test", USE_FAKE_STORAGE: "1", USE_FAKE_CHAT: "1" })
    expect(env.USE_FAKE_STORAGE).toBe(true)
    expect(env.USE_FAKE_CHAT).toBe(true)
  })

  it("rejects a signing key shorter than the minimum in production (F024)", () => {
    const shortSession = validProdEnv()
    shortSession.SESSION_SIGNING_KEY = "too-short"
    expect(() => loadEnv(shortSession)).toThrow(/SESSION_SIGNING_KEY: must be at least 32/)

    const shortAnon = validProdEnv()
    shortAnon.ANON_TOKEN_SIGNING_KEY = "too-short"
    expect(() => loadEnv(shortAnon)).toThrow(/ANON_TOKEN_SIGNING_KEY: must be at least 32/)
  })

  it("rejects equal session and anon signing keys in production (F024)", () => {
    const source = validProdEnv()
    source.SESSION_SIGNING_KEY = "the-same-32-char-signing-key-abcdef"
    source.ANON_TOKEN_SIGNING_KEY = "the-same-32-char-signing-key-abcdef"
    expect(() => loadEnv(source)).toThrow(/must be DIFFERENT values in production/)
  })

  it("supplies insecure dev defaults and turns fakes on outside production", () => {
    const env = loadEnv({ NODE_ENV: "development" })
    expect(env.SESSION_SIGNING_KEY.length).toBeGreaterThan(0)
    expect(env.ANON_TOKEN_SIGNING_KEY.length).toBeGreaterThan(0)
    expect(env.USE_FAKE_STORAGE).toBe(true)
    expect(env.USE_FAKE_MAILER).toBe(true)
    expect(env.USE_FAKE_PUSH).toBe(true)
    expect(env.USE_FAKE_ABUSE_NSFW).toBe(true)
    expect(env.USE_FAKE_CHAT).toBe(true)
    expect(env.USE_FAKE_JOBS).toBe(true)
    expect(env.PORT).toBe(8080)
  })


  it("defaults REVIEWER_OTP_BYPASS to false in every environment", () => {
    expect(loadEnv(validProdEnv()).REVIEWER_OTP_BYPASS).toBe(false)
    expect(loadEnv({ NODE_ENV: "development" }).REVIEWER_OTP_BYPASS).toBe(false)
    const source = validProdEnv()
    source.REVIEWER_OTP_BYPASS = "maybe"
    expect(loadEnv(source).REVIEWER_OTP_BYPASS).toBe(false)
  })

  it("refuses to boot production with the bypass on but no second opt-in and no code", () => {
    const source = validProdEnv()
    source.REVIEWER_OTP_BYPASS = "true"
    expect(() => loadEnv(source)).toThrow(/REVIEWER_OTP_BYPASS_ACK/)
    expect(() => loadEnv(source)).toThrow(/REVIEWER_OTP_CODE/)
  })

  it("refuses to boot production with the bypass acknowledged but no code", () => {
    const source = validProdEnv()
    source.REVIEWER_OTP_BYPASS = "true"
    source.REVIEWER_OTP_BYPASS_ACK = "true"
    expect(() => loadEnv(source)).toThrow(/REVIEWER_OTP_CODE: required/)
  })

  it("rejects a REVIEWER_OTP_CODE shorter than the minimum, in any environment", () => {
    expect(() => loadEnv({ NODE_ENV: "development", REVIEWER_OTP_CODE: "000000" })).toThrow(
      /REVIEWER_OTP_CODE: must be at least 20/,
    )
  })

  it("accepts the production bypass only with BOTH the ack and a long code", () => {
    const source = validProdEnv()
    source.REVIEWER_OTP_BYPASS = "true"
    source.REVIEWER_OTP_BYPASS_ACK = "true"
    source.REVIEWER_OTP_CODE = "a".repeat(REVIEWER_OTP_CODE_MIN_LENGTH)
    const env = loadEnv(source)
    expect(env.REVIEWER_OTP_BYPASS).toBe(true)
    expect(env.REVIEWER_OTP_CODE).toBe("a".repeat(REVIEWER_OTP_CODE_MIN_LENGTH))
  })

  it("leaves REVIEWER_OTP_CODE undefined when unset (no hardcoded default)", () => {
    expect(loadEnv(validProdEnv()).REVIEWER_OTP_CODE).toBeUndefined()
  })


  it("requires R2_INBOUND_BUCKET once R2_PUBLIC_BASE is set", () => {
    const source = validProdEnv()
    source.R2_PUBLIC_BASE = "https://cdn.civfix.org"
    expect(() => loadEnv(source)).toThrow(/R2_INBOUND_BUCKET: required/)
  })

  it("rejects an inbound bucket equal to the media bucket", () => {
    const source = validProdEnv()
    source.R2_PUBLIC_BASE = "https://cdn.civfix.org"
    source.R2_INBOUND_BUCKET = source.R2_BUCKET
    expect(() => loadEnv(source)).toThrow(/DIFFERENT bucket/)
  })

  it("accepts a distinct inbound bucket alongside a public base", () => {
    const source = validProdEnv()
    source.R2_PUBLIC_BASE = "https://cdn.civfix.org"
    source.R2_INBOUND_BUCKET = "civfix-inbound"
    expect(loadEnv(source).R2_INBOUND_BUCKET).toBe("civfix-inbound")
  })

  it("keeps R2_INBOUND_BUCKET optional when nothing is publicly addressable", () => {
    const source = validProdEnv()
    delete source.R2_PUBLIC_BASE
    expect(loadEnv(source).R2_INBOUND_BUCKET).toBeUndefined()
  })

  it("does not police buckets when storage is fake (non-production)", () => {
    const env = loadEnv({ NODE_ENV: "development", R2_PUBLIC_BASE: "https://cdn.civfix.org" })
    expect(env.R2_PUBLIC_BASE).toBe("https://cdn.civfix.org")
  })


  it.each(["require", "verify-ca", "verify-full"])(
    "accepts sslmode=%s on DATABASE_URL in production",
    (mode) => {
      const source = validProdEnv()
      source.DATABASE_URL = `postgres://user:pass@db:5432/civfix?sslmode=${mode}`
      expect(() => loadEnv(source)).not.toThrow()
    },
  )

  it.each([undefined, "disable", "prefer", "allow"])(
    "refuses to boot production with sslmode=%s on a routable host",
    (mode) => {
      const source = validProdEnv()
      source.DATABASE_URL =
        mode === undefined
          ? "postgres://user:pass@pg.example.com:5432/civfix"
          : `postgres://user:pass@pg.example.com:5432/civfix?sslmode=${mode}`
      expect(() => loadEnv(source)).toThrow(/DATABASE_URL: production requires TLS/)
    },
  )


  it.each([
    ["compose service alias", "postgres://user:pass@postgres:5432/civfix"],
    ["single-label with hyphen", "postgres://user:pass@civfix-postgres:5432/civfix"],
    ["localhost", "postgres://user:pass@localhost:5432/civfix"],
    ["127.0.0.1", "postgres://user:pass@127.0.0.1:5432/civfix"],
    ["127.x loopback", "postgres://user:pass@127.16.0.9:5432/civfix"],
    ["IPv6 loopback", "postgres://user:pass@[::1]:5432/civfix"],
  ])("allows a cleartext production link to a non-routable host: %s", (_label, url) => {
    const source = validProdEnv()
    source.DATABASE_URL = url
    expect(() => loadEnv(source)).not.toThrow()
  })

  it.each([
    ["dotted FQDN", "postgres://user:pass@pg.example.com:5432/civfix"],
    ["trailing-dot FQDN", "postgres://user:pass@postgres.:5432/civfix"],
    ["RFC1918 10/8", "postgres://user:pass@10.0.0.5:5432/civfix"],
    ["RFC1918 172.16/12", "postgres://user:pass@172.16.0.5:5432/civfix"],
    ["RFC1918 192.168/16", "postgres://user:pass@192.168.1.5:5432/civfix"],
    ["public IP", "postgres://user:pass@203.0.113.10:5432/civfix"],
    ["non-loopback 128.x", "postgres://user:pass@128.0.0.1:5432/civfix"],
  ])("still requires TLS in production for a routable host: %s", (_label, url) => {
    const source = validProdEnv()
    source.DATABASE_URL = url
    expect(() => loadEnv(source)).toThrow(/DATABASE_URL: production requires TLS/)
  })

  it("does not require TLS outside production (dev + testcontainers connect in the clear)", () => {
    expect(() =>
      loadEnv({ NODE_ENV: "development", DATABASE_URL: "postgres://u:p@localhost:5432/civfix" }),
    ).not.toThrow()
  })


  it("rejects TRUST_PROXY=true in production", () => {
    const source = validProdEnv()
    source.TRUST_PROXY = "true"
    expect(() => loadEnv(source)).toThrow(/TRUST_PROXY: must not be `true` in production/)
  })

  it("still allows TRUST_PROXY=true outside production", () => {
    expect(loadEnv({ NODE_ENV: "development", TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true)
  })

  it("parses CF_TURNSTILE_HOSTNAMES as a lowercased, de-duplicated list and defaults to empty", () => {
    expect(loadEnv({ NODE_ENV: "test" }).CF_TURNSTILE_HOSTNAMES).toEqual([])
    expect(loadEnv({ NODE_ENV: "test", CF_TURNSTILE_HOSTNAMES: "" }).CF_TURNSTILE_HOSTNAMES).toEqual([])
    const env = loadEnv({
      NODE_ENV: "test",
      CF_TURNSTILE_HOSTNAMES: " CivFix.org , www.civfix.org ,civfix.org",
    })
    expect(env.CF_TURNSTILE_HOSTNAMES).toEqual(["civfix.org", "www.civfix.org"])
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
