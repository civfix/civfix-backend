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
// An already-started event: the only kind a host may mark complete (B14's time gate).
const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()

/** Create a cleanup as the organizer and return its id. Defaults to a future date. */
async function createCleanup(
  app: FastifyInstance,
  token: string,
  scheduledAt: string = FUTURE,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cleanups",
    headers: auth(token),
    payload: { title: "Sweep", type: "site", lat: 34, lng: -118.49, scheduledAt },
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

  it("treats a non-UUID id as a reference code (resolve-either): unknown code -> 404", async () => {
    // Issue #56 resolve-either: GET /cleanups/:id accepts a UUID OR an EVENT reference_code. A non-UUID id
    // is no longer a 422 — it is looked up by reference_code, and an unknown one is NOT_FOUND.
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/cleanups/EVENT-42-999999" })
    expect(res.statusCode).toBe(404)
  })

  it("resolves a cleanup by its EVENT reference_code and surfaces referenceCode on the DTO", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const byId = await app.inject({ method: "GET", url: `/v1/cleanups/${id}` })
    const refCode = byId.json().referenceCode as string
    expect(refCode).toMatch(/^EVENT-\d+-\d{6}$/)
    const byCode = await app.inject({ method: "GET", url: `/v1/cleanups/${refCode}` })
    expect(byCode.statusCode).toBe(200)
    expect(byCode.json().id).toBe(id)
    expect(byCode.json().referenceCode).toBe(refCode)
  })

  it("422s an over-long id (still validated)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: `/v1/cleanups/${"x".repeat(65)}` })
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

describe("POST /cleanups/:id/cancel (host cancel)", () => {
  it("the organizer cancels: 200 with status 'cancelled' and the event drops off the upcoming list", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)

    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(token),
      payload: { reason: "Rained out" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("cancelled")

    // The cancelled event is excluded from the upcoming list (unlisted automatically).
    const list = await app.inject({ method: "GET", url: "/v1/cleanups?when=upcoming" })
    expect((list.json().items as { id: string }[]).some((c) => c.id === id)).toBe(false)
  })

  it("cancels with no reason (empty body) -> 200", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("cancelled")
  })

  it("403s a non-organizer", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token)
    const stranger = await signIn(app, mailer, "stranger@example.com")
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(stranger.token),
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe("FORBIDDEN")
  })

  it("401s an anonymous cancel", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({ method: "POST", url: `/v1/cleanups/${id}/cancel`, payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it("404s cancelling a missing cleanup", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups/00000000-0000-0000-0000-000000000000/cancel",
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it("422s an unknown body key (strict schema)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(token),
      payload: { nope: "x" },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("POST /cleanups/:id/complete (host completion)", () => {
  it("the organizer completes an already-started event: 200 with status 'done'", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)

    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: { note: "42 bags off the creek" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("done")
  })

  it("completes with no note (empty body) -> 200, and a repeat is idempotent", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)

    const first = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().status).toBe("done")
  })

  it("a COHOST can complete (B13) while a plain member gets 403", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    const cohost = await signIn(app, mailer, "closer@example.com")
    const member = await signIn(app, mailer, "attendee@example.com")
    repo.seedUser({ id: cohost.userId, displayName: "Cory" })
    repo.seedUser({ id: member.userId, displayName: "Mel" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(cohost.token) })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(member.token) })
    await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${cohost.userId}`,
      headers: auth(token),
      payload: { role: "cohost" },
    })

    const asMember = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(member.token),
      payload: {},
    })
    expect(asMember.statusCode).toBe(403)

    // Unlike cancel (organizer-only), completion is open to the cohost — the person who then logs hours.
    const asCohost = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(cohost.token),
      payload: {},
    })
    expect(asCohost.statusCode).toBe(200)
    expect(asCohost.json().status).toBe("done")
  })

  it("409s an event that hasn't started yet (B14's time anchor)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)

    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
  })

  it("409s completing a CANCELLED event, and 409s cancelling a COMPLETED one (B18)", async () => {
    const { app, token } = await makeHarness()
    const cancelled = await createCleanup(app, token, PAST)
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${cancelled}/cancel`,
      headers: auth(token),
      payload: {},
    })
    const completeCancelled = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${cancelled}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(completeCancelled.statusCode).toBe(409)

    // The other direction: host completion is forward-only, so cancel is not a way back out of it.
    const completed = await createCleanup(app, token, PAST)
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${completed}/complete`,
      headers: auth(token),
      payload: {},
    })
    const cancelCompleted = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${completed}/cancel`,
      headers: auth(token),
      payload: {},
    })
    expect(cancelCompleted.statusCode).toBe(409)
    expect(cancelCompleted.json().code).toBe("CONFLICT")
  })

  it("401s an anonymous completion", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    const res = await app.inject({ method: "POST", url: `/v1/cleanups/${id}/complete`, payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it("404s completing a missing cleanup", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups/00000000-0000-0000-0000-000000000000/complete",
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it("422s an unknown body key (strict schema)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: { nope: "x" },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
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

  it("P2 2.4: around-mode returns the centered window with prevCursor through the chat seam", async () => {
    const { app, token, userId, chat } = await makeHarness()
    const id = await createCleanup(app, token)
    const sent = []
    for (let i = 1; i <= 5; i++) {
      sent.push(await chat.persist({ cleanupId: id, userId, body: `f${i}` }))
    }

    // limit 2 around f3: ceil(2/2)=1 at-or-older (f3 itself) + floor(2/2)=1 newer (f4), newest-first.
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages?around=${sent[2]!.id}&limit=2`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.map((m: { body: string }) => m.body)).toEqual(["f4", "f3"])
    expect(body.nextCursor).toBe(sent[2]!.id) // f2/f1 remain older
    expect(body.prevCursor).toBe(sent[3]!.id) // f5 remains newer

    // Before-mode responses stay byte-identical: NO prevCursor key at all.
    const plain = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages?limit=2`,
      headers: auth(token),
    })
    expect(plain.statusCode).toBe(200)
    expect("prevCursor" in plain.json()).toBe(false)
  })

  it("P2 2.4: around + before together -> 422 (mutually exclusive)", async () => {
    const { app, token, userId, chat } = await makeHarness()
    const id = await createCleanup(app, token)
    const msg = await chat.persist({ cleanupId: id, userId, body: "only" })
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages?around=${msg.id}&before=${msg.id}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("P2 2.4: around an id that is not in the room -> 404", async () => {
    const { app, token, userId, chat } = await makeHarness()
    const id = await createCleanup(app, token)
    await chat.persist({ cleanupId: id, userId, body: "here" })
    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages?around=00000000-0000-4000-8000-000000000000`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
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

describe("WS4 member management: PATCH + DELETE /cleanups/:id/members/:userId", () => {
  it("the organizer promotes then demotes a member (200 {ok:true}); role shows on attendees", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token)

    const joiner = await signIn(app, mailer, "joiner@example.com")
    repo.seedUser({ id: joiner.userId, displayName: "Jordan" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(joiner.token) })

    const promote = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      headers: auth(token),
      payload: { role: "cohost" },
    })
    expect(promote.statusCode).toBe(200)
    expect(promote.json()).toEqual({ ok: true })

    // The roster row now carries the cohost role (AttendeeDTO.role).
    const roster = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/attendees`,
      headers: auth(joiner.token),
    })
    const jordan = (roster.json().attendees as { name: string; role: string }[]).find(
      (p) => p.name === "Jordan",
    )
    expect(jordan?.role).toBe("cohost")

    // And the detail DTO surfaces the viewer's own role.
    const detail = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}`,
      headers: auth(joiner.token),
    })
    expect(detail.json().myRole).toBe("cohost")

    const demote = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      headers: auth(token),
      payload: { role: "member" },
    })
    expect(demote.statusCode).toBe(200)
    expect(demote.json()).toEqual({ ok: true })
  })

  it("403s a non-organizer promoting (organizer-only, D3) and 401s anonymous", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token)
    const joiner = await signIn(app, mailer, "joiner@example.com")
    repo.seedUser({ id: joiner.userId, displayName: "Jordan" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(joiner.token) })

    const asMember = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      headers: auth(joiner.token),
      payload: { role: "cohost" },
    })
    expect(asMember.statusCode).toBe(403)

    const anon = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      payload: { role: "cohost" },
    })
    expect(anon.statusCode).toBe(401)
  })

  it("422s a bad role value and 404s a non-member target", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token)
    const joiner = await signIn(app, mailer, "joiner@example.com")
    repo.seedUser({ id: joiner.userId, displayName: "Jordan" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(joiner.token) })

    const badRole = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      headers: auth(token),
      payload: { role: "organizer" },
    })
    expect(badRole.statusCode).toBe(422)
    expect(badRole.json().code).toBe("VALIDATION")

    const notMember = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/99999999-9999-9999-9999-999999999999`,
      headers: auth(token),
      payload: { role: "cohost" },
    })
    expect(notMember.statusCode).toBe(404)
  })

  it("DELETE removes an attendee (200 {ok, going}); the removed user loses chat access", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token)
    const joiner = await signIn(app, mailer, "joiner@example.com")
    repo.seedUser({ id: joiner.userId, displayName: "Jordan" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(joiner.token) })

    // Pre-removal the member can read the room history.
    const before = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages`,
      headers: auth(joiner.token),
    })
    expect(before.statusCode).toBe(200)

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, going: 1 })

    // The same cleanup_members row gated chat: history is now 403 for the removed user.
    const after = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages`,
      headers: auth(joiner.token),
    })
    expect(after.statusCode).toBe(403)
  })

  it("a cohost can DELETE a plain member but not another cohost; nobody removes the organizer", async () => {
    const { app, token, userId, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token)
    const cohost = await signIn(app, mailer, "cohost@example.com")
    const member = await signIn(app, mailer, "member@example.com")
    repo.seedUser({ id: cohost.userId, displayName: "Cory" })
    repo.seedUser({ id: member.userId, displayName: "Mel" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(cohost.token) })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(member.token) })
    await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${cohost.userId}`,
      headers: auth(token),
      payload: { role: "cohost" },
    })

    // Cohost removing the organizer: 403.
    const removeOrg = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${id}/members/${userId}`,
      headers: auth(cohost.token),
    })
    expect(removeOrg.statusCode).toBe(403)

    // Cohost removes the plain member: 200, going drops to 2.
    const removeMember = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${id}/members/${member.userId}`,
      headers: auth(cohost.token),
    })
    expect(removeMember.statusCode).toBe(200)
    expect(removeMember.json()).toEqual({ ok: true, going: 2 })

    // A plain (non-member now) user removing the cohost: 403.
    const asStranger = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${id}/members/${cohost.userId}`,
      headers: auth(member.token),
    })
    expect(asStranger.statusCode).toBe(403)
  })

  it("a cohost can PATCH the event body (edit) while a member gets 403", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token)
    const cohost = await signIn(app, mailer, "cohost@example.com")
    const member = await signIn(app, mailer, "member@example.com")
    repo.seedUser({ id: cohost.userId, displayName: "Cory" })
    repo.seedUser({ id: member.userId, displayName: "Mel" })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(cohost.token) })
    await app.inject({ method: "POST", url: `/v1/cleanups/${id}/join`, headers: auth(member.token) })
    await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${cohost.userId}`,
      headers: auth(token),
      payload: { role: "cohost" },
    })

    const asCohost = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(cohost.token),
      payload: { title: "Retitled by cohost" },
    })
    expect(asCohost.statusCode).toBe(200)
    expect(asCohost.json().title).toBe("Retitled by cohost")
    expect(asCohost.json().myRole).toBe("cohost")

    const asMember = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(member.token),
      payload: { title: "Nope" },
    })
    expect(asMember.statusCode).toBe(403)

    // Cancel stays organizer-only: the cohost gets 403.
    const cancelAsCohost = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(cohost.token),
      payload: {},
    })
    expect(cancelAsCohost.statusCode).toBe(403)
  })
})

describe("cleanup state machine + scheduledAt bounds", () => {
  const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const YEAR_9999 = "9999-12-31T00:00:00.000Z"

  async function cancel(app: FastifyInstance, token: string, id: string): Promise<void> {
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(token),
      payload: {},
    })
  }

  async function complete(app: FastifyInstance, token: string, id: string): Promise<void> {
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
  }

  it("409s joining a CANCELLED cleanup (CVX-019)", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token)
    await cancel(app, token, id)
    const joiner = await signIn(app, mailer, "latejoiner@example.com")
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
  })

  it("409s joining a COMPLETED cleanup", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    await complete(app, token, id)
    const joiner = await signIn(app, mailer, "postjoiner@example.com")
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(res.statusCode).toBe(409)
  })

  it("409s editing a CANCELLED cleanup (CVX-007)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    await cancel(app, token, id)
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { title: "Edited after cancel" },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe("CONFLICT")
  })

  it("still allows a cosmetic edit on a COMPLETED cleanup (roster stays frozen)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    await complete(app, token, id)
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { title: "Renamed after the fact" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().title).toBe("Renamed after the fact")
  })

  it("409s completing a CANCELLED cleanup", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    await cancel(app, token, id)
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(409)
  })

  it("still allows join and edit on an UPCOMING cleanup (no over-restriction)", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token)
    const joiner = await signIn(app, mailer, "goodjoiner@example.com")
    const join = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(join.statusCode).toBe(200)
    const edit = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { title: "Still editable" },
    })
    expect(edit.statusCode).toBe(200)
    expect(edit.json().title).toBe("Still editable")
  })

  it("422s a create with a far-past scheduledAt (CVX-006)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Backdated",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: THIRTY_DAYS_AGO,
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
    expect(res.json().fields.scheduledAt).toBeDefined()
  })

  it("422s a create with an absurd future scheduledAt (year 9999)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Millennium",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: YEAR_9999,
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().fields.scheduledAt).toBeDefined()
  })

  it("still accepts a recently-started event within the backdate grace (201)", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: { title: "Just started", type: "site", lat: 34, lng: -118.49, scheduledAt: PAST },
    })
    expect(res.statusCode).toBe(201)
  })

  it("422s moving an existing event's scheduledAt into the absurd future", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const toFar = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { scheduledAt: YEAR_9999 },
    })
    expect(toFar.statusCode).toBe(422)
  })

  it("lets a full-object edit of a COMPLETED event re-submit its own past scheduledAt (200)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    await complete(app, token, id)
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { title: "Recorded", scheduledAt: PAST },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().title).toBe("Recorded")
  })
})
