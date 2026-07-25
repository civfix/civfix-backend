import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import type { FakeMailer } from "@civfix/shared/fakes"
import type { OutboundEmail } from "@civfix/shared/interfaces"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import {
  enforceHomeTurfIpCap,
  enforceHomeTurfRecipientCap,
  HOME_TURF_EMAIL_LIMIT_PER_DAY,
  HOME_TURF_IP_LIMIT_PER_HOUR,
  HOME_TURF_RATE_LIMIT,
} from "../../src/routes/forms.routes.js"

/**
 * Route-level tests for POST /forms/home-turf via the real Fastify app (app.inject) with NO database
 * and NO auth bundle (the route must mount + work without them). The test env defaults every fake ON,
 * so container.mailer is the FakeMailer (captures every sendOutbound envelope) and
 * container.abuseChecks is FakeAbuseChecks (verifyTurnstile succeeds unless the token is "fail").
 */

interface Harness {
  app: FastifyInstance
  mailer: FakeMailer
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

async function makeHarness(): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })
  const container = buildContainer(env)
  const app = await buildServer({
    env,
    container,
    homeTurfOverrides: { counters: new InMemoryCounterStore(() => 0) },
  })
  const h: Harness = { app, mailer: container.mailer as FakeMailer }
  current = h
  return h
}

function formPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coachName: "Alex Rivera",
    role: "Head Coach",
    school: "Lincoln High School",
    city: "Los Angeles",
    teamSize: "18",
    email: "coach@example.org",
    phone: "+1 213 555 0100",
    notes: "We practice Tuesdays & Thursdays <after 4pm>.",
    turnstileToken: "ok",
    honeypot: "",
    ...over,
  }
}

/** All captured sendOutbound envelopes (this route never uses sendOtp/sendTransactional). */
function outbounds(mailer: FakeMailer): OutboundEmail[] {
  return mailer.sent.map((m) => m.outbound).filter((o): o is OutboundEmail => o !== undefined)
}

describe("POST /forms/home-turf", () => {
  it("accepts a valid submit (200 {ok:true}) and sends notification + confirmation", async () => {
    const { app, mailer } = await makeHarness()
    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const sent = outbounds(mailer)
    expect(sent).toHaveLength(2)

    // (1) The notification: env-default from/to, replyTo the submitter, subject names the school,
    // and the body carries every field (HTML-escaped in the html part).
    const notify = sent[0]!
    expect(notify.from).toBe("donotreply@civfix.org")
    expect(notify.to).toBe("roman@reachoutla.org")
    expect(notify.replyTo).toBe("coach@example.org")
    expect(notify.subject).toBe("Home Turf sign-up: Lincoln High School")
    for (const value of [
      "Alex Rivera",
      "Head Coach",
      "Lincoln High School",
      "Los Angeles",
      "18",
      "coach@example.org",
      "+1 213 555 0100",
    ]) {
      expect(notify.text).toContain(value)
    }
    expect(notify.text).toContain("We practice Tuesdays & Thursdays <after 4pm>.")
    // User values are HTML-escaped in the html body (no raw angle brackets from the notes).
    expect(notify.html).toContain("&lt;after 4pm&gt;")
    expect(notify.html).not.toContain("<after 4pm>")

    // (2) The confirmation: FIXED COPY ONLY (M8). The recipient comes from the request body, so any
    // request-derived CONTENT would make this endpoint a phishing amplifier that sends attacker-written
    // prose from civfix's own DKIM-signed domain. Nothing submitted is echoed back.
    const confirm = sent[1]!
    expect(confirm.from).toBe("donotreply@civfix.org")
    expect(confirm.to).toBe("coach@example.org")
    expect(confirm.subject).toBe("We got your Home Turf sign-up")
    expect(confirm.text).toContain("roman@reachoutla.org")
    expect(confirm.text).toContain("The civfix team")
    for (const value of [
      "Alex Rivera",
      "Head Coach",
      "Lincoln High School",
      "Los Angeles",
      "+1 213 555 0100",
      "We practice Tuesdays & Thursdays <after 4pm>.",
    ]) {
      expect(confirm.text).not.toContain(value)
      expect(confirm.html).not.toContain(value)
    }
  })

  it("rejects a failed Turnstile with 403 TURNSTILE_FAILED and sends nothing", async () => {
    const { app, mailer } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload({ turnstileToken: "fail" }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe("TURNSTILE_FAILED")
    expect(mailer.sent).toHaveLength(0)
  })

  it("returns a FAKE success (200 {ok:true}) on a tripped honeypot and sends NO emails", async () => {
    const { app, mailer } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload({ honeypot: "http://spam.example" }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(0)
  })

  it("422s a validation failure (bad email) with the standard envelope and sends nothing", async () => {
    const { app, mailer } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload({ email: "not-an-email" }),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(mailer.sent).toHaveLength(0)
  })

  it("422s a missing required field (coachName)", async () => {
    const { app, mailer } = await makeHarness()
    const payload = formPayload()
    delete payload.coachName
    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload })
    expect(res.statusCode).toBe(422)
    expect(mailer.sent).toHaveLength(0)
  })

  it("422s an unknown key (strict schema)", async () => {
    const { app, mailer } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload({ unexpected: "nope" }),
    })
    expect(res.statusCode).toBe(422)
    expect(mailer.sent).toHaveLength(0)
  })

  it("accepts an omitted notes field (optional)", async () => {
    const { app, mailer } = await makeHarness()
    const payload = formPayload()
    delete payload.notes
    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload })
    expect(res.statusCode).toBe(200)
    expect(outbounds(mailer)).toHaveLength(2)
    expect(outbounds(mailer)[0]!.text).not.toContain("Notes")
  })

  it("5xxes when the notification send fails (and never sends the confirmation)", async () => {
    const { app, mailer } = await makeHarness()
    let calls = 0
    mailer.sendOutbound = () => {
      calls += 1
      return Promise.reject(new Error("smtp down"))
    }
    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })
    expect(res.statusCode).toBe(500)
    expect(calls).toBe(1)
  })

  it("still 200s when only the CONFIRMATION send fails (best-effort)", async () => {
    const { app, mailer } = await makeHarness()
    const original = mailer.sendOutbound.bind(mailer)
    let calls = 0
    mailer.sendOutbound = (email: OutboundEmail) => {
      calls += 1
      if (calls === 2) return Promise.reject(new Error("smtp down"))
      return original(email)
    }
    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    // Only the notification was captured (the confirmation attempt rejected).
    expect(outbounds(mailer)).toHaveLength(1)
    expect(outbounds(mailer)[0]!.to).toBe("roman@reachoutla.org")
  })

  /**
   * M8 ordering (routes-core MEDIUM + LOW/test-gap). The per-RECIPIENT daily cap is charged AFTER the
   * awaited coordinator send, not before it. Charging first meant a transient SMTP blip on step (4) still
   * consumed the submitter's entire 1/day budget, so their retry 429'd for 24 hours — a mailer hiccup
   * locked a legitimate coach out for a day. The old test stopped at the 5xx and never retried, so
   * neither the bug nor its fix was observable.
   */
  it("does NOT consume the 1/day recipient budget when the coordinator send fails (the retry still 200s)", async () => {
    const { app, mailer } = await makeHarness()
    const original = mailer.sendOutbound.bind(mailer)
    let calls = 0
    mailer.sendOutbound = (email: OutboundEmail) => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error("smtp down"))
      return original(email)
    }

    const failed = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(failed.statusCode).toBe(500)
    expect(outbounds(mailer)).toHaveLength(0)

    // The SAME address retries: the daily budget must still be intact.
    const retry = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual({ ok: true })

    // Exactly the retry's two envelopes were captured (the first attempt's notification rejected).
    const sent = outbounds(mailer)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.to).toBe("roman@reachoutla.org")
    expect(sent[1]!.to).toBe("coach@example.org")
  })

  it(`still charges the budget on SUCCESS: a same-address resubmit 429s (limit ${HOME_TURF_EMAIL_LIMIT_PER_DAY}/day)`, async () => {
    // The positive control for the reordering above: moving the charge later must not remove the cap.
    const { app, mailer } = await makeHarness()
    const first = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })
    expect(second.statusCode).toBe(429)
    expect(second.json().code).toBe("RATE_LIMITED")

    // ACCEPTED behavior change (A15): the cap now sits AFTER the coordinator notification, so a duplicate
    // submit sends that one internal email before 429ing. No CONFIRMATION reaches the submitter — the
    // request-addressed mail, which is the only thing this cap exists to bound, is still blocked.
    const sent = outbounds(mailer)
    expect(sent).toHaveLength(3)
    expect(sent.map((e) => e.to)).toEqual([
      "roman@reachoutla.org",
      "coach@example.org",
      "roman@reachoutla.org",
    ])

    // A different address is unaffected.
    const other = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload({ email: "other-coach@example.org" }),
    })
    expect(other.statusCode).toBe(200)
  })

  it(`has a dedicated per-route limit (429 within ${HOME_TURF_RATE_LIMIT.max + 2} hits from one IP)`, async () => {
    const { app } = await makeHarness()
    let saw429 = false
    for (let i = 0; i < HOME_TURF_RATE_LIMIT.max + 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/forms/home-turf",
        // A honeypot-tripped body keeps the handler outcome stable (200, no mail) so the signal is
        // purely the rate limiter.
        payload: formPayload({ honeypot: "bot" }),
        remoteAddress: "203.0.113.88",
      })
      if (res.statusCode === 429) {
        saw429 = true
        break
      }
    }
    expect(saw429).toBe(true)
  })
})

describe("enforceHomeTurfIpCap", () => {
  it(`allows ${HOME_TURF_IP_LIMIT_PER_HOUR} submissions per hour per IP and 429s the next`, async () => {
    const counters = new InMemoryCounterStore(() => 0)
    for (let i = 0; i < HOME_TURF_IP_LIMIT_PER_HOUR; i++) {
      await expect(enforceHomeTurfIpCap("198.51.100.7", counters)).resolves.toBeUndefined()
    }
    await expect(enforceHomeTurfIpCap("198.51.100.7", counters)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    // A different IP still has its own budget.
    await expect(enforceHomeTurfIpCap("198.51.100.8", counters)).resolves.toBeUndefined()
  })
})

describe("enforceHomeTurfRecipientCap (M8)", () => {
  it(`allows ${HOME_TURF_EMAIL_LIMIT_PER_DAY} confirmation per address per day and 429s the next`, async () => {
    const counters = new InMemoryCounterStore(() => 0)
    for (let i = 0; i < HOME_TURF_EMAIL_LIMIT_PER_DAY; i++) {
      await expect(enforceHomeTurfRecipientCap("victim@example.org", counters)).resolves.toBeUndefined()
    }
    // The per-IP cap does not protect the VICTIM (the attacker rotates IPs); this bucket does, because
    // it is keyed on the recipient address alone.
    await expect(enforceHomeTurfRecipientCap("victim@example.org", counters)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    await expect(enforceHomeTurfRecipientCap("someone-else@example.org", counters)).resolves.toBeUndefined()
  })

  it("normalizes case and surrounding whitespace so the bucket cannot be trivially varied", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    await enforceHomeTurfRecipientCap("Victim@Example.org", counters)
    await expect(enforceHomeTurfRecipientCap("  victim@example.ORG ", counters)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })
})

describe("home-turf abuse caps FAIL CLOSED (M8)", () => {
  it("refuses to send when no counter store is available (empty REDIS_URL, no override)", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const container = buildContainer(env)
    // No homeTurfOverrides.counters and no REDIS_URL: the caps used to be SILENTLY SKIPPED here,
    // leaving a public DKIM-signed-mail endpoint with no per-IP or per-recipient bound at all.
    const app = await buildServer({ env, container })
    current = { app, mailer: container.mailer as FakeMailer }

    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })

    expect(res.statusCode).toBeGreaterThanOrEqual(500)
    expect(outbounds(container.mailer as FakeMailer)).toHaveLength(0)
  })

  it("counts through container.getCounterStore() when Redis IS configured (one shared client)", async () => {
    // The route used to build its own RedisCounterStore, so container.close()'s reset of the shared client
    // protected nothing and each plugin held a separate one. Pin the wiring: with a Redis-configured
    // container and NO test override, both caps must count through the container's store.
    const env = loadEnv({ NODE_ENV: "test" })
    const counted: string[] = []
    // env WITHOUT Redis is what the server itself sees (so the limiter stays in-memory and no connection is
    // opened), while the CONTAINER reports a REDIS_URL — that is the branch production takes in counters().
    const container = {
      ...buildContainer(env),
      env: { ...env, REDIS_URL: "redis://cache:6379" },
      getCounterStore: () => ({
        incr: (key: string) => {
          counted.push(key)
          return Promise.resolve(1)
        },
      }),
    } as unknown as ReturnType<typeof buildContainer>
    const app = await buildServer({ env, container })
    current = { app, mailer: container.mailer as FakeMailer }

    const res = await app.inject({ method: "POST", url: "/forms/home-turf", payload: formPayload() })
    expect(res.statusCode).toBe(200)
    // Both buckets: the per-IP hourly cap and the per-recipient daily cap.
    expect(counted.some((k) => k.startsWith("abuse:home-turf:ip:"))).toBe(true)
    expect(counted.some((k) => k.includes("coach@example.org"))).toBe(true)
  })
})
