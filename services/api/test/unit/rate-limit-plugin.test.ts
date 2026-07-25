/**
 * plugins/rate-limit.ts — the two-limiter shape.
 *
 * H4: sensitive prefixes must FAIL CLOSED when the store errors, while ordinary traffic keeps its lax,
 * skip-on-error global bucket.
 * M22: the key must prefer the authenticated identity over the IP, which only works if the auth
 * onRequest hook has already run — this file locks that hook ordering down, because a silently-broken
 * key generator would look exactly like a working one.
 * L19: /healthz stays exempt; /readyz does not.
 */

import { describe, it, expect } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
  registerRateLimit,
  rateLimitKey,
  sensitiveRateLimitKey,
  isSensitivePath,
} from "../../src/plugins/rate-limit.js"
import { makeErrorHandler } from "../../src/errors/http-mapper.js"
import type { RedisClient } from "../../src/adapters/redis.js"

/** A Redis whose rate-limit script always fails — i.e. the outage the fix is about. */
function brokenRedis(): RedisClient {
  return {
    rateLimit: (
      _key: string,
      _tw: number,
      _max: number,
      _ce: boolean,
      _eb: boolean,
      cb: (err: Error | null, result?: unknown) => void,
    ) => cb(new Error("redis is down")),
  } as unknown as RedisClient
}

async function buildApp(
  opts: Parameters<typeof registerRateLimit>[1] = {},
): Promise<FastifyInstance> {
  const app = Fastify()
  app.setErrorHandler(makeErrorHandler())
  await registerRateLimit(app, opts)
  // Mirror server.ts: the auth context hook is an INSTANCE-level onRequest hook registered AFTER the
  // rate limiter. If Fastify ever ran route-level hooks first, the identity key would silently degrade.
  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"]
    req.auth = {
      userId: typeof header === "string" ? header : null,
      roles: [],
      anon: typeof header !== "string",
    }
  })
  app.get("/v1/auth/otp/request", async () => ({ ok: true }))
  app.get("/v1/reports", async () => ({ ok: true }))
  app.get("/healthz", async () => ({ ok: true }))
  await app.ready()
  return app
}

describe("rate limiter: sensitive prefixes fail closed (H4)", () => {
  it("429s a sensitive path when the store errors, but still serves ordinary traffic", async () => {
    const app = await buildApp({ redis: brokenRedis() })
    try {
      const sensitive = await app.inject({ method: "GET", url: "/v1/auth/otp/request" })
      expect(sensitive.statusCode).toBe(429)
      expect(sensitive.json().code).toBe("RATE_LIMITED")

      // The global bucket is deliberately lax: a Redis blip must not take the read product down.
      const ordinary = await app.inject({ method: "GET", url: "/v1/reports" })
      expect(ordinary.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it("classifies exactly the sensitive prefixes", () => {
    for (const p of [
      "/v1/auth",
      "/v1/auth/otp/verify",
      "/v1/admin/auth/login",
      "/v1/anon/reports",
      "/v1/media/presign",
      "/v1/claim/abc",
      "/forms/home-turf",
    ]) {
      expect(isSensitivePath(p)).toBe(true)
    }
    for (const p of ["/v1/reports", "/healthz", "/readyz", "/v1/authors", "/v1/admin/users"]) {
      expect(isSensitivePath(p)).toBe(false)
    }
  })
})

describe("rate limiter: identity-first keying (M22)", () => {
  it("the GLOBAL key stays IP-only, so presenting a session cannot escape the per-host ceiling", () => {
    const authed = { auth: { userId: "u-1" }, ip: "203.0.113.9" } as never
    const otherAccount = { auth: { userId: "u-2" }, ip: "203.0.113.9" } as never
    const anon = { auth: { userId: null }, ip: "203.0.113.9" } as never
    // All three share one bucket: N accounts on one host must not buy N x the budget (M22 regression).
    expect(rateLimitKey(authed)).toBe("ip:203.0.113.9")
    expect(rateLimitKey(otherAccount)).toBe("ip:203.0.113.9")
    expect(rateLimitKey(anon)).toBe("ip:203.0.113.9")
  })

  it("the SENSITIVE key uses identity when present, so rotating IPs cannot escape it either", () => {
    const authed = { auth: { userId: "u-1" }, ip: "203.0.113.9" } as never
    const sameUserElsewhere = { auth: { userId: "u-1" }, ip: "198.51.100.4" } as never
    const anon = { auth: { userId: null }, ip: "203.0.113.9" } as never
    expect(sensitiveRateLimitKey(authed)).toBe("user:u-1")
    expect(sensitiveRateLimitKey(sameUserElsewhere)).toBe("user:u-1")
    expect(sensitiveRateLimitKey(anon)).toBe("ip:203.0.113.9")
  })

  it("counts one account as ONE bucket even when it rotates IPs", async () => {
    // No redis => the in-process LocalStore, which is enough to count.
    const app = await buildApp({ sensitiveMax: 3 })
    try {
      const hit = (ip: string) =>
        app.inject({
          method: "GET",
          url: "/v1/auth/otp/request",
          headers: { "x-test-user": "attacker" },
          remoteAddress: ip,
        })
      expect((await hit("203.0.113.1")).statusCode).toBe(200)
      expect((await hit("203.0.113.2")).statusCode).toBe(200)
      expect((await hit("203.0.113.3")).statusCode).toBe(200)
      // Fourth request from a fourth address: the ACCOUNT is over its limit.
      const blocked = await hit("203.0.113.4")
      expect(blocked.statusCode).toBe(429)

      // A different account from a already-used IP is unaffected (the key really is the identity).
      const other = await app.inject({
        method: "GET",
        url: "/v1/auth/otp/request",
        headers: { "x-test-user": "bystander" },
        remoteAddress: "203.0.113.1",
      })
      expect(other.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

describe("rate limiter: allowlist (L19)", () => {
  it("exempts /healthz only", async () => {
    const app = await buildApp()
    try {
      const live = await app.inject({ method: "GET", url: "/healthz" })
      expect(live.headers["x-ratelimit-limit"]).toBeUndefined()
      const ordinary = await app.inject({ method: "GET", url: "/v1/reports" })
      expect(ordinary.headers["x-ratelimit-limit"]).toBeDefined()
    } finally {
      await app.close()
    }
  })
})
