import { describe, it, expect } from "vitest"
import {
  DEFAULT_TRUSTED_PROXY_CIDRS,
  FAKE_SEAM_FLAGS,
  loadEnv,
  REVIEWER_OTP_CODE_MIN_LENGTH,
  SHUTDOWN_DRAIN_MS_MAX,
} from "../../src/env.js"

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

describe("loadEnv: outbound SMS", () => {
  it("defaults to the fake sender outside production and the real one in production", () => {
    expect(loadEnv({ NODE_ENV: "test" }).USE_FAKE_SMS).toBe(true)
    expect(loadEnv(validProdEnv()).USE_FAKE_SMS).toBe(false)
  })

  it("requires the Twilio triple in production once the guest SMS channel is switched ON", () => {
    const source = validProdEnv()
    source.SMS_GUEST_ENABLED = "true"
    delete source.TWILIO_ACCOUNT_SID
    delete source.TWILIO_AUTH_TOKEN
    delete source.TWILIO_SMS_FROM
    expect(() => loadEnv(source)).toThrow(/TWILIO_ACCOUNT_SID/)
  })

  it("boots a production box with NO Twilio account while the channel stays off", () => {
    const source = validProdEnv()
    delete source.TWILIO_ACCOUNT_SID
    delete source.TWILIO_AUTH_TOKEN
    delete source.TWILIO_SMS_FROM
    expect(source.SMS_GUEST_ENABLED).toBeUndefined()
    expect(() => loadEnv(source)).not.toThrow()
  })

  it("H11: refuses USE_FAKE_SMS in production — it swallows guest OTPs while SMS still reads as available", () => {
    const source = validProdEnv()
    source.SMS_GUEST_ENABLED = "true"
    delete source.TWILIO_ACCOUNT_SID
    delete source.TWILIO_AUTH_TOKEN
    delete source.TWILIO_SMS_FROM
    source.USE_FAKE_SMS = "true"
    expect(() => loadEnv(source)).toThrow(/USE_FAKE_SMS: must not be true in production/)
  })

  it("H11: SMS_GUEST_ENABLED=false is the supported way to run production with no SMS", () => {
    const source = validProdEnv()
    source.SMS_GUEST_ENABLED = "false"
    delete source.TWILIO_ACCOUNT_SID
    delete source.TWILIO_AUTH_TOKEN
    delete source.TWILIO_SMS_FROM
    const env = loadEnv(source)
    expect(env.SMS_GUEST_ENABLED).toBe(false)
    expect(env.USE_FAKE_SMS).toBe(false)
  })

  it("keeps the guest SMS channel off and the daily cap bounded by default", () => {
    const env = loadEnv(validProdEnv())
    expect(env.SMS_GUEST_ENABLED).toBe(false)
    expect(env.SMS_DAILY_CAP).toBe(50)
  })

  it("reads an explicit guest-SMS switch and daily cap", () => {
    const source = validProdEnv()
    source.SMS_GUEST_ENABLED = "true"
    source.SMS_DAILY_CAP = "250"
    const env = loadEnv(source)
    expect(env.SMS_GUEST_ENABLED).toBe(true)
    expect(env.SMS_DAILY_CAP).toBe(250)
  })
})

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

  it("ignores a numeric TRUST_PROXY and keeps the safe internal-ranges default", () => {
    const source = validProdEnv()
    source.TRUST_PROXY = "1"
    const parsed = loadEnv(source).TRUST_PROXY
    expect(parsed).toEqual([...DEFAULT_TRUSTED_PROXY_CIDRS])
    expect(parsed).not.toBe(true)
    expect(parsed).not.toBe(false)
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

  it("H11: refuses to boot production when ANY known USE_FAKE_* flag is enabled (F030)", () => {
    expect(FAKE_SEAM_FLAGS.map((f) => f.flag).sort()).toEqual([
      "USE_FAKE_ABUSE_NSFW",
      "USE_FAKE_CHAT",
      "USE_FAKE_GEOCODER",
      "USE_FAKE_JOBS",
      "USE_FAKE_MAILER",
      "USE_FAKE_PUSH",
      "USE_FAKE_SMS",
      "USE_FAKE_STORAGE",
      "USE_FAKE_USER_CHANNEL",
    ])
    for (const { flag } of FAKE_SEAM_FLAGS) {
      const source = validProdEnv()
      source[flag] = "1"
      expect(() => loadEnv(source), flag).toThrow(
        new RegExp(`${flag}: must not be true in production`),
      )
    }
  })

  it("H11: the guard covers every USE_FAKE_* key the loader exposes on Env (no flag left behind)", () => {
    const listed = new Set<string>(FAKE_SEAM_FLAGS.map((f) => f.flag))
    const exposed = Object.keys(loadEnv({ NODE_ENV: "test" })).filter((k) =>
      k.startsWith("USE_FAKE_"),
    )
    expect(exposed.length).toBeGreaterThan(0)
    for (const key of exposed) expect(listed.has(key), key).toBe(true)
  })

  it("still defaults fakes ON (and never rejects them) outside production (F030)", () => {
    for (const { flag } of FAKE_SEAM_FLAGS) {
      const env = loadEnv({ NODE_ENV: "test", [flag]: "1" }) as unknown as Record<string, boolean>
      expect(env[flag], flag).toBe(true)
    }
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
    expect(
      loadEnv({ NODE_ENV: "test", CF_TURNSTILE_HOSTNAMES: "" }).CF_TURNSTILE_HOSTNAMES,
    ).toEqual([])
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

  it("defaults SHUTDOWN_DRAIN_MS to 0 in every environment and clamps a configured value", () => {
    expect(loadEnv(validProdEnv()).SHUTDOWN_DRAIN_MS).toBe(0)
    expect(loadEnv({ NODE_ENV: "test" }).SHUTDOWN_DRAIN_MS).toBe(0)
    expect(loadEnv({ NODE_ENV: "test", SHUTDOWN_DRAIN_MS: "3500" }).SHUTDOWN_DRAIN_MS).toBe(3500)
    expect(loadEnv({ ...validProdEnv(), SHUTDOWN_DRAIN_MS: "8000" }).SHUTDOWN_DRAIN_MS).toBe(8000)
    expect(loadEnv({ ...validProdEnv(), SHUTDOWN_DRAIN_MS: "12000" }).SHUTDOWN_DRAIN_MS).toBe(
      SHUTDOWN_DRAIN_MS_MAX,
    )
    expect(loadEnv({ ...validProdEnv(), SHUTDOWN_DRAIN_MS: "600000" }).SHUTDOWN_DRAIN_MS).toBe(
      SHUTDOWN_DRAIN_MS_MAX,
    )
    expect(loadEnv({ ...validProdEnv(), SHUTDOWN_DRAIN_MS: "-1" }).SHUTDOWN_DRAIN_MS).toBe(0)
    expect(loadEnv({ ...validProdEnv(), SHUTDOWN_DRAIN_MS: "nope" }).SHUTDOWN_DRAIN_MS).toBe(0)
  })
})

describe("loadEnv: outbound send policy", () => {
  it("accepts the defaults", () => {
    const env = loadEnv({ NODE_ENV: "test" })
    expect(env.OCI_EMAIL_SMTP_TIMEOUT_MS).toBe(15_000)
    expect(env.OUTBOUND_SEND_MIN_THROUGHPUT_BPS).toBe(256 * 1024)
  })

  it("REFUSES a throughput floor below the minimum", () => {
    expect(() => loadEnv({ NODE_ENV: "test", OUTBOUND_SEND_MIN_THROUGHPUT_BPS: "48" })).toThrow(
      /OUTBOUND_SEND_MIN_THROUGHPUT_BPS/,
    )
  })

  it("REFUSES an SMTP timeout above the ceiling", () => {
    expect(() => loadEnv({ NODE_ENV: "test", OCI_EMAIL_SMTP_TIMEOUT_MS: "300000" })).toThrow(
      /OCI_EMAIL_SMTP_TIMEOUT_MS/,
    )
  })

  it("REFUSES an in-range combination whose largest deadline outlives the in-flight guard", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        OCI_EMAIL_SMTP_TIMEOUT_MS: "60000",
        OUTBOUND_SEND_MIN_THROUGHPUT_BPS: String(16 * 1024),
      }),
    ).toThrow(/in-flight guard/)
  })

  it("accepts an in-range combination that fits", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      OCI_EMAIL_SMTP_TIMEOUT_MS: "30000",
      OUTBOUND_SEND_MIN_THROUGHPUT_BPS: String(64 * 1024),
    })
    expect(env.OCI_EMAIL_SMTP_TIMEOUT_MS).toBe(30_000)
  })
})
