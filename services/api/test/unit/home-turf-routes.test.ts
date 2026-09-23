import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import type { FakeMailer, FakeAbuseChecks } from "@civfix/shared/fakes"
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

interface Harness {
  app: FastifyInstance
  mailer: FakeMailer
  container: ReturnType<typeof buildContainer>
}

let current: Harness | undefined

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

const NOTIFY_TO = "home-turf@civfix.test"

async function makeHarness(over: Record<string, string> = {}): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test", HOME_TURF_NOTIFY_TO: NOTIFY_TO, ...over })
  const container = buildContainer(env)
  const app = await buildServer({
    env,
    container,
    homeTurfOverrides: { counters: new InMemoryCounterStore(() => 0) },
  })
  const h: Harness = { app, mailer: container.mailer as FakeMailer, container }
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

function outbounds(mailer: FakeMailer): OutboundEmail[] {
  return mailer.sent.map((m) => m.outbound).filter((o): o is OutboundEmail => o !== undefined)
}

describe("POST /forms/home-turf", () => {
  it("accepts a valid submit (200 {ok:true}) and sends notification + confirmation", async () => {
    const { app, mailer } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const sent = outbounds(mailer)
    expect(sent).toHaveLength(2)

    const notify = sent[0]!
    expect(notify.from).toBe("donotreply@civfix.org")
    expect(notify.to).toBe(NOTIFY_TO)
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
    expect(notify.html).toContain("&lt;after 4pm&gt;")
    expect(notify.html).not.toContain("<after 4pm>")

    const confirm = sent[1]!
    expect(confirm.from).toBe("donotreply@civfix.org")
    expect(confirm.to).toBe("coach@example.org")
    expect(confirm.subject).toBe("We got your Home Turf sign-up")
    expect(confirm.text).toContain(NOTIFY_TO)
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

  it("is DISABLED when HOME_TURF_NOTIFY_TO is unset: 409, no mail, and NOT a captured 5xx", async () => {
    const { app, mailer } = await makeHarness({ HOME_TURF_NOTIFY_TO: "" })
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(res.statusCode).toBe(409)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.json().code).toBe("CONFLICT")
    expect(outbounds(mailer)).toHaveLength(0)
  })

  it("5xxes when the notification send fails (and never sends the confirmation)", async () => {
    const { app, mailer } = await makeHarness()
    let calls = 0
    mailer.sendOutbound = () => {
      calls += 1
      return Promise.reject(new Error("smtp down"))
    }
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
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
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(outbounds(mailer)).toHaveLength(1)
    expect(outbounds(mailer)[0]!.to).toBe(NOTIFY_TO)
  })

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

    const retry = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual({ ok: true })

    const sent = outbounds(mailer)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.to).toBe(NOTIFY_TO)
    expect(sent[1]!.to).toBe("coach@example.org")
  })

  it(`still charges the budget on SUCCESS: a same-address resubmit 429s (limit ${HOME_TURF_EMAIL_LIMIT_PER_DAY}/day)`, async () => {
    const { app, mailer } = await makeHarness()
    const first = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(second.statusCode).toBe(429)
    expect(second.json().code).toBe("RATE_LIMITED")

    const sent = outbounds(mailer)
    expect(sent).toHaveLength(3)
    expect(sent.map((e) => e.to)).toEqual([NOTIFY_TO, "coach@example.org", NOTIFY_TO])

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
    await expect(enforceHomeTurfIpCap("198.51.100.8", counters)).resolves.toBeUndefined()
  })
})

describe("Turnstile action (F128)", () => {
  it("verifies the token with the 'home-turf' widget action", async () => {
    const { app, container } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(res.statusCode).toBe(200)
    expect((container.abuseChecks as FakeAbuseChecks).lastVerifyExpect?.action).toBe("home-turf")
  })
})

describe("enforceHomeTurfRecipientCap (M8)", () => {
  it(`allows ${HOME_TURF_EMAIL_LIMIT_PER_DAY} confirmation per address per day and 429s the next`, async () => {
    const counters = new InMemoryCounterStore(() => 0)
    for (let i = 0; i < HOME_TURF_EMAIL_LIMIT_PER_DAY; i++) {
      await expect(
        enforceHomeTurfRecipientCap("victim@example.org", counters),
      ).resolves.toBeUndefined()
    }
    await expect(enforceHomeTurfRecipientCap("victim@example.org", counters)).rejects.toMatchObject(
      {
        code: "RATE_LIMITED",
      },
    )
    await expect(
      enforceHomeTurfRecipientCap("someone-else@example.org", counters),
    ).resolves.toBeUndefined()
  })

  it("normalizes case and surrounding whitespace so the bucket cannot be trivially varied", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    await enforceHomeTurfRecipientCap("Victim@Example.org", counters)
    await expect(
      enforceHomeTurfRecipientCap("  victim@example.ORG ", counters),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
  })

  it("folds gmail +tags, dots and googlemail into one recipient bucket (F138)", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    await enforceHomeTurfRecipientCap("victim@gmail.com", counters)
    await expect(
      enforceHomeTurfRecipientCap("victim+abc@gmail.com", counters),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    await expect(
      enforceHomeTurfRecipientCap("v.i.c.t.i.m@googlemail.com", counters),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" })
  })

  it("strips +tags for non-gmail providers, but keeps dots significant (F138)", async () => {
    const counters = new InMemoryCounterStore(() => 0)
    await enforceHomeTurfRecipientCap("victim@example.org", counters)
    await expect(
      enforceHomeTurfRecipientCap("victim+1@example.org", counters),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
    })
    await expect(
      enforceHomeTurfRecipientCap("v.ictim@example.org", counters),
    ).resolves.toBeUndefined()
  })
})

describe("home-turf abuse caps FAIL CLOSED (M8)", () => {
  it("refuses to send when no counter store is available (empty REDIS_URL, no override)", async () => {
    const env = loadEnv({ NODE_ENV: "test", HOME_TURF_NOTIFY_TO: NOTIFY_TO })
    const container = buildContainer(env)
    const app = await buildServer({ env, container })
    current = { app, mailer: container.mailer as FakeMailer, container }

    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(500)
    expect(outbounds(container.mailer as FakeMailer)).toHaveLength(0)
  })

  it("counts through container.getCounterStore() when Redis IS configured (one shared client)", async () => {
    const env = loadEnv({ NODE_ENV: "test", HOME_TURF_NOTIFY_TO: NOTIFY_TO })
    const counted: string[] = []
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
    current = { app, mailer: container.mailer as FakeMailer, container }

    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: formPayload(),
    })
    expect(res.statusCode).toBe(200)
    expect(counted.some((k) => k.startsWith("abuse:home-turf:ip:"))).toBe(true)
    expect(counted.some((k) => k.startsWith("abuse:home-turf:email:"))).toBe(true)
    expect(counted.every((k) => !k.includes("coach@example.org"))).toBe(true)
  })
})
