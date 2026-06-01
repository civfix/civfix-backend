import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import type { FakeChatService } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"
import type { CleanupServiceOverrides } from "../../src/routes/cleanups.routes.js"

/**
 * Route-level tests for the cleanups plugin, run with NO database: an in-memory CleanupRepository is
 * injected via buildServer(opts.cleanupOverrides) and a full in-memory auth bundle gives [auth] routes a
 * real bearer session. GET /cleanups/:id/messages reads through the container's chat seam (the
 * FakeChatService, into which the test persists messages). Exercised through app.inject. The
 * Drizzle/PostGIS path is covered by the Docker-gated integration test.
 */

interface Harness {
  app: FastifyInstance
  repo: InMemoryCleanupRepository
  chat: FakeChatService
  mailer: FakeMailer
  token: string
  userId: string
}

let current: Harness | undefined

async function makeHarness(seed?: (repo: InMemoryCleanupRepository) => void): Promise<Harness> {
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

  const repo = new InMemoryCleanupRepository()
  if (seed) seed(repo)
  const cleanupOverrides: CleanupServiceOverrides = { repo }

  // Default container has USE_FAKE_CHAT on in test, so container.chatService is a FakeChatService; grab a
  // typed handle to it so the history test can persist messages the route then reads back.
  const container = buildContainer(env)
  const chat = container.chatService as FakeChatService

  const app = await buildServer({ env, container, authServices, cleanupOverrides })

  // Sign in (organizer) through the real OTP flow (mobile -> bearer token in the body).
  const email = "organizer@example.com"
  const { token, userId } = await signIn(app, mailer, email)
  // Register the signed-in user in the cleanup repo so the organizer person join resolves.
  repo.seedUser({ id: userId, displayName: "Organizer", handle: "org" })

  const h: Harness = { app, repo, chat, mailer, token, userId }
  current = h
  return h
}

/** Sign a user in via the OTP flow and return their bearer token + id. */
async function signIn(
  app: FastifyInstance,
  mailer: FakeMailer,
  email: string,
): Promise<{ token: string; userId: string }> {
  await app.inject({ method: "POST", url: "/auth/otp/request", payload: { email } })
  const code = mailer.lastOtpFor(email)!
  const verify = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
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

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString()

/** Create a cleanup as the organizer and return its id. */
async function createCleanup(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/cleanups",
    headers: auth(token),
    payload: { title: "Sweep", type: "site", lat: 34, lng: -118.49, scheduledAt: FUTURE },
  })
  return res.json().id
}

describe("POST /cleanups", () => {
  it("creates a cleanup (organizer auto-joins) and returns 201 CleanupDTO", async () => {
    const { app, token, userId } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/cleanups",
      headers: auth(token),
      payload: {
        title: "Saturday beach sweep",
        type: "site",
        lat: 34.0,
        lng: -118.49,
        scheduledAt: FUTURE,
        bring: ["gloves"],
        address: "Lifeguard tower 26",
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.joined).toBe(true)
    expect(dto.going).toBe(1)
    expect(dto.status).toBe("upcoming")
    expect(dto.organizer.id).toBe(userId)
    expect(dto.address).toBe("Lifeguard tower 26")
    expect(dto.bring).toEqual(["gloves"])
  })

  it("401s an anonymous create", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/cleanups",
      payload: { title: "x", type: "site", lat: 1, lng: 1, scheduledAt: FUTURE },
    })
    expect(res.statusCode).toBe(401)
  })

  it("422s a malformed body (bad type)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/cleanups",
      headers: auth(token),
      payload: { title: "x", type: "spaceship", lat: 1, lng: 1, scheduledAt: FUTURE },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("GET /cleanups and /cleanups/:id", () => {
  it("lists upcoming cleanups (anon-ok)", async () => {
    const { app, token } = await makeHarness()
    await app.inject({
      method: "POST",
      url: "/cleanups",
      headers: auth(token),
      payload: { title: "Future sweep", type: "site", lat: 34, lng: -118.49, scheduledAt: FUTURE },
    })
    const res = await app.inject({ method: "GET", url: "/cleanups?when=upcoming" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].title).toBe("Future sweep")
    expect(body.items[0].joined).toBe(false) // anonymous viewer
  })

  it("gets one cleanup and 404s a missing one", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const got = await app.inject({ method: "GET", url: `/cleanups/${id}` })
    expect(got.statusCode).toBe(200)
    expect(got.json().id).toBe(id)

    const missing = await app.inject({
      method: "GET",
      url: "/cleanups/00000000-0000-0000-0000-000000000000",
    })
    expect(missing.statusCode).toBe(404)
  })

  it("422s a non-UUID id", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/cleanups/not-a-uuid" })
    expect(res.statusCode).toBe(422)
  })
})

describe("POST /cleanups/:id/join and /leave", () => {
  it("a second user joins then leaves; going reflects it", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token)

    // Sign in a SECOND user (the joiner) for real via OTP.
    const joiner = await signIn(app, mailer, "joiner@example.com")

    const joinRes = await app.inject({
      method: "POST",
      url: `/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(joinRes.statusCode).toBe(200)
    expect(joinRes.json()).toEqual({ joined: true, going: 2 })

    // Re-join is idempotent: still going=2.
    const rejoin = await app.inject({
      method: "POST",
      url: `/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(rejoin.json()).toEqual({ joined: true, going: 2 })

    const leaveRes = await app.inject({
      method: "POST",
      url: `/cleanups/${id}/leave`,
      headers: auth(joiner.token),
    })
    expect(leaveRes.statusCode).toBe(200)
    expect(leaveRes.json()).toEqual({ joined: false, going: 1 })
  })

  it("the organizer cannot leave their own cleanup (409)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({
      method: "POST",
      url: `/cleanups/${id}/leave`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
  })

  it("404s joining a missing cleanup", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/cleanups/00000000-0000-0000-0000-000000000000/join",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous join", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({ method: "POST", url: `/cleanups/${id}/join` })
    expect(res.statusCode).toBe(401)
  })
})

describe("GET /cleanups/:id/messages (member-gated history)", () => {
  it("returns history to a member and 403s a non-member", async () => {
    const { app, token, userId, chat, mailer } = await makeHarness()
    const id = await createCleanup(app, token)

    // Persist two messages into the container's chat seam (as the gateway would).
    await chat.persist({ cleanupId: id, userId, body: "first" })
    await chat.persist({ cleanupId: id, userId, body: "second" })

    // The organizer (a member) can read history, newest-first.
    const ok = await app.inject({
      method: "GET",
      url: `/cleanups/${id}/messages`,
      headers: auth(token),
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.items.map((m: { body: string }) => m.body)).toEqual(["second", "first"])

    // A non-member (a freshly signed-in stranger) gets 403.
    const stranger = await signIn(app, mailer, "stranger@example.com")
    const forbidden = await app.inject({
      method: "GET",
      url: `/cleanups/${id}/messages`,
      headers: auth(stranger.token),
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().code).toBe("FORBIDDEN")
  })

  it("401s anonymous history", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({ method: "GET", url: `/cleanups/${id}/messages` })
    expect(res.statusCode).toBe(401)
  })
})
