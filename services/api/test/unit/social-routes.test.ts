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

/**
 * Route-level tests for the social plugin, run with NO database: an in-memory SocialRepository (+ a spy
 * notifier) is injected via buildServer(opts.socialOverrides), and a full in-memory auth bundle gives the
 * [auth] routes a real bearer session. Exercised through app.inject. The Drizzle/PostGIS path is covered by
 * the Docker-gated integration test.
 */

/** A capturing notifier so the route test can assert the new_follower hook fired. */
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

  // Sign in (the viewer) through the real OTP flow (mobile -> bearer token in the body).
  const { token, userId } = await signIn(app, mailer, "viewer@example.com")
  // Register the signed-in user in the social repo so their profile + self-exclusion resolve.
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

const OTHER = "44444444-4444-4444-4444-444444444444"

describe("GET /people", () => {
  // The directory is now AUTH-REQUIRED and `q` is REQUIRED server-side (no list-everyone form): a
  // logged-out request 401s, and a missing/blank q 422s, so the endpoint can never enumerate all users.
  it("401s an anonymous request (auth required)", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Other Person", handle: "other" })
    })
    const res = await app.inject({ method: "GET", url: "/people?q=oth" })
    expect(res.statusCode).toBe(401)
  })

  it("422s a missing/blank q (never enumerates all users)", async () => {
    const { app, token } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Other Person", handle: "other" })
    })
    const noQ = await app.inject({ method: "GET", url: "/people", headers: auth(token) })
    expect(noQ.statusCode).toBe(422)
    const blankQ = await app.inject({ method: "GET", url: "/people?q=%20", headers: auth(token) })
    expect(blankQ.statusCode).toBe(422)
  })

  it("filters by q, excludes the signed-in viewer, and attaches an avatar gradient", async () => {
    const { app, token, userId } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Zelda", handle: "zelda" })
    })
    const hit = await app.inject({ method: "GET", url: "/people?q=zel", headers: auth(token) })
    expect(hit.statusCode).toBe(200)
    const body = hit.json()
    const ids = body.items.map((p: { id: string }) => p.id)
    expect(ids).toEqual([OTHER])
    expect(ids).not.toContain(userId) // the viewer is excluded
    // Each item carries an avatar gradient pair.
    expect(body.items[0].avatar).toHaveLength(2)

    const miss = await app.inject({ method: "GET", url: "/people?q=nobody", headers: auth(token) })
    expect(miss.json().items).toEqual([])
  })

  it("422s a bad limit", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/people?q=zel&limit=999", headers: auth(token) })
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
      url: `/people/${OTHER}/follow`,
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
    // Follow then unfollow.
    await app.inject({ method: "POST", url: `/people/${OTHER}/follow`, headers: auth(token) })
    const res = await app.inject({
      method: "DELETE",
      url: `/people/${OTHER}/follow`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ isFollowing: false, followers: 0 })
  })

  it("422s following yourself", async () => {
    const { app, token, userId } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: `/people/${userId}/follow`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("404s following a non-existent person", async () => {
    const { app, token } = await makeHarness()
    const res = await app.inject({
      method: "POST",
      url: "/people/00000000-0000-0000-0000-000000000000/follow",
      headers: auth(token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("401s an anonymous follow", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Target" })
    })
    const res = await app.inject({ method: "POST", url: `/people/${OTHER}/follow` })
    expect(res.statusCode).toBe(401)
  })
})

describe("GET /people/:id (profile)", () => {
  it("returns a public profile (anon-ok) with stats + pastEvents", async () => {
    const { app } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Pro", handle: "pro", bio: "organizer" })
      repo.seedReports(OTHER, 2)
      repo.seedCleanup(makeCleanupRecord({ organizerUserId: OTHER, title: "Past sweep" }))
    })
    const res = await app.inject({ method: "GET", url: `/people/${OTHER}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.profile.id).toBe(OTHER)
    expect(body.profile.stats).toEqual({ reports: 2, cleanups: 1 })
    expect(body.profile.pastEvents.map((e: { title: string }) => e.title)).toEqual(["Past sweep"])
    expect(body.profile.isFollowing).toBe(false) // anonymous viewer
  })

  it("reflects isFollowing for the signed-in viewer", async () => {
    const { app, token } = await makeHarness((repo) => {
      repo.seedUser({ id: OTHER, displayName: "Pro" })
    })
    await app.inject({ method: "POST", url: `/people/${OTHER}/follow`, headers: auth(token) })
    const res = await app.inject({ method: "GET", url: `/people/${OTHER}`, headers: auth(token) })
    expect(res.json().profile.isFollowing).toBe(true)
  })

  it("404s a missing profile", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({
      method: "GET",
      url: "/people/00000000-0000-0000-0000-000000000000",
    })
    expect(res.statusCode).toBe(404)
  })

  it("422s a non-UUID id", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/people/not-a-uuid" })
    expect(res.statusCode).toBe(422)
  })
})

describe("GET /me/profile", () => {
  it("returns the signed-in user's own profile", async () => {
    const { app, token, userId } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/me/profile", headers: auth(token) })
    expect(res.statusCode).toBe(200)
    expect(res.json().profile.id).toBe(userId)
    expect(res.json().profile.isFollowing).toBe(false)
  })

  it("401s anonymously", async () => {
    const { app } = await makeHarness()
    const res = await app.inject({ method: "GET", url: "/me/profile" })
    expect(res.statusCode).toBe(401)
  })
})
