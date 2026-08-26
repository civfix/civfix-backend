import { describe, expect, it, beforeAll, afterAll } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeAbuseChecks, FakeMailer, FakeSmsSender } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { InMemoryGuestRsvpRepository } from "../helpers/guest-rsvp.js"

const EVENT_ID = "11111111-1111-1111-1111-111111111111"
let app: FastifyInstance
const repo = new InMemoryGuestRsvpRepository()

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "test" })
  repo.seedEvent({ id: EVENT_ID, title: "Beach cleanup" })
  repo.memberCounts.set(EVENT_ID, 2)
  app = await buildServer({
    env,
    container: buildContainer(env),
    guestRsvpOverrides: {
      repo,
      roleOf: () => Promise.resolve(null),
      cache: new InMemoryCacheClient(),
      counters: new InMemoryCounterStore(),
      mailer: new FakeMailer(),
      smsSender: new FakeSmsSender(),
      abuseChecks: new FakeAbuseChecks(),
    },
  })
})
afterAll(async () => { await app.close() })

describe("guest rsvp over HTTP", () => {
  it("accepts a real request body and merges the path id", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT_ID}/guest-rsvp/request`,
      payload: { name: "Ada", channel: "email", email: "ADA@Example.org", turnstileToken: "ok" },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ sent: true, resendAfterSec: 60 })
    expect(repo.otps[0]?.contact).toBe("ada@example.org")
  })

  it("422s a channel/contact mismatch at the boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${EVENT_ID}/guest-rsvp/request`,
      payload: { name: "Ada", channel: "sms", email: "a@b.co", turnstileToken: "ok" },
    })
    expect(res.statusCode).toBe(422)
  })

  it("requires auth on the host-only roster", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/cleanups/${EVENT_ID}/guests` })
    expect(res.statusCode).toBe(401)
  })

  it("404s an unknown manage token on cancel", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/guest-rsvp/cancel`,
      payload: { token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    })
    expect(res.statusCode).toBe(404)
  })
})
