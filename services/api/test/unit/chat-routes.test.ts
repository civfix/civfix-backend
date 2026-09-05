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
import { sha256Hex } from "../../src/auth/crypto.js"
import type { WsTicketPayload } from "../../src/auth/ws-ticket.js"


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
  async function withSession(): Promise<{ sessions: SessionService; token: string; userId: string }> {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ME, [])
    return { sessions, token, userId: ME }
  }

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
    expect(await resolveWsUser(req, sessions)).toEqual({ userId: ME })
  })

  it("accepts a bearer token presented in the session cookie, and RETAINS its hash for the live re-check", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({ cookies: { [SESSION_COOKIE]: token } })
    expect(await resolveWsUser(req, sessions)).toEqual({
      userId: ME,
      sessionHash: await sha256Hex(token),
      accountStatus: "active",
    })
  })

  it("H5: REJECTS a ?token query param by default (the session bearer must never ride in a URL)", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({ query: { token } })
    expect(await resolveWsUser(req, sessions)).toBeNull()
  })

  it("H5: accepts ?token ONLY under the WS_ALLOW_QUERY_TOKEN break-glass flag", async () => {
    const { sessions, token } = await withSession()
    const prev = process.env.WS_ALLOW_QUERY_TOKEN
    process.env.WS_ALLOW_QUERY_TOKEN = "1"
    try {
      expect(await resolveWsUser(fakeReq({ query: { token } }), sessions)).toEqual({
        userId: ME,
        sessionHash: await sha256Hex(token),
        accountStatus: "active",
      })
    } finally {
      if (prev === undefined) delete process.env.WS_ALLOW_QUERY_TOKEN
      else process.env.WS_ALLOW_QUERY_TOKEN = prev
    }
  })

  it("H2: a ?ticket bound to a live session retains that session's hash for the live re-check", async () => {
    const { sessions, token } = await withSession()
    const hash = await sha256Hex(token)
    const req = fakeReq({ query: { ticket: "t-1" } })
    const redeem = (t: string): Promise<WsTicketPayload | null> =>
      Promise.resolve(t === "t-1" ? { userId: ME, sessionHash: hash } : null)
    expect(await resolveWsUser(req, sessions, redeem)).toEqual({
      userId: ME,
      sessionHash: hash,
      accountStatus: "active",
    })
  })

  it("H2: a ?ticket whose bound session was revoked is REJECTED at the handshake", async () => {
    const { sessions, token } = await withSession()
    const hash = await sha256Hex(token)
    await sessions.revokeAllForUser(ME)
    const req = fakeReq({ query: { ticket: "t-1" } })
    const redeem = (t: string): Promise<WsTicketPayload | null> =>
      Promise.resolve(t === "t-1" ? { userId: ME, sessionHash: hash } : null)
    expect(await resolveWsUser(req, sessions, redeem)).toBeNull()
  })

  it("H2: a ?ticket claiming a DIFFERENT user than its bound session is REJECTED", async () => {
    const { sessions, token } = await withSession()
    const hash = await sha256Hex(token)
    const req = fakeReq({ query: { ticket: "t-1" } })
    const redeem = (t: string): Promise<WsTicketPayload | null> =>
      Promise.resolve(t === "t-1" ? { userId: "someone-else", sessionHash: hash } : null)
    expect(await resolveWsUser(req, sessions, redeem)).toBeNull()
  })

  it("rejects (null) an unauthenticated handshake with no cookie and no token", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({})
    expect(await resolveWsUser(req, sessions)).toBeNull()
  })

  it("rejects (null) a bogus ?token even with the break-glass flag on", async () => {
    const { sessions } = await withSession()
    const prev = process.env.WS_ALLOW_QUERY_TOKEN
    process.env.WS_ALLOW_QUERY_TOKEN = "1"
    try {
      const req = fakeReq({ query: { token: "not-a-real-token" } })
      expect(await resolveWsUser(req, sessions)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.WS_ALLOW_QUERY_TOKEN
      else process.env.WS_ALLOW_QUERY_TOKEN = prev
    }
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
    expect(isAllowedWsOrigin("http://app.civfix.org", ALLOW)).toBe(false)
    expect(isAllowedWsOrigin("https://app.civfix.org:8443", ALLOW)).toBe(false)
    expect(isAllowedWsOrigin("https://app.civfix.org.evil.com", ALLOW)).toBe(false)
  })

  it("allows ALL origins when the allowlist is empty (dev convenience)", () => {
    expect(isAllowedWsOrigin("https://anything.example.com", [])).toBe(true)
    expect(isAllowedWsOrigin(undefined, [])).toBe(true)
    expect(isAllowedWsOrigin(undefined, [], true)).toBe(true)
  })

  it("P1-4: a NO-Origin handshake is allowed WITHOUT a cookie but REJECTED WITH a cookie", () => {
    expect(isAllowedWsOrigin(undefined, ALLOW, false)).toBe(true)
    expect(isAllowedWsOrigin("", ALLOW, false)).toBe(true)
    expect(isAllowedWsOrigin(undefined, ALLOW, true)).toBe(false)
    expect(isAllowedWsOrigin("", ALLOW, true)).toBe(false)
    expect(isAllowedWsOrigin("https://app.civfix.org", ALLOW, true)).toBe(true)
  })
})

describe("checkWsHandshake (origin gate + auth gate, in order)", () => {
  const ALLOW = ["https://app.civfix.org"]

  async function withSession(): Promise<{ sessions: SessionService; token: string }> {
    const stores = makeInMemoryStores()
    const cache = new InMemoryCacheClient(() => Date.now())
    const sessions = new SessionService({ store: stores.sessions, cache, now: () => Date.now() })
    const token = await sessions.createSession(ME, [])
    return { sessions, token }
  }

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
    const req = fakeReq({
      headers: { origin: "https://evil.example.com" },
      cookies: { [SESSION_COOKIE]: token },
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

  it("accepts a NO-Origin handshake with a ?ticket (native mobile, not CSWSH-exposed)", async () => {
    const { sessions, token } = await withSession()
    const hash = await sha256Hex(token)
    const req = fakeReq({ query: { ticket: "t-1" } })
    const result = await checkWsHandshake(req, {
      sessions,
      webOrigins: ALLOW,
      redeemTicket: (t) => Promise.resolve(t === "t-1" ? { userId: ME, sessionHash: hash } : null),
    })
    expect(result).toEqual({
      ok: true,
      userId: ME,
      sessionHash: hash,
      accountStatus: "active",
    })
  })

  it("H5: a NO-Origin handshake carrying only ?token is UNAUTHORIZED (query bearer disabled)", async () => {
    const { sessions, token } = await withSession()
    const result = await checkWsHandshake(fakeReq({ query: { token } }), {
      sessions,
      webOrigins: ALLOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("UNAUTHORIZED")
  })

  it("P1-4: REJECTS a NO-Origin handshake that presents a session COOKIE (CSWSH second factor)", async () => {
    const { sessions, token } = await withSession()
    const req = fakeReq({
      cookies: { [SESSION_COOKIE]: token },
      auth: { userId: ME, roles: [], anon: false },
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
    expect(result).toEqual({ ok: true, userId: ME, sessionHash: await sha256Hex(token) })
  })

  it("passes the Origin gate but rejects UNAUTHORIZED when no credential is presented", async () => {
    const { sessions } = await withSession()
    const req = fakeReq({ headers: { origin: "https://app.civfix.org" } })
    const result = await checkWsHandshake(req, { sessions, webOrigins: ALLOW })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("UNAUTHORIZED")
      expect(result.reason).toBe("unauthenticated")
    }
  })

  it("allows any Origin when the allowlist is empty (dev), still requiring auth", async () => {
    const { sessions, token } = await withSession()
    const ok = await checkWsHandshake(
      fakeReq({
        headers: { origin: "https://anything.example.com" },
        cookies: { [SESSION_COOKIE]: token },
      }),
      { sessions, webOrigins: [] },
    )
    expect(ok).toEqual({
      ok: true,
      userId: ME,
      sessionHash: await sha256Hex(token),
      accountStatus: "active",
    })

    const unauth = await checkWsHandshake(
      fakeReq({ headers: { origin: "https://anything.example.com" } }),
      { sessions, webOrigins: [] },
    )
    expect(unauth.ok).toBe(false)
  })
})
