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
import { clientQuery } from "../helpers/query.js"
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

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString()

/** Create a cleanup as the organizer and return its id. */
async function createCleanup(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cleanups",
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
      url: "/v1/cleanups",
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
      url: "/v1/cleanups",
      payload: { title: "x", type: "site", lat: 1, lng: 1, scheduledAt: FUTURE },
    })
    expect(res.statusCode).toBe(401)
  })

  // Regression for the "Host an event" 500: replays the BYTE-EXACT payload the mobile host-event form
  // builds (app/host-event.tsx onPublish) — title, type "site", lat/lng, an ISO scheduledAt, the
  // "name the spot" address line, a description, and a bring[] checklist. The whole valid host payload
  // must create the cleanup and return 201 (the organizer auto-joins; address/bring/description echo
  // back). The DB-backed createCleanupTx for this same shape is covered by the Docker-gated integration
  // test (cleanups-chat-pg.test.ts).
  it("creates a cleanup from the exact mobile host-event payload (201)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Saturday beach sweep",
        type: "site",
        lat: 34.0195,
        lng: -118.4912,
        scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        address: "North gate, by the oak",
        description: "Bring water and sunscreen.",
        bring: ["gloves", "bags", "grabbers"],
      },
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.joined).toBe(true)
    expect(dto.going).toBe(1)
    expect(dto.status).toBe("upcoming")
    expect(dto.address).toBe("North gate, by the oak")
    expect(dto.description).toBe("Bring water and sunscreen.")
    expect(dto.bring).toEqual(["gloves", "bags", "grabbers"])
  })

  it("422s a malformed body (bad type)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
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
      url: "/v1/cleanups",
      headers: auth(token),
      payload: { title: "Future sweep", type: "site", lat: 34, lng: -118.49, scheduledAt: FUTURE },
    })
    const res = await app.inject({ method: "GET", url: "/v1/cleanups?when=upcoming" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].title).toBe("Future sweep")
    expect(body.items[0].joined).toBe(false) // anonymous viewer
  })

  it("gets one cleanup and 404s a missing one", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const got = await app.inject({ method: "GET", url: `/v1/cleanups/${id}` })
    expect(got.statusCode).toBe(200)
    expect(got.json().id).toBe(id)

    const missing = await app.inject({
      method: "GET",
      url: "/v1/cleanups/00000000-0000-0000-0000-000000000000",
    })
    expect(missing.statusCode).toBe(404)
  })

  it("422s a non-UUID id", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/cleanups/not-a-uuid" })
    expect(res.statusCode).toBe(422)
  })
})

describe("GET /cleanups query encoding (the previously-422 client calls)", () => {
  // The shared client serializes near/bbox as a single JSON-encoded object param. These tests build the
  // query exactly as the client's buildQuery does (clientQuery) and prove the backend now parses it.
  it("GET /cleanups?near=<json> succeeds (200) and orders by distance, nearest first", async () => {
    const { app, token } = await makeHarness()
    // Two cleanups at different distances from the query point.
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: { title: "Near", type: "site", lat: 34.01, lng: -118.49, scheduledAt: FUTURE },
    })
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: { title: "Far", type: "site", lat: 35.5, lng: -118.49, scheduledAt: FUTURE },
    })

    // near as the client sends it: ?near=%7B%22lat%22%3A34%2C%22lng%22%3A-118.49%7D
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups${clientQuery({ near: { lat: 34.0, lng: -118.49 }, when: "upcoming" })}`,
    })
    expect(res.statusCode).toBe(200)
    const items = res.json().items as { title: string }[]
    expect(items.map((i) => i.title)).toEqual(["Near", "Far"])
  })

  it("GET /cleanups?bbox=<json> succeeds (200) and filters to the box", async () => {
    const { app, token } = await makeHarness()
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: { title: "Inside", type: "site", lat: 34.0, lng: -118.49, scheduledAt: FUTURE },
    })
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: { title: "Outside", type: "site", lat: 40.0, lng: -74.0, scheduledAt: FUTURE },
    })

    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups${clientQuery({
        bbox: { west: -119, south: 33, east: -118, north: 35 },
        when: "upcoming",
      })}`,
    })
    expect(res.statusCode).toBe(200)
    const items = res.json().items as { title: string }[]
    expect(items.map((i) => i.title)).toEqual(["Inside"])
  })

  it("422s a malformed (non-JSON) near param", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/cleanups?near=not-json" })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
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
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(joinRes.statusCode).toBe(200)
    expect(joinRes.json()).toEqual({ joined: true, going: 2 })

    // Re-join is idempotent: still going=2.
    const rejoin = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(rejoin.json()).toEqual({ joined: true, going: 2 })

    const leaveRes = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/leave`,
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
      url: `/v1/cleanups/${id}/leave`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
  })

  it("404s joining a missing cleanup", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups/00000000-0000-0000-0000-000000000000/join",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous join", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join` })
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
      url: `/v1/cleanups/${id}/messages`,
      headers: auth(token),
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.items.map((m: { body: string }) => m.body)).toEqual(["second", "first"])

    // A non-member (a freshly signed-in stranger) gets 403.
    const stranger = await signIn(app, mailer, "stranger@example.com")
    const forbidden = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages`,
      headers: auth(stranger.token),
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().code).toBe("FORBIDDEN")
  })

  it("401s anonymous history", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/messages` })
    expect(res.statusCode).toBe(401)
  })

  describe("GET /cleanups/:id/attendees (who's going, anon-ok)", () => {
    it("scopes the roster to the viewer: follows-only until you RSVP, everyone after", async () => {
      const { app, token, userId, repo, mailer } = await makeHarness()
      const id = await createCleanup(app, token) // organizer (userId) auto-joins; going = 1

      // A second user RSVPs (seed their person row so the name resolves).
      const joiner = await signIn(app, mailer, "joiner@example.com")
      repo.seedUser({ id: joiner.userId, displayName: "Jordan" })
      await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(joiner.token) })

      // Anonymous viewer: no names, but the real going count.
      const anon = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/attendees` })
      expect(anon.statusCode).toBe(200)
      expect(anon.json()).toMatchObject({ scope: "following", attendees: [], going: 2 })

      // A non-member who follows the organizer sees ONLY the organizer (follows-only gate).
      const stranger = await signIn(app, mailer, "stranger@example.com")
      repo.seedFollow(stranger.userId, userId)
      const asStranger = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${id}/attendees`,
        headers: auth(stranger.token),
      })
      expect(asStranger.statusCode).toBe(200)
      const sBody = asStranger.json()
      expect(sBody.scope).toBe("following")
      expect(sBody.going).toBe(2)
      expect(sBody.attendees.map((p: { name: string }) => p.name)).toEqual(["Organizer"])
      expect(sBody.attendees[0].isFollowing).toBe(true)

      // The joiner (a member) sees EVERYONE going, organizer first.
      const asJoiner = await app.inject({
        method: "GET",
        url: `/v1/cleanups/${id}/attendees`,
        headers: auth(joiner.token),
      })
      const jBody = asJoiner.json()
      expect(jBody.scope).toBe("all")
      expect(jBody.attendees.map((p: { name: string }) => p.name)).toEqual(["Organizer", "Jordan"])
    })

    it("404s a missing cleanup", async () => {
      const { app } = await makeHarness()
      const res = await app.inject({
        method: "GET",
        url: "/v1/cleanups/00000000-0000-0000-0000-000000000000/attendees",
      })
      expect(res.statusCode).toBe(404)
    })
  })

  it("P2: tolerates an extra `cleanupId` query key (the shared client's redundant path-param echo)", async () => {
    const { app, token, userId, chat } = await makeHarness()
    const id = await createCleanup(app, token)
    await chat.persist({ cleanupId: id, userId, body: "hello" })

    // The shared typed client serializes a GET's input as BOTH path params and query, so it sends
    // ?cleanupId=<id> on top of the URL path. A strict schema would 400; we accept + ignore it and the
    // request still parses + returns history. (We send cleanupId AND before to prove both keys are fine.)
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages?cleanupId=${id}&limit=10`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((m: { body: string }) => m.body)).toEqual(["hello"])
  })
})
