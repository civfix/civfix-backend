import { describe, expect, it } from "vitest"
import { loadCommsEnv } from "../../src/env/comms-env.js"

function load(source: NodeJS.ProcessEnv): {
  env: ReturnType<typeof loadCommsEnv>
  errors: string[]
} {
  const errors: string[] = []
  return { env: loadCommsEnv(source, errors), errors }
}

const PROD_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  PUBLIC_API_URL: "https://api.civfix.org",
  SESSION_SIGNING_KEY: "s".repeat(40),
  ANON_TOKEN_SIGNING_KEY: "a".repeat(40),
  UNSUBSCRIBE_SIGNING_KEY: "u".repeat(40),
}

describe("loadCommsEnv defaults", () => {
  it("boots with nothing set", () => {
    const { env, errors } = load({})
    expect(errors).toEqual([])
    expect(env.MAIL_FROM_EVENTS).toBe("events@civfix.org")
    expect(env.BROADCAST_SWEEP_CRON).toBe("*/2 * * * *")
    expect(env.EVENT_REMINDERS_CRON).toBe("*/10 * * * *")
    expect(env.METRICS_ROLLUP_CRON).toBe("7 * * * *")
    expect(env.HOST_RETENTION_CRON).toBe("35 4 * * *")
    expect(env.HOST_EXPORT_REAP_CRON).toBe("40 * * * *")
    expect(env.HOST_BROADCAST_PER_EVENT_PER_DAY).toBe(3)
    expect(env.HOST_BROADCAST_RECIPIENTS_PER_DAY).toBe(2000)
    expect(env.BROADCAST_MAX_RECIPIENTS).toBe(5000)
    expect(env.BROADCAST_CHUNK_SIZE).toBe(200)
    expect(env.BROADCAST_EMAIL_CONCURRENCY).toBe(4)
    expect(env.BROADCAST_EMAIL_RATE_PER_SEC).toBe(10)
    expect(env.HOST_MESSAGING_KILL_SWITCH).toBe(false)
    expect(env.HOST_ANALYTICS_CACHE_TTL_SEC).toBe(120)
    expect(env.METRICS_ROLLUP_LOOKBACK_DAYS).toBe(3)
    expect(env.HOST_EXPORT_MAX_ROWS).toBe(50_000)
    expect(env.HOST_EXPORT_TTL_HOURS).toBe(24)
    expect(env.SMS_HOST_BROADCAST_ENABLED).toBe(false)
  })

  it("defaults the page-view dedupe guard OFF (no identifier is touched)", () => {
    expect(load({}).env.PAGE_VIEW_DEDUPE_SEC).toBe(0)
  })

  it("rejects a non-cron value", () => {
    const { errors } = load({ BROADCAST_SWEEP_CRON: "every other tuesday" })
    expect(errors.join(" ")).toContain("BROADCAST_SWEEP_CRON")
  })

  it("rejects an out-of-range cap and keeps the default", () => {
    const { env, errors } = load({ BROADCAST_CHUNK_SIZE: "99999" })
    expect(errors.join(" ")).toContain("BROADCAST_CHUNK_SIZE")
    expect(env.BROADCAST_CHUNK_SIZE).toBe(200)
  })

  it("refuses a zero on a cap whose minimum is 1 instead of silently defaulting", () => {
    const { env, errors } = load({ BROADCAST_MAX_RECIPIENTS: "0" })
    expect(errors.join(" ")).toContain("BROADCAST_MAX_RECIPIENTS: must be an integer between 1")
    expect(env.BROADCAST_MAX_RECIPIENTS).toBe(5000)
  })

  it("refuses a negative cap", () => {
    const { errors } = load({ BROADCAST_EMAIL_RATE_PER_SEC: "-5" })
    expect(errors.join(" ")).toContain("BROADCAST_EMAIL_RATE_PER_SEC")
  })

  it("honours a 0 where the minimum is 0 (staging runs no new-host delay)", () => {
    const { env, errors } = load({ HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS: "0" })
    expect(errors).toEqual([])
    expect(env.HOST_BROADCAST_MIN_ACCOUNT_AGE_HOURS).toBe(0)
  })

  it("defaults and bounds the event_updated per-event throttle", () => {
    expect(load({}).env.HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR).toBe(3)
    const { env, errors } = load({ HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR: "0" })
    expect(errors.join(" ")).toContain("HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR")
    expect(env.HOST_EVENT_UPDATE_PER_EVENT_PER_HOUR).toBe(3)
  })

  it("rejects an out-of-range dedupe window", () => {
    const { env, errors } = load({ PAGE_VIEW_DEDUPE_SEC: "99999" })
    expect(errors.join(" ")).toContain("PAGE_VIEW_DEDUPE_SEC")
    expect(env.PAGE_VIEW_DEDUPE_SEC).toBe(0)
  })

  it("parses the link allowlist as a lowercased comma list", () => {
    expect(
      load({ BROADCAST_LINK_ALLOWED_HOSTS: "Civfix.org, example.ORG" }).env
        .BROADCAST_LINK_ALLOWED_HOSTS,
    ).toEqual(["civfix.org", "example.org"])
  })
})

describe("UNSUBSCRIBE_SIGNING_KEY production rules", () => {
  it("accepts a strong distinct key", () => {
    expect(load(PROD_BASE).errors).toEqual([])
  })

  it("requires the key in production", () => {
    const { errors } = load({ ...PROD_BASE, UNSUBSCRIBE_SIGNING_KEY: "" })
    expect(errors.join(" ")).toContain("UNSUBSCRIBE_SIGNING_KEY: required")
  })

  it("requires at least 32 characters", () => {
    const { errors } = load({ ...PROD_BASE, UNSUBSCRIBE_SIGNING_KEY: "short" })
    expect(errors.join(" ")).toContain("at least 32 characters")
  })

  it("refuses the dev default", () => {
    const { errors } = load({
      ...PROD_BASE,
      UNSUBSCRIBE_SIGNING_KEY: "dev-insecure-unsubscribe-signing-key-do-not-use-in-prod",
    })
    expect(errors.join(" ")).toContain("insecure dev default")
  })

  it("refuses reuse of the session or anon signing key", () => {
    expect(
      load({ ...PROD_BASE, UNSUBSCRIBE_SIGNING_KEY: "s".repeat(40) }).errors.join(" "),
    ).toContain("must be a DIFFERENT value")
    expect(
      load({ ...PROD_BASE, UNSUBSCRIBE_SIGNING_KEY: "a".repeat(40) }).errors.join(" "),
    ).toContain("must be a DIFFERENT value")
  })

  it("falls back to a dev key outside production", () => {
    expect(load({}).env.UNSUBSCRIBE_SIGNING_KEY).toContain("dev-insecure")
  })

  it("requires PUBLIC_API_URL in production (it is the one-click unsubscribe origin)", () => {
    const { errors } = load({ ...PROD_BASE, PUBLIC_API_URL: "" })
    expect(errors.join(" ")).toContain("PUBLIC_API_URL: required [BOOT]")
  })

  it("rejects a From that is not an address", () => {
    expect(load({ MAIL_FROM_EVENTS: "events" }).errors.join(" ")).toContain("MAIL_FROM_EVENTS")
  })
})
