import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Container } from "../../src/di.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { registerUnsubscribeRoutes } from "../../src/routes/host/unsubscribe.routes.js"
import { InMemoryBroadcastRepository } from "../helpers/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import {
  mintUnsubscribeToken,
  unsubscribeExpiryFrom,
} from "../../src/services/host/broadcast-capability-token.js"
import type { CommsRuntime } from "../../src/services/host/comms-wiring.js"

const EVENT = "00000000-0000-0000-0000-0000000000ee"
const USER = "00000000-0000-0000-0000-0000000000aa"
const KEY = "unsubscribe-signing-key-for-tests-0123456789"

const CONFIG: BroadcastConfig = {
  killSwitch: false,
  perEventPerDay: 3,
  recipientsPerDay: 2000,
  cooldownSec: 900,
  minAccountAgeHours: 24,
  maxRecipients: 5000,
  chunkSize: 200,
  emailConcurrency: 4,
  emailRatePerSec: 10,
  linkAllowedHosts: [],
  mailFromEvents: "events@civfix.org",
  unsubscribeSigningKey: KEY,
  webBaseUrl: "https://civfix.org",
  apiBaseUrl: "https://api.civfix.org",
  eventUpdatePerEventPerHour: 3,
}

let app: FastifyInstance | undefined

async function build(): Promise<{ app: FastifyInstance; repo: InMemoryBroadcastRepository }> {
  const repo = new InMemoryBroadcastRepository()
  const broadcasts = makeBroadcastService({
    repo,
    counters: new InMemoryCounterStore(),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan: () => Promise.resolve(),
  })
  const instance = Fastify()
  instance.decorate("broadcastOverrides", { runtime: { broadcasts } as unknown as CommsRuntime })
  await registerUnsubscribeRoutes(instance, {
    env: { WEB_ORIGINS: ["https://civfix.org"] },
  } as unknown as Container)
  await instance.ready()
  app = instance
  return { app: instance, repo }
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

function validToken(): string {
  return mintUnsubscribeToken(
    {
      subjectKind: "user",
      subjectId: USER,
      cleanupId: EVENT,
      expiresAtMs: unsubscribeExpiryFrom(Date.now()),
    },
    KEY,
  )
}

describe("POST /v1/broadcasts/unsubscribe", () => {
  it("accepts a JSON body", async () => {
    const { app: instance } = await build()
    const res = await instance.inject({
      method: "POST",
      url: "/v1/broadcasts/unsubscribe",
      payload: { token: validToken() },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it("accepts a form-urlencoded body, which is what mail clients send", async () => {
    const { app: instance } = await build()
    const res = await instance.inject({
      method: "POST",
      url: "/v1/broadcasts/unsubscribe",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(validToken())}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it("accepts the token from the query string", async () => {
    const { app: instance } = await build()
    const res = await instance.inject({
      method: "POST",
      url: `/v1/broadcasts/unsubscribe?t=${encodeURIComponent(validToken())}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    })
    expect(res.statusCode).toBe(200)
  })

  it("answers byte-identically for valid, expired, forged, absent and already-unsubscribed", async () => {
    const { app: instance } = await build()
    const expired = mintUnsubscribeToken(
      { subjectKind: "user", subjectId: USER, cleanupId: EVENT, expiresAtMs: Date.now() - 1000 },
      KEY,
    )
    const forged = mintUnsubscribeToken(
      {
        subjectKind: "user",
        subjectId: USER,
        cleanupId: EVENT,
        expiresAtMs: unsubscribeExpiryFrom(Date.now()),
      },
      "a-completely-different-signing-key-1234567890",
    )
    const bodies: Array<Record<string, unknown>> = [
      { token: validToken() },
      { token: validToken() },
      { token: expired },
      { token: forged },
      { token: "not-a-token-at-all-but-long-enough" },
      {},
    ]
    const responses = []
    for (const payload of bodies) {
      responses.push(
        await instance.inject({ method: "POST", url: "/v1/broadcasts/unsubscribe", payload }),
      )
    }
    const bodyTexts = new Set(responses.map((r) => r.body))
    const codes = new Set(responses.map((r) => r.statusCode))
    expect(codes).toEqual(new Set([200]))
    expect(bodyTexts.size).toBe(1)
    expect([...bodyTexts][0]).toBe('{"ok":true}')
  })

  it("records the unsubscribe for a valid token only", async () => {
    const { app: instance, repo } = await build()
    await instance.inject({
      method: "POST",
      url: "/v1/broadcasts/unsubscribe",
      payload: { token: validToken() },
    })
    const bulk = await repo.audiencePage({
      cleanupId: EVENT,
      segment: { kind: "all_registered" },
      kind: "host_broadcast",
      afterMember: null,
      afterGuest: null,
      limit: 10,
    })
    expect(bulk.members).toEqual([])
  })
})

describe("GET /v1/broadcasts/unsubscribe", () => {
  it("302s a mail-client link click to the web confirmation page, carrying the token", async () => {
    const { app: instance } = await build()
    const token = validToken()
    const res = await instance.inject({
      method: "GET",
      url: `/v1/broadcasts/unsubscribe?t=${encodeURIComponent(token)}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      `https://civfix.org/unsubscribe?t=${encodeURIComponent(token)}`,
    )
  })

  it("does NOT unsubscribe on the GET: opening a link is not a one-click confirmation", async () => {
    const { app: instance, repo } = await build()
    await instance.inject({
      method: "GET",
      url: `/v1/broadcasts/unsubscribe?t=${encodeURIComponent(validToken())}`,
    })
    const bulk = await repo.audiencePage({
      cleanupId: EVENT,
      segment: { kind: "all_registered" },
      kind: "host_broadcast",
      afterMember: null,
      afterGuest: null,
      limit: 10,
    })
    expect(bulk.members).toEqual([])
  })

  it("redirects to the bare page when there is no token, revealing nothing", async () => {
    const { app: instance } = await build()
    const res = await instance.inject({ method: "GET", url: "/v1/broadcasts/unsubscribe" })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("https://civfix.org/unsubscribe")
  })

  it("reads the registry key `t` and nothing else, and never trusts a malformed one", async () => {
    const { app: instance } = await build()
    const token = validToken()
    const wrongKey = await instance.inject({
      method: "GET",
      url: `/v1/broadcasts/unsubscribe?token=${encodeURIComponent(token)}`,
    })
    expect(wrongKey.headers.location).toBe("https://civfix.org/unsubscribe")

    const tooShort = await instance.inject({
      method: "GET",
      url: "/v1/broadcasts/unsubscribe?t=nope",
    })
    expect(tooShort.statusCode).toBe(302)
    expect(tooShort.headers.location).toBe("https://civfix.org/unsubscribe")

    const extraParams = await instance.inject({
      method: "GET",
      url: `/v1/broadcasts/unsubscribe?t=${encodeURIComponent(token)}&utm_source=mail`,
    })
    expect(extraParams.headers.location).toBe(
      `https://civfix.org/unsubscribe?t=${encodeURIComponent(token)}`,
    )
  })
})
