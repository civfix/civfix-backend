import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemorySocialRepository, makeCleanupRecord } from "../helpers/social.js"
import type { SocialServiceOverrides } from "../../src/routes/social.routes.js"
import type { SocialNotifier, PersonView } from "../../src/services/social-service.js"


class SpyNotifier implements SocialNotifier {
  readonly calls: Array<{ followeeId: string; follower: PersonView }> = []
  onNewFollower(args: { followeeId: string; follower: PersonView }): Promise<void> {
    this.calls.push(args)
    return Promise.resolve()
  }
}

interface Harness {
  app: FastifyInstance
  repo: InMemorySocialRepository
  notifier: SpyNotifier
  mailer: FakeMailer
  token: string
  userId: string
}

let current: Harness | undefined

async function makeHarness(seed?: (repo: InMemorySocialRepository) => void): Promise<Harness> {
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

  const repo = new InMemorySocialRepository()
  if (seed) seed(repo)
  const notifier = new SpyNotifier()
  const socialOverrides: SocialServiceOverrides = { repo, notifier }

  const app = await buildServer({ env, authServices, socialOverrides })

  const { token, userId } = await signIn(app, mailer, "viewer@example.com")
  repo.seedUser({ id: userId, displayName: "Viewer", handle: "viewer" })

  const h: Harness = { app, repo, notifier, mailer, token, userId }
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

const OTHER = "44444444-4444-4444-4444-444444444444"
const THIRD = "55555555-5555-5555-5555-555555555555"

describe("GET /people", () => {
  it("401s an anonymous request (auth required)", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Other Person", handle: "other" })
    })
    const res = await app.inject({ method: "GET", url: "/v1/people?q=oth" })
    expect(res.statusCode).toBe(401)
  })

  it("422s a missing/blank q (never enumerates all users)", async () => {
    const { app, token } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Other Person", handle: "other" })
    })
    const noQ = await app.inject({ method: "GET", url: "/v1/people", headers: auth(token) })
    expect(noQ.statusCode).toBe(422)
    const blankQ = await app.inject({ method: "GET", url: "/v1/people?q=%20", headers: auth(token) })
    expect(blankQ.statusCode).toBe(422)
  })

  it("filters by q, excludes the signed-in viewer, and attaches an avatar gradient", async () => {
    const { app, token, userId } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Zelda", handle: "zelda" })
    })
    const hit = await app.inject({ method: "GET", url: "/v1/people?q=zel", headers: auth(token) })
    expect(hit.statusCode).toBe(200)
    const body = hit.json()
    const ids = body.items.map((p: { id: string }) => p.id)
    expect(ids).toEqual([OTHER])
    expect(ids).not.toContain(userId)
    expect(body.items[0].avatar).toHaveLength(2)

    const miss = await app.inject({ method: "GET", url: "/v1/people?q=nobody", headers: auth(token) })
    expect(miss.json().items).toEqual([])
  })

  it("422s a bad limit", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/people?q=zel&limit=999", headers: auth(token) })
    expect(res.statusCode).toBe(422)
  })
})

describe("POST /people/:id/follow and DELETE", () => {
  it("follows a person (200), returns the new count, and fires the new_follower hook", async () => {
    const { app, token, notifier } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Target" })
    })
    const res = await app.inject({
      method: "POST",
      url: `/v1/people/${OTHER}/follow`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ isFollowing: true, followers: 1 })
    expect(notifier.calls).toHaveLength(1)
    expect(notifier.calls[0]!.followeeId).toBe(OTHER)
  })

  it("unfollows a person (200) and returns the decremented count", async () => {
    const { app, token } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Target" })
    })
    await app.inject({ method: "POST", url: `/v1/people/${OTHER}/follow`, headers: auth(token) })
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/people/${OTHER}/follow`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ isFollowing: false, followers: 0 })
  })

  it("422s following yourself", async () => {
    const { app, token, userId } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/v1/people/${userId}/follow`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("404s following a non-existent person", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/v1/people/00000000-0000-0000-0000-000000000000/follow",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous follow", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Target" })
    })
    const res = await app.inject({ method: "POST", url: `/v1/people/${OTHER}/follow` })
    expect(res.statusCode).toBe(401)
  })
})

describe("GET /people/:id (profile)", () => {
  it("returns a public profile (anon-ok) with stats + pastEvents", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Pro", handle: "pro", bio: "organizer" })
      repo.seedReports(OTHER, 2, 1)
      repo.seedCleanup(makeCleanupRecord({ organizerUserId: OTHER, title: "Past sweep" }))
    })
    const res = await app.inject({ method: "GET", url: `/v1/people/${OTHER}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.profile.id).toBe(OTHER)
    expect(body.profile.stats).toEqual({ reports: 2, fixed: 1, cleanups: 1 })
    expect(body.profile.pastEvents.map((e: { title: string }) => e.title)).toEqual(["Past sweep"])
    expect(body.profile.isFollowing).toBe(false)
  })

  it("reflects isFollowing for the signed-in viewer", async () => {
    const { app, token } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Pro" })
    })
    await app.inject({ method: "POST", url: `/v1/people/${OTHER}/follow`, headers: auth(token) })
    const res = await app.inject({ method: "GET", url: `/v1/people/${OTHER}`, headers: auth(token) })
    expect(res.json().profile.isFollowing).toBe(true)
  })

  it("404s a missing profile", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/people/00000000-0000-0000-0000-000000000000",
    })
    expect(res.statusCode).toBe(404)
  })

  it("resolves a non-UUID :id as an @handle (handle deep link)", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Pro", handle: "pro_neighbor" })
    })
    const res = await app.inject({ method: "GET", url: "/v1/people/Pro_Neighbor" })
    expect(res.statusCode).toBe(200)
    expect(res.json().profile.handle).toBe("pro_neighbor")
    expect(res.json().profile.id).toBe(OTHER)
  })

  it("404s an unknown @handle", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/people/nobody_here" })
    expect(res.statusCode).toBe(404)
  })
})

describe("GET /people/:id/followers and /following", () => {
  for (const rel of ["followers", "following"] as const) {
    it(`${rel}: resolves a non-UUID :id as an @handle (same body as the UUID form)`, async () => {
      const { app } = await makeHarness((repo) => {
        repo.seedUser({ id: OTHER, displayName: "Pro", handle: "pro_neighbor" })
        repo.seedUser({ id: THIRD, displayName: "Other" })
        if (rel === "followers") repo.seedFollow(THIRD, OTHER)
        else repo.seedFollow(OTHER, THIRD)
      })
      const byHandle = await app.inject({ method: "GET", url: `/v1/people/Pro_Neighbor/${rel}` })
      const byUuid = await app.inject({ method: "GET", url: `/v1/people/${OTHER}/${rel}` })
      expect(byHandle.statusCode).toBe(200)
      expect(byUuid.statusCode).toBe(200)
      expect(byHandle.json()).toEqual(byUuid.json())
      expect(byHandle.json().items.map((p: { id: string }) => p.id)).toEqual([THIRD])
    })

    it(`${rel}: 404s a garbage :id that is neither a UUID nor a known handle (not 500)`, async () => {
      const { app } = await makeHarness()
      const res = await app.inject({ method: "GET", url: `/v1/people/not-a-real-id/${rel}` })
      expect(res.statusCode).toBe(404)
    })

    it(`${rel}: 404s an unknown UUID instead of answering an empty list`, async () => {
      const { app } = await makeHarness()
      const res = await app.inject({ method: "GET", url: `/v1/people/${OTHER}/${rel}` })
      expect(res.statusCode).toBe(404)
    })

    it(`${rel}: 404s a soft-deleted user's UUID, so a tombstoned account is not enumerable`, async () => {
      const { app } = await makeHarness((repo) => {
        repo.seedUser({ id: OTHER, displayName: "Gone", handle: "gone", deletedAt: new Date() })
        repo.seedUser({ id: THIRD, displayName: "Other" })
        if (rel === "followers") repo.seedFollow(THIRD, OTHER)
        else repo.seedFollow(OTHER, THIRD)
      })
      const res = await app.inject({ method: "GET", url: `/v1/people/${OTHER}/${rel}` })
      expect(res.statusCode).toBe(404)
    })

    it(`${rel}: 404s an over-length non-UUID :id before hitting the handle lookup`, async () => {
      const longRef = "a".repeat(41)
      const { app } = await makeHarness((repo) => {
        repo.seedUser({ id: OTHER, displayName: "Pro", handle: longRef })
      })
      const res = await app.inject({ method: "GET", url: `/v1/people/${longRef}/${rel}` })
      expect(res.statusCode).toBe(404)
    })
  }
})

describe("GET /me/profile", () => {
  it("returns the signed-in user's own profile", async () => {
    const { app, token, userId } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/me/profile", headers: auth(token) })
    expect(res.statusCode).toBe(200)
    expect(res.json().profile.id).toBe(userId)
    expect(res.json().profile.isFollowing).toBe(false)
  })

  it("401s anonymously", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/me/profile" })
    expect(res.statusCode).toBe(401)
  })
})

describe("GET /users/follow-suggestions", () => {
  const ORGANIZER = "55555555-5555-5555-5555-555555555555"

  it("401s an anonymous request (auth required)", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/v1/users/follow-suggestions" })
    expect(res.statusCode).toBe(401)
  })

  it("returns ranked suggestions (organizers first), excluding self and already-followed users", async () => {
    const { app, repo, token, userId } = await makeHarness((r) => {
      r.seedUser({ id: OTHER, displayName: "Other Person", handle: "other" })
      r.seedUser({ id: ORGANIZER, displayName: "Host", handle: "host" })
      r.seedCleanup(makeCleanupRecord({ organizerUserId: ORGANIZER }))
    })
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/follow-suggestions",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { results: Array<{ id: string; isFollowing: boolean }> }
    const ids = body.results.map((p) => p.id)
    expect(ids[0]).toBe(ORGANIZER)
    expect(ids).toContain(OTHER)
    expect(ids).not.toContain(userId)

    // Following ORGANIZER removes them from the next fetch.
    repo.seedFollow(userId, ORGANIZER)
    const res2 = await app.inject({
      method: "GET",
      url: "/v1/users/follow-suggestions",
      headers: auth(token),
    })
    const ids2 = (res2.json() as { results: Array<{ id: string }> }).results.map((p) => p.id)
    expect(ids2).not.toContain(ORGANIZER)
  })

  it("422s a bad limit", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/v1/users/follow-suggestions?limit=999",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(422)
  })
})
