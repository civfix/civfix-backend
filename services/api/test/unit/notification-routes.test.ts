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
import {
  MARK_NOTIFICATIONS_READ_MAX_IDS,
  type NotificationServiceOverrides,
} from "../../src/routes/notifications.routes.js"
import { randomUUID } from "node:crypto"

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

  it("accepts a batch at the id cap and 422s one over it", async () => {
    const { app, token } = await makeHarness()
    const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID())

    const atCap = await app.inject({
      method: "POST",
      url: "/v1/notifications/read",
      headers: auth(token),
      payload: { ids: ids(MARK_NOTIFICATIONS_READ_MAX_IDS) },
    })
    expect(atCap.statusCode).toBe(200)

    const overCap = await app.inject({
      method: "POST",
      url: "/v1/notifications/read",
      headers: auth(token),
      payload: { ids: ids(MARK_NOTIFICATIONS_READ_MAX_IDS + 1) },
    })
    expect(overCap.statusCode).toBe(422)
    expect(overCap.json().code).toBe("VALIDATION")
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

  /**
   * H12 shape gate (routes-core HIGH). The shared contract types `deviceId` as a bare optional string, and
   * the server uses it to key a destructive cross-account write. A value that is not the client-generated
   * UUID is DROPPED (not rejected — rejecting would 422 older clients out of push entirely), so the repo
   * must see `deviceId: null`.
   *
   * The bug these pin: the payload was assembled as `{...body, ...(deviceId !== undefined ? {deviceId} : {})}`,
   * so whenever the normalizer dropped the value the raw string survived in the `{...body}` spread and the
   * service persisted it (`req.deviceId ?? null`). The gate has to REMOVE the field, not merely fail to
   * re-add it — and only a route-level assertion on what the repo stored can tell the two apart.
   */
  it("STRIPS a malformed deviceId ('*') before the service: the repo stores null", async () => {
    const { app, token, userId } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      headers: auth(token),
      payload: { platform: "ios", token: "device-token-wild", deviceId: "*" },
    })
    // Dropped, not rejected: the registration still succeeds.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    expect(current!.repo.pushTokens).toHaveLength(1)
    expect(current!.repo.pushTokens[0]).toMatchObject({
      userId,
      platform: "ios",
      token: "device-token-wild",
      deviceId: null,
    })
  })

  it("strips every other non-UUID deviceId shape (wildcards, oversized, sql-ish, empty)", async () => {
    const hostile = [
      "%",
      "' OR 1=1 --",
      "a".repeat(4096),
      "not-a-uuid",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301x", // a uuid with trailing junk
      "",
      "   ",
    ]
    for (const [i, deviceId] of hostile.entries()) {
      const { app, token } = await makeHarness()
      const res = await app.inject({
        method: "POST",
        url: "/v1/push/register",
        headers: auth(token),
        payload: { platform: "android", token: `tok-${i}`, deviceId },
      })
      expect(res.statusCode, deviceId.slice(0, 24)).toBe(200)
      expect(current!.repo.pushTokens[0]?.deviceId, deviceId.slice(0, 24)).toBeNull()
      await current!.app.close()
      current = undefined
    }
  })

  it("PRESERVES a well-formed uuid deviceId (normalized to trimmed lower case)", async () => {
    // The positive control for the gate above: it must not simply null everything.
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      headers: auth(token),
      payload: {
        platform: "ios",
        token: "device-token-good",
        deviceId: "  3F2504E0-4F89-11D3-9A0C-0305E82C3301 ",
      },
    })
    expect(res.statusCode).toBe(200)
    expect(current!.repo.pushTokens[0]?.deviceId).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301")
  })

  it("stores null when deviceId is omitted entirely (an older client)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      headers: auth(token),
      payload: { platform: "ios", token: "device-token-legacy" },
    })
    expect(res.statusCode).toBe(200)
    expect(current!.repo.pushTokens[0]?.deviceId).toBeNull()
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
