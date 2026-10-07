import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import type { Container } from "../../src/di.js"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
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
  webBaseUrl: "http://localhost:3000",
  apiBaseUrl: "http://localhost:8080",
  eventUpdatePerEventPerHour: 3,
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function build(): Promise<{ app: FastifyInstance; writes: () => number }> {
  const repo = new InMemoryBroadcastRepository()
  let writes = 0
  repo.recordUnsubscribe = () => {
    writes += 1
    return Promise.reject(new Error("connection terminated"))
  }
  const broadcasts = makeBroadcastService({
    repo,
    counters: new InMemoryCounterStore(),
    config: CONFIG,
    mailer: new FakeMailer(),
    enqueuePlan: () => Promise.resolve(),
  })
  const instance = Fastify({ logger: false })
  instance.setErrorHandler(makeErrorHandler())
  instance.setNotFoundHandler(makeNotFoundHandler())
  instance.decorate("broadcastOverrides", { runtime: { broadcasts } as unknown as CommsRuntime })
  await registerUnsubscribeRoutes(instance, {
    env: { NODE_ENV: "test", WEB_ORIGINS: ["http://localhost:3000"] },
  } as unknown as Container)
  await instance.ready()
  app = instance
  return { app: instance, writes: () => writes }
}

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

describe("one-click unsubscribe when the opt-out cannot be stored", () => {
  it("answers a verified token with a retryable 503, not a false success", async () => {
    const { app: instance, writes } = await build()

    const res = await instance.inject({
      method: "POST",
      url: "/v1/broadcasts/unsubscribe",
      payload: { token: validToken() },
    })

    expect(writes()).toBe(1)
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      message: "We couldn't save your unsubscribe. Please try again.",
    })
  })

  it("keeps answering 200 for tokens it cannot verify, so the failure is no validity oracle", async () => {
    const { app: instance, writes } = await build()
    const forged = mintUnsubscribeToken(
      {
        subjectKind: "user",
        subjectId: USER,
        cleanupId: EVENT,
        expiresAtMs: unsubscribeExpiryFrom(Date.now()),
      },
      "a-completely-different-signing-key-1234567890",
    )

    for (const payload of [
      { token: forged },
      { token: "not-a-token-at-all-but-long-enough" },
      {},
    ]) {
      const res = await instance.inject({
        method: "POST",
        url: "/v1/broadcasts/unsubscribe",
        payload,
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).toBe('{"ok":true}')
    }
    expect(writes()).toBe(0)
  })
})

describe("the mail-client link redirect without a configured web origin", () => {
  it("lands on localhost, never on the production site", async () => {
    const repo = new InMemoryBroadcastRepository()
    const broadcasts = makeBroadcastService({
      repo,
      counters: new InMemoryCounterStore(),
      config: CONFIG,
      mailer: new FakeMailer(),
      enqueuePlan: () => Promise.resolve(),
    })
    const instance = Fastify({ logger: false })
    instance.decorate("broadcastOverrides", { runtime: { broadcasts } as unknown as CommsRuntime })
    await registerUnsubscribeRoutes(instance, {
      env: { NODE_ENV: "development", WEB_ORIGINS: [] },
    } as unknown as Container)
    await instance.ready()
    app = instance

    const res = await instance.inject({ method: "GET", url: "/v1/broadcasts/unsubscribe" })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe("http://localhost:3000/unsubscribe")
  })
})
