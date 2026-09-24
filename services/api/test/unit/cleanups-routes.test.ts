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
import {
  CLEANUP_MEMBERSHIP_RATE_LIMIT,
  type CleanupServiceOverrides,
} from "../../src/routes/cleanups.routes.js"

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

  const container = buildContainer(env)
  const chat = container.chatService as FakeChatService

  const app = await buildServer({ env, container, authServices, cleanupOverrides })

  const email = "organizer@example.com"
  const { token, userId } = await signIn(app, mailer, email)
  repo.seedUser({ id: userId, displayName: "Organizer", handle: "org" })

  const h: Harness = { app, repo, chat, mailer, token, userId }
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

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
/** A start far enough back that the default 4 h window has already closed: the event reads as `done`. */
const ENDED = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

async function createCleanup(
  app: FastifyInstance,
  token: string,
  scheduledAt: string = FUTURE,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/cleanups",
    headers: auth(token),
    payload: {
      title: "Sweep",
      type: "site",
      lat: 34,
      lng: -118.49,
      scheduledAt,
      slots: [{ title: "Volunteers" }],
    },
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
        slots: [{ title: "Volunteers" }],
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
        slots: [{ title: "Volunteers" }],
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
      payload: {
        title: "Future sweep",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: FUTURE,
        slots: [{ title: "Volunteers" }],
      },
    })
    const res = await app.inject({ method: "GET", url: "/v1/cleanups?when=upcoming" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].title).toBe("Future sweep")
    expect(body.items[0].joined).toBe(false)
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
  it("GET /cleanups?near=<json> succeeds (200) and orders by distance, nearest first", async () => {
    const { app, token } = await makeHarness()
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Near",
        type: "site",
        lat: 34.01,
        lng: -118.49,
        scheduledAt: FUTURE,
        slots: [{ title: "Volunteers" }],
      },
    })
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Far",
        type: "site",
        lat: 35.5,
        lng: -118.49,
        scheduledAt: FUTURE,
        slots: [{ title: "Volunteers" }],
      },
    })

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
      payload: {
        title: "Inside",
        type: "site",
        lat: 34.0,
        lng: -118.49,
        scheduledAt: FUTURE,
        slots: [{ title: "Volunteers" }],
      },
    })
    await app.inject({
      method: "POST",
      url: "/v1/cleanups",
      headers: auth(token),
      payload: {
        title: "Outside",
        type: "site",
        lat: 40.0,
        lng: -74.0,
        scheduledAt: FUTURE,
        slots: [{ title: "Volunteers" }],
      },
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

    const joiner = await signIn(app, mailer, "joiner@example.com")

    const joinRes = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })
    expect(joinRes.statusCode).toBe(200)
    expect(joinRes.json()).toEqual({ joined: true, going: 2 })

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

  it("H12: RSVP flipping is bounded per identity and does not spend another account's budget", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token)
    const joiner = await signIn(app, mailer, "flipper@example.com")
    const bystander = await signIn(app, mailer, "bystander@example.com")

    const flip = (who: string, verb: "join" | "leave") =>
      app.inject({ method: "POST", url: `/v1/cleanups/${id}/${verb}`, headers: auth(who) })

    let blocked = false
    for (let i = 0; i < CLEANUP_MEMBERSHIP_RATE_LIMIT.max + 2 && !blocked; i++) {
      const res = await flip(joiner.token, i % 2 === 0 ? "join" : "leave")
      blocked = res.statusCode === 429
    }
    expect(blocked).toBe(true)

    const other = await flip(bystander.token, "join")
    expect(other.statusCode).toBe(200)
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

describe("POST /cleanups/:id/complete (the deprecated no-op)", () => {
  it("200s and returns the event unchanged (DECISIONS §40: the endpoint writes nothing)", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, ENDED)

    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: { note: "42 bags off the creek" },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("done")

    const timeline = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
    })
    expect(timeline.json().status).toBe("done")
  })

  it("is idempotent: a repeat is another 200 with the same status", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, ENDED)

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

  it("a COHOST may call it (B13) while a plain member gets 403", async () => {
    const { app, token, mailer, repo } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    const cohost = await signIn(app, mailer, "closer@example.com")
    const member = await signIn(app, mailer, "attendee@example.com")
    repo.seedUser({ id: cohost.userId, displayName: "Cory" })
    repo.seedUser({ id: member.userId, displayName: "Mel" })
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(cohost.token),
    })
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(member.token),
    })
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

    const asCohost = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(cohost.token),
      payload: {},
    })
    expect(asCohost.statusCode).toBe(200)
  })

  it("200s an event that has not started yet, and leaves it upcoming", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)

    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("upcoming")
  })

  it("200s a CANCELLED event and leaves it cancelled; cancelling an ENDED one still 409s (B18)", async () => {
    const { app, token } = await makeHarness()
    const cancelled = await createCleanup(app, token)
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
    expect(completeCancelled.statusCode).toBe(200)
    expect(completeCancelled.json().status).toBe("cancelled")

    const ended = await createCleanup(app, token, ENDED)
    const cancelEnded = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${ended}/cancel`,
      headers: auth(token),
      payload: {},
    })
    expect(cancelEnded.statusCode).toBe(409)
    expect(cancelEnded.json().code).toBe("CONFLICT")
  })

  it("401s an anonymous completion", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      payload: {},
    })
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

    await chat.persist({ cleanupId: id, userId, body: "first" })
    await chat.persist({ cleanupId: id, userId, body: "second" })

    const ok = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages`,
      headers: auth(token),
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.items.map((m: { body: string }) => m.body)).toEqual(["second", "first"])

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
      const id = await createCleanup(app, token)

      const joiner = await signIn(app, mailer, "joiner@example.com")
      repo.seedUser({ id: joiner.userId, displayName: "Jordan" })
      await app.inject({
        method: "POST",
        url: `/v1/cleanups/${id}/join`,
        headers: auth(joiner.token),
      })

      const anon = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/attendees` })
      expect(anon.statusCode).toBe(200)
      expect(anon.json()).toMatchObject({ scope: "following", attendees: [], going: 2 })

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

    const res = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/messages?around=${sent[2]!.id}&limit=2`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items.map((m: { body: string }) => m.body)).toEqual(["f4", "f3"])
    expect(body.nextCursor).toBe(sent[2]!.id)
    expect(body.prevCursor).toBe(sent[3]!.id)

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
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })

    const promote = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${joiner.userId}`,
      headers: auth(token),
      payload: { role: "cohost" },
    })
    expect(promote.statusCode).toBe(200)
    expect(promote.json()).toEqual({ ok: true })

    const roster = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/attendees`,
      headers: auth(joiner.token),
    })
    const jordan = (roster.json().attendees as { name: string; role: string }[]).find(
      (p) => p.name === "Jordan",
    )
    expect(jordan?.role).toBe("cohost")

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
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })

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
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })

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
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(joiner.token),
    })

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
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(cohost.token),
    })
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(member.token),
    })
    await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${cohost.userId}`,
      headers: auth(token),
      payload: { role: "cohost" },
    })

    const removeOrg = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${id}/members/${userId}`,
      headers: auth(cohost.token),
    })
    expect(removeOrg.statusCode).toBe(403)

    const removeMember = await app.inject({
      method: "DELETE",
      url: `/v1/cleanups/${id}/members/${member.userId}`,
      headers: auth(cohost.token),
    })
    expect(removeMember.statusCode).toBe(200)
    expect(removeMember.json()).toEqual({ ok: true, going: 2 })

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
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(cohost.token),
    })
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/join`,
      headers: auth(member.token),
    })
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

  it("409s joining an ENDED cleanup", async () => {
    const { app, token, mailer } = await makeHarness()
    const id = await createCleanup(app, token, ENDED)
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

  it("F067: freezes the title of an ENDED cleanup but still allows a description edit", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, ENDED)
    const frozen = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { title: "Renamed after the fact" },
    })
    expect(frozen.statusCode).toBe(409)
    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { description: "post-event recap" },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().description).toBe("post-event recap")
  })

  it("200s the deprecated complete on a CANCELLED cleanup without changing it", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, PAST)
    await cancel(app, token, id)
    const res = await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/complete`,
      headers: auth(token),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe("cancelled")
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
      payload: {
        title: "Just started",
        type: "site",
        lat: 34,
        lng: -118.49,
        scheduledAt: PAST,
        slots: [{ title: "Volunteers" }],
      },
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

  it("F067: 409s a full-object edit of an ENDED event that changes title/scheduledAt", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token, ENDED)
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { title: "Recorded", scheduledAt: ENDED },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe("GET /cleanups/:id/ics", () => {
  it("returns a calendar document for a public event, with no session", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)

    const res = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/ics` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ics: string; filename: string }
    expect(body.filename).toBe(`civfix-event-${id}.ics`)
    expect(body.ics.startsWith("BEGIN:VCALENDAR")).toBe(true)
    expect(body.ics).toContain("BEGIN:VEVENT")
    expect(body.ics).toContain(`UID:cleanup-${id}@civfix.org`)
    expect(body.ics).toContain("SUMMARY:Sweep")
    expect(body.ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true)
  })

  it("never links a production page when no web origin is configured", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)

    const res = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/ics` })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { ics: string }).ics).not.toContain("https://civfix.org/events/")
  })

  it("marks a cancelled event CANCELLED so a calendar client withdraws it", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    await app.inject({
      method: "POST",
      url: `/v1/cleanups/${id}/cancel`,
      headers: auth(token),
      payload: { reason: "storm" },
    })

    const res = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/ics` })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { ics: string }).ics).toContain("STATUS:CANCELLED")
  })

  it("404s an event that does not exist rather than emitting an empty calendar", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/cleanups/99999999-9999-4999-8999-999999999999/ics",
    })
    expect(res.statusCode).toBe(404)
  })

  describe("a claimed shift becomes the calendar entry", () => {
    const stamp = (iso: string): string => `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`

    async function eventWithClaimedShift(
      h: Harness,
    ): Promise<{ id: string; slotStart: string; slotEnd: string; eventEnd: string }> {
      const start = Date.parse(FUTURE)
      const slotStart = new Date(start + 60 * 60 * 1000).toISOString()
      const slotEnd = new Date(start + 2 * 60 * 60 * 1000).toISOString()
      const eventEnd = new Date(start + 4 * 60 * 60 * 1000).toISOString()
      const created = await h.app.inject({
        method: "POST",
        url: "/v1/cleanups",
        headers: auth(h.token),
        payload: {
          title: "Sweep",
          type: "site",
          lat: 34,
          lng: -118.49,
          scheduledAt: FUTURE,
          endsAt: eventEnd,
          slots: [{ title: "Morning sweep", startsAt: slotStart, endsAt: slotEnd }],
        },
      })
      const id = created.json().id as string
      const slotId = created.json().slots[0].id as string
      const claimed = await h.app.inject({
        method: "PUT",
        url: `/v1/cleanups/${id}/slot`,
        headers: auth(h.token),
        payload: { slotId },
      })
      expect(claimed.statusCode).toBe(200)
      return { id, slotStart, slotEnd, eventEnd }
    }

    it("uses the viewer's own shift for DTSTART/DTEND and suffixes the summary", async () => {
      const h = await makeHarness()
      const { id, slotStart, slotEnd } = await eventWithClaimedShift(h)

      const res = await h.app.inject({
        method: "GET",
        url: `/v1/cleanups/${id}/ics`,
        headers: auth(h.token),
      })
      expect(res.statusCode).toBe(200)
      const ics = (res.json() as { ics: string }).ics
      expect(ics).toContain(`DTSTART:${stamp(slotStart)}`)
      expect(ics).toContain(`DTEND:${stamp(slotEnd)}`)
      expect(ics).toContain("SUMMARY:Sweep (Morning sweep)")
    })

    it("gives anyone WITHOUT that claim the event's own window and plain title", async () => {
      const h = await makeHarness()
      const { id, eventEnd } = await eventWithClaimedShift(h)

      const res = await h.app.inject({ method: "GET", url: `/v1/cleanups/${id}/ics` })
      expect(res.statusCode).toBe(200)
      const ics = (res.json() as { ics: string }).ics
      expect(ics).toContain(`DTSTART:${stamp(FUTURE)}`)
      expect(ics).toContain(`DTEND:${stamp(eventEnd)}`)
      expect(ics).toContain("SUMMARY:Sweep")
      expect(ics).not.toContain("Morning sweep")
    })

    it("ignores an UNTIMED role: a role is not a calendar window", async () => {
      const h = await makeHarness()
      const created = await h.app.inject({
        method: "POST",
        url: "/v1/cleanups",
        headers: auth(h.token),
        payload: {
          title: "Sweep",
          type: "site",
          lat: 34,
          lng: -118.49,
          scheduledAt: FUTURE,
          slots: [{ title: "Grill" }],
        },
      })
      const id = created.json().id as string
      await h.app.inject({
        method: "PUT",
        url: `/v1/cleanups/${id}/slot`,
        headers: auth(h.token),
        payload: { slotId: created.json().slots[0].id },
      })

      const res = await h.app.inject({
        method: "GET",
        url: `/v1/cleanups/${id}/ics`,
        headers: auth(h.token),
      })
      const ics = (res.json() as { ics: string }).ics
      expect(ics).toContain(`DTSTART:${stamp(FUTURE)}`)
      expect(ics).toContain("SUMMARY:Sweep")
      expect(ics).not.toContain("Grill")
    })
  })

  it("rides the event visibility gate: a private event 404s for a stranger", async () => {
    const { app, token } = await makeHarness()
    const id = await createCleanup(app, token)
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}`,
      headers: auth(token),
      payload: { visibility: "private" },
    })
    expect(patched.statusCode).toBe(200)

    const anonymous = await app.inject({ method: "GET", url: `/v1/cleanups/${id}/ics` })
    expect(anonymous.statusCode).toBe(404)

    const host = await app.inject({
      method: "GET",
      url: `/v1/cleanups/${id}/ics`,
      headers: auth(token),
    })
    expect(host.statusCode).toBe(200)
  })
})

describe("PATCH /cleanups/:id/members/:userId: the assignable roles", () => {
  async function seededEvent(): Promise<{ h: Harness; id: string; memberId: string }> {
    const h = await makeHarness()
    const id = await createCleanup(h.app, h.token)
    const memberId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
    h.repo.seedUser({ id: memberId, displayName: "Ada", handle: "ada" })
    h.repo.members.push({ cleanupId: id, userId: memberId, role: "member" })
    return { h, id, memberId }
  }

  it("accepts staff at the boundary: the contract enum carries it", async () => {
    const { h, id, memberId } = await seededEvent()
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${memberId}`,
      headers: auth(h.token),
      payload: { role: "staff" },
    })
    expect(res.statusCode).toBe(200)
    expect(await h.repo.roleOf(id, memberId)).toBe("staff")
  })

  it("still refuses organizer: ownership moves by transfer, never by a role cell", async () => {
    const { h, id, memberId } = await seededEvent()
    const res = await h.app.inject({
      method: "PATCH",
      url: `/v1/cleanups/${id}/members/${memberId}`,
      headers: auth(h.token),
      payload: { role: "organizer" },
    })
    expect(res.statusCode).toBe(422)
    expect(await h.repo.roleOf(id, memberId)).toBe("member")
  })
})
