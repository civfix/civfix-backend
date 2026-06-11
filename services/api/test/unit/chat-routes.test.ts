import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { SessionService } from "../../src/auth/session-service.js"
import { StubJwksVerifier } from "../helpers/auth.js"
import { InMemoryThreadsRepository } from "../helpers/chat.js"
import { clientQuery } from "../helpers/query.js"
import { resolveWsUser, isAllowedWsOrigin, checkWsHandshake } from "../../src/ws/gateway.js"
import type { ChatGatewayOverrides } from "../../src/routes/chat.routes.js"
import { SESSION_COOKIE } from "../../src/auth/transport.js"

/**
 * Tests for the chat plugin: GET /threads (auth) over an injected in-memory ThreadsRepository, and the
 * dual WS handshake auth (resolveWsUser): a cookie/bearer already on req.auth, OR a ?token query param
 * (mobile), with an unauthenticated handshake rejected.
 */

let current: FastifyInstance | undefined

afterEach(async () => {
  if (current) {
    await current.close()
    current = undefined
  }
})

const ME = "11111111-1111-1111-1111-111111111111"

async function makeThreadsHarness(seed: (repo: InMemoryThreadsRepository) => void): Promise<{
  app: FastifyInstance
  mailer: FakeMailer
}> {
  const env = loadEnv({ NODE_ENV: "test" })
  const stores = makeInMemoryStores()
  const cache = new InMemoryCacheClient(() => Date.now())
  const mailer = new FakeMailer()
  const authServices = buildAuthServices({
    stores,
    cache,
    mailer,
    oauthConfig: {},
    verifier: new StubJwksVerifier(),
    now: () => Date.now(),
  })

  const threadsRepo = new InMemoryThreadsRepository()
  seed(threadsRepo)
  const chatOverrides: ChatGatewayOverrides = {
    // Membership probe is unused by GET /threads; provide a permissive stub.
    isMember: () => Promise.resolve(true),
    threadsRepo,
  }

  const app = await buildServer({ env, authServices, chatOverrides })
  current = app
  return { app, mailer }
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

describe("GET /threads", () => {
  it("401s an anonymous GET /threads", async () => {
    const { app } = await makeThreadsHarness((repo) => {
      repo.seedCleanup("x")
    })
    const res = await app.inject({ method: "GET", url: "/v1/threads" })
    expect(res.statusCode).toBe(401)
  })

  // Regression: the mobile inbox (cursorInfiniteQuery / useTotalUnread) fetches GET /threads?limit=20.
  // Through Fastify the `limit` arrives as the STRING "20"; the shared PaginationQuerySchema must coerce
  // it. A non-coerced z.number() would 422 the live client (the original bug). clientQuery() builds the
  // exact wire query the shared client serializes, guarding the coercion through the real route.
  it("accepts the client's ?limit=20 (string-coerced) request (200, not 422)", async () => {
    const { app, mailer } = await makeThreadsHarness((repo) => {
      repo.seedCleanup("x")
    })
    const { token } = await signIn(app, mailer, "limit@example.com")
    const res = await app.inject({
      method: "GET",
      url: `/v1/threads${clientQuery({ limit: 20 })}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().items)).toBe(true)
  })

  it("returns a populated thread for a member (unread + lastFromMe)", async () => {
    // Build the harness, sign in, THEN seed the repo for that user id by capturing the repo reference.
    const env = loadEnv({ NODE_ENV: "test" })
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const mailer = new FakeMailer()
    const authServices = buildAuthServices({
      stores,
      cache,
      mailer,
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const threadsRepo = new InMemoryThreadsRepository()
    const chatOverrides: ChatGatewayOverrides = {
      isMember: () => Promise.resolve(true),
      threadsRepo,
    }
    const app = await buildServer({ env, authServices, chatOverrides })
    current = app

    const { token, userId } = await signIn(app, mailer, "member@example.com")
    const cleanupId = threadsRepo.seedCleanup("Cleanup with chatter")
    threadsRepo.addMember(cleanupId, userId, new Date("2026-06-01T10:00:00.000Z"))
    threadsRepo.addMember(cleanupId, "99999999-9999-9999-9999-999999999999", new Date("2026-06-01T09:00:00.000Z"))
    threadsRepo.addMessage(cleanupId, {
      senderId: "99999999-9999-9999-9999-999999999999",
      body: "anyone bringing bags?",
      createdAt: new Date("2026-06-01T11:00:00.000Z"),
    })

    const res = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(1)
    const t = body.items[0]
    expect(t.id).toBe(cleanupId)
    expect(t.title).toBe("Cleanup with chatter")
    expect(t.last).toBe("anyone bringing bags?")
    expect(t.unread).toBe(1)
    expect(t.lastFromMe).toBe(false)
    expect(t.members).toBe(2)
  })
})

describe("resolveWsUser (dual handshake auth)", () => {
  /** Build a real in-memory SessionService and mint a session, returning its raw token + the service. */
  async function withSession(): Promise<{ sessions: SessionService; token: string; userId: string }> {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ME, [])
    return { sessions, token, userId: ME }
  }

  /** A minimal FastifyRequest-like object for resolveWsUser (it reads .auth, .query, .headers, .cookies). */
  function fakeReq(over: Partial<FastifyRequest>): FastifyRequest {
    return {
      auth: { userId: null, roles: [], anon: true },
      query: {},
      headers: {},
      cookies: {},
      ...over,
    } as unknown as FastifyRequest
  }

  it("accepts an already-resolved session on req.auth (cookie/web transport)", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({ auth: { userId: ME, roles: [], anon: false } })
    expect(await resolveWsUser(req, sessions)).toBe(ME)
  })

  it("accepts a ?token query param (mobile transport) and resolves it", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({ query: { token } })
    expect(await resolveWsUser(req, sessions)).toBe(ME)
  })

  it("accepts a bearer token presented in the session cookie", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({ cookies: { [SESSION_COOKIE]: token } })
    expect(await resolveWsUser(req, sessions)).toBe(ME)
  })

  it("rejects (null) an unauthenticated handshake with no cookie and no token", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({})
    expect(await resolveWsUser(req, sessions)).toBeNull()
  })

  it("rejects (null) a bogus ?token", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({ query: { token: "not-a-real-token" } })
    expect(await resolveWsUser(req, sessions)).toBeNull()
  })
})

describe("isAllowedWsOrigin (anti-CSWSH origin allowlist)", () => {
  const ALLOW = ["https://app.civfix.org", "https://www.civfix.org"]

  it("allows a request with NO Origin header (native mobile / server-to-server)", () => {
    expect(isAllowedWsOrigin(undefined, ALLOW)).toBe(true)
    expect(isAllowedWsOrigin("", ALLOW)).toBe(true)
  })

  it("allows an Origin that is in the allowlist", () => {
    expect(isAllowedWsOrigin("https://app.civfix.org", ALLOW)).toBe(true)
    expect(isAllowedWsOrigin("https://www.civfix.org", ALLOW)).toBe(true)
  })

  it("rejects a cross-site Origin not in the allowlist", () => {
    expect(isAllowedWsOrigin("https://evil.example.com", ALLOW)).toBe(false)
    // A near-miss (different scheme/port/subdomain) is still rejected: exact match only.
    expect(isAllowedWsOrigin("http://app.civfix.org", ALLOW)).toBe(false)
    expect(isAllowedWsOrigin("https://app.civfix.org:8443", ALLOW)).toBe(false)
    expect(isAllowedWsOrigin("https://app.civfix.org.evil.com", ALLOW)).toBe(false)
  })

  it("allows ALL origins when the allowlist is empty (dev convenience)", () => {
    expect(isAllowedWsOrigin("https://anything.example.com", [])).toBe(true)
    expect(isAllowedWsOrigin(undefined, [])).toBe(true)
    // Even with a cookie, the empty (dev) allowlist disables the gate.
    expect(isAllowedWsOrigin(undefined, [], true)).toBe(true)
  })

  it("P1-4: a NO-Origin handshake is allowed WITHOUT a cookie but REJECTED WITH a cookie", () => {
    // Cookie-less (bearer/native) path: missing Origin is fine (not CSWSH-exposed).
    expect(isAllowedWsOrigin(undefined, ALLOW, false)).toBe(true)
    expect(isAllowedWsOrigin("", ALLOW, false)).toBe(true)
    // Ambient-cookie path: a missing Origin is rejected (a real browser always sends one; a missing one
    // means a non-browser client replaying a stolen cookie).
    expect(isAllowedWsOrigin(undefined, ALLOW, true)).toBe(false)
    expect(isAllowedWsOrigin("", ALLOW, true)).toBe(false)
    // A present, allowlisted Origin is still accepted on the cookie path.
    expect(isAllowedWsOrigin("https://app.civfix.org", ALLOW, true)).toBe(true)
  })
})

describe("checkWsHandshake (origin gate + auth gate, in order)", () => {
  const ALLOW = ["https://app.civfix.org"]

  /** Build a real in-memory SessionService and mint a session token. */
  async function withSession(): Promise<{ sessions: SessionService; token: string }> {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ME, [])
    return { sessions, token }
  }

  /** A minimal FastifyRequest-like object for checkWsHandshake (reads .auth, .query, .headers, .cookies). */
  function fakeReq(over: Partial<FastifyRequest>): FastifyRequest {
    return {
      auth: { userId: null, roles: [], anon: true },
      query: {},
      headers: {},
      cookies: {},
      ...over,
    } as unknown as FastifyRequest
  }

  it("rejects a cross-site Origin with FORBIDDEN, BEFORE consulting the session cookie", async () => {
    const { sessions, token } = await withSession()
    // A cross-site page can attach the cookie automatically; even WITH a valid cookie session, the bad
    // Origin must be rejected first (this is the whole point of the anti-CSWSH check).
    const req = fakeReq({
      headers: { origin: "https://evil.example.com" },
      cookies: { [SESSION_COOKIE]: token },
      // Simulate the auth hook having resolved the cookie to a user (it runs before the upgrade handler).
      auth: { userId: ME, roles: [], anon: false },
    })
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("FORBIDDEN")
      expect(result.reason).toBe("origin not allowed")
    }
  })

  it("accepts an allowlisted Origin with a resolved cookie session (web same-origin)", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({
      headers: { origin: "https://app.civfix.org" },
      auth: { userId: ME, roles: [], anon: false },
    })
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result).toEqual({ ok: true, userId: ME })
  })

  it("accepts a NO-Origin handshake with a ?token (native mobile, not CSWSH-exposed)", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({ query: { token } }) // no Origin header at all
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result).toEqual({ ok: true, userId: ME })
  })

  it("P1-4: REJECTS a NO-Origin handshake that presents a session COOKIE (CSWSH second factor)", async () => {
    const { sessions, token } = await withSession()
    // A non-browser client replaying a stolen cookie with no Origin: the cookie path now requires an
    // allowlisted Origin, so this is rejected with FORBIDDEN before any room work.
    const req = fakeReq({
      cookies: { [SESSION_COOKIE]: token },
      auth: { userId: ME, roles: [], anon: false }, // the auth hook resolved the cookie
      // NOTE: no Origin header.
    })
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("FORBIDDEN")
      expect(result.reason).toBe("origin not allowed")
    }
  })

  it("P1-4: ACCEPTS the cookie path WITH an allowlisted Origin (normal browser SPA)", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({
      headers: { origin: "https://app.civfix.org" },
      cookies: { [SESSION_COOKIE]: token },
      auth: { userId: ME, roles: [], anon: false },
    })
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result).toEqual({ ok: true, userId: ME })
  })

  it("passes the Origin gate but rejects UNAUTHORIZED when no credential is presented", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({ headers: { origin: "https://app.civfix.org" } })
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Proves the ORIGIN gate passed and the AUTH gate is what rejected it.
      expect(result.code).toBe("UNAUTHORIZED")
      expect(result.reason).toBe("unauthenticated")
    }
  })

  it("allows any Origin when the allowlist is empty (dev), still requiring auth", async () => {
    const { sessions, token } = await withSession()
    const ok = await checkWsHandshake(
      fakeReq({ headers: { origin: "https://anything.example.com" }, query: { token } }),
      { sessions, webOrigins: [] },
    )
    expect(ok).toEqual({ ok: true, userId: ME })

    const unauth = await checkWsHandshake(
      fakeReq({ headers: { origin: "https://anything.example.com" } }),
      { sessions, webOrigins: [] },
    )
    expect(unauth.ok).toBe(false)
  })
})
