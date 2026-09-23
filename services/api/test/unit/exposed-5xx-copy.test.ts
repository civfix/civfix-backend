import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import { registerUnsubscribeRoutes } from "../../src/routes/host/unsubscribe.routes.js"
import { makeServer } from "../../src/server.js"
import {
  mintUnsubscribeToken,
  unsubscribeExpiryFrom,
} from "../../src/services/host/broadcast-capability-token.js"
import { InMemoryBroadcastRepository } from "../helpers/host/broadcast-repository.memory.js"
import {
  makeBroadcastService,
  type BroadcastConfig,
} from "../../src/services/host/broadcast-service.js"
import type { CommsRuntime } from "../../src/services/host/comms-wiring.js"

vi.mock("../../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/env.js")>()
  return { ...actual, isProd: () => true }
})

const SIGNING_KEY = "unsubscribe-signing-key-for-tests-0123456789"

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

describe("5xx copy written for the people who see it survives production masking", () => {
  it("tells a home-turf coach the form is temporarily unavailable", async () => {
    const env = loadEnv({ NODE_ENV: "test", HOME_TURF_NOTIFY_TO: "home-turf@civfix.test" })
    app = await makeServer({ env, container: makeContainer(env) })

    const res = await app.inject({
      method: "POST",
      url: "/forms/home-turf",
      payload: {
        coachName: "Alex Rivera",
        role: "Head Coach",
        school: "Lincoln High School",
        city: "Los Angeles",
        teamSize: "18",
        email: "coach@example.org",
        phone: "+1 213 555 0100",
        notes: "Tuesdays",
        turnstileToken: "ok",
        honeypot: "",
      },
    })

    expect(res.statusCode, res.body).toBe(500)
    expect(res.json()).toMatchObject({
      message: "This form is temporarily unavailable. Please try again later.",
    })
  })

  it("tells a one-click unsubscriber to try again", async () => {
    const repo = new InMemoryBroadcastRepository()
    repo.recordUnsubscribe = () => Promise.reject(new Error("connection terminated"))
    const config = {
      killSwitch: false,
      unsubscribeSigningKey: SIGNING_KEY,
      webBaseUrl: "http://localhost:3000",
      apiBaseUrl: "http://localhost:8080",
    } as unknown as BroadcastConfig
    const broadcasts = makeBroadcastService({
      repo,
      counters: new InMemoryCounterStore(),
      config,
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
    const token = mintUnsubscribeToken(
      {
        subjectKind: "user",
        subjectId: "00000000-0000-0000-0000-0000000000aa",
        cleanupId: "00000000-0000-0000-0000-0000000000ee",
        expiresAtMs: unsubscribeExpiryFrom(Date.now()),
      },
      SIGNING_KEY,
    )

    const res = await instance.inject({
      method: "POST",
      url: "/v1/broadcasts/unsubscribe",
      payload: { token },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      message: "We couldn't save your unsubscribe. Please try again.",
    })
  })
})
