import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import type { FakePushSender } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryNotificationRepository } from "../helpers/notifications.js"
import type { NotificationServiceOverrides } from "../../src/routes/notifications.routes.js"

/**
 * Route-level tests for the notifications plugin, run with NO database: an in-memory
 * NotificationRepository is injected via buildServer(opts.notificationOverrides), the container's push seam
 * is the FakePushSender (USE_FAKE_PUSH on in test), and a full in-memory auth bundle gives the [auth]
 * routes a real bearer session. Exercised through app.inject. The Drizzle/PostGIS path is covered by the
 * Docker-gated integration test.
 */

interface Harness {
  app: FastifyInstance
  repo: InMemoryNotificationRepository
  push: FakePushSender
  mailer: FakeMailer
  token: string
  userId: string
}

let current: Harness | undefined

async function makeHarness(seed?: (repo: InMemoryNotificationRepository) => void): Promise<Harness> {
  const env = loadEnv({ NODE_ENV: "test" })

  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const verifier = new StubJwksVerifier()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier,
    now: () => Date.now(),
  })

  const repo = new InMemoryNotificationRepository()
  if (seed) seed(repo)
  const notificationOverrides: NotificationServiceOverrides = { repo }

  // The container's push seam is the FakePushSender in test; grab a handle so register-delegation asserts.
  const container = buildContainer(env)
  const push = container.pushSender as FakePushSender

  const app = await buildServer({ env, container, authServices, notificationOverrides })

  const { token, userId } = await signIn(app, mailer, "notif@example.com")

  const h: Harness = { app, repo, push, mailer, token, userId }
  current = h
  return h
}

async function signIn(
  app: FastifyInstance,
  mailer: FakeMailer,
  email: string,
): Promise<{ token: string; userId: string }> {
  await app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { "x-client": "mobile" },
    payload: { email, code },
  })
  const body = verify.json()
  return { token: body.token, userId: body.user.id }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

afterEach(async () => {
  if (current) {
    await current.app.close()
    current = undefined
  }
})

describe("GET /notifications", () => {
  it("lists the caller's notifications newest-first (auth)", async () => {
    const { app, token, userId } = await makeHarness()
    // Seed via the repo directly (as a triggering request would have).
    const { repo } = current!
    await repo.insertNotification({ userId, type: "system", title: "older", body: null, link: null })
    await repo.insertNotification({ userId, type: "system", title: "newer", body: null, link: null })

    const res = await app.inject({ method: "GET", url: "/v1/notifications", headers: auth(token) })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((n: { title: string }) => n.title)).toEqual(["newer", "older"])
  })

  it("401s anonymously", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/notifications" })
    expect(res.statusCode).toBe(401)
  })
})

describe("POST /notifications/read", () => {
  it("marks the given notifications read (auth)", async () => {
    const { app, token, userId } = await makeHarness()
    const { repo } = current!
    const n = await repo.insertNotification({
      userId,
      type: "system",
      title: "x",
      body: null,
      link: null,
    })

    const res = await app.inject({
      method: "POST",
      url: "/v1/notifications/read",
      headers: auth(token),
      payload: { ids: [n.id] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const list = await app.inject({ method: "GET", url: "/v1/notifications", headers: auth(token) })
    expect(list.json().items[0].read).toBe(true)
  })

  it("422s a non-UUID id", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/notifications/read",
      headers: auth(token),
      payload: { ids: ["not-a-uuid"] },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("GET + PUT /notifications/prefs", () => {
  it("default-creates prefs on first GET (all true, no quiet hours)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications/prefs",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      push: true,
      cleanupChat: true,
      reportUpdates: true,
      follows: true,
      mentions: true,
      postInteractions: true,
    })
  })

  it("applies a partial update and sets quiet hours", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/notifications/prefs",
      headers: auth(token),
      payload: { follows: false, quietHours: { start: "22:00", end: "07:00" } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.follows).toBe(false)
    expect(body.push).toBe(true)
    expect(body.mentions).toBe(true)
    expect(body.quietHours).toEqual({ start: "22:00", end: "07:00" })
  })

  it("toggles the dedicated mentions preference off", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/notifications/prefs",
      headers: auth(token),
      payload: { mentions: false },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.mentions).toBe(false)
    // Untouched toggles stay on.
    expect(body.push).toBe(true)
    expect(body.cleanupChat).toBe(true)
  })

  it("422s an unknown field (strict schema)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "PUT",
      url: "/v1/notifications/prefs",
      headers: auth(token),
      payload: { bogus: true },
    })
    expect(res.statusCode).toBe(422)
  })

  it("401s anonymously", async () => {
    const { app } = await makeHarness()
    expect((await app.inject({ method: "GET", url: "/v1/notifications/prefs" })).statusCode).toBe(401)
  })
})

describe("POST /push/register", () => {
  it("registers a push token (persists + delegates to the push seam)", async () => {
    const { app, token, push, userId } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      headers: auth(token),
      payload: { platform: "ios", token: "device-token-1", deviceId: "dev-1" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    // Persisted in the repo.
    expect(current!.repo.pushTokens).toHaveLength(1)
    expect(current!.repo.pushTokens[0]).toMatchObject({ userId, platform: "ios", token: "device-token-1" })
    // Delegated to the push seam.
    expect(push.tokens.some((t) => t.token === "device-token-1")).toBe(true)
  })

  it("422s a bad platform", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      headers: auth(token),
      payload: { platform: "blackberry", token: "x" },
    })
    expect(res.statusCode).toBe(422)
  })

  it("401s anonymously", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      payload: { platform: "ios", token: "x" },
    })
    expect(res.statusCode).toBe(401)
  })
})
