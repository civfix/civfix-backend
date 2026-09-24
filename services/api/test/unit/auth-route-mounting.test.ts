/**
 * ENV-GATED AUTH/ADMIN ROUTE MOUNTING — regression guard for the operator-dashboard 404.
 *
 * The bug: admin.civfix.org returned
 *   {"code":"NOT_FOUND","message":"Route GET /admin/auth/session not found"}
 * The request DID reach the backend (that JSON is Fastify's not-found handler). Root cause: the API
 * container had booted in dev/all-fakes mode (NODE_ENV !== "production", so env.ts did not REQUIRE
 * DATABASE_URL/REDIS_URL and they stayed empty). With no infra, buildServer builds no auth bundle, and
 * registerRoutes then mounts NEITHER the citizen /auth/* NOR the operator /admin/* routes — so every
 * such request falls through to the route-not-found handler.
 *
 * The deploy fix forces NODE_ENV=production in infra/compose so the env loader requires the infra (the
 * API boots correctly or fails loudly). These tests lock the APPLICATION-level invariant that fix relies
 * on: the auth + admin routes mount IFF an auth bundle is present, and that presence is driven by the
 * DATABASE_URL/REDIS_URL env pair.
 *
 * Infra-free: the "present" case asserts only that buildServer DECORATED the bundle (synchronous, before
 * any ready()/inject()), so the lazily-connecting DB/Redis handles never open a socket. The end-to-end
 * "mounted route responds" case uses an in-memory auth bundle.
 */

import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { buildAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"

/** The not-found handler's message prefix; a domain 404 (AppError) never starts with this. */
const routeMissingPrefix = (method: string): string => `Route ${method} `

describe("auth/admin route mounting is gated on the auth bundle", () => {
  it("does NOT mount /auth/* or /admin/* with no DATABASE_URL/REDIS_URL (reproduces the reported 404)", async () => {
    const app = await buildServer({ env: loadEnv({ NODE_ENV: "test" }) })
    try {
      // No infra => no auth bundle is decorated on the app.
      expect(app.hasDecorator("authServices")).toBe(false)

      // GET /admin/auth/session is the exact failing request — it is route-missing, not a domain 404.
      const admin = await app.inject({ method: "GET", url: "/v1/admin/auth/session" })
      expect(admin.statusCode).toBe(404)
      const adminBody = admin.json() as { code?: string; message?: string }
      expect(adminBody.code).toBe("NOT_FOUND")
      expect(adminBody.message?.startsWith(routeMissingPrefix("GET"))).toBe(true)

      // The citizen session route is gated by the SAME bundle, so it is route-missing too — proving the
      // failure is systemic (the whole auth surface is gone), not specific to the admin plugin.
      const citizen = await app.inject({ method: "GET", url: "/v1/auth/session" })
      expect(citizen.statusCode).toBe(404)
      expect(
        (citizen.json() as { message?: string }).message?.startsWith(routeMissingPrefix("GET")),
      ).toBe(true)

      // Sanity: an always-mounted public route still answers, so the server itself is up and routing.
      const health = await app.inject({ method: "GET", url: "/healthz" })
      expect(health.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it("builds the auth bundle when DATABASE_URL + REDIS_URL are present (the gate opens)", async () => {
    // ioredis is lazyConnect and postgres connects on first query, so building the real bundle from env
    // opens no socket. We assert the DECISION (bundle decorated) without ready()/inject(), so the bogus
    // URLs below are never dialed.
    const app = await buildServer({
      env: loadEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://civfix:civfix@127.0.0.1:5432/civfix",
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    })
    try {
      expect(app.hasDecorator("authServices")).toBe(true)
    } finally {
      await app.close()
    }
  })

  it("serves GET /admin/auth/session (200, unauthenticated) when an auth bundle is present", async () => {
    // In-memory auth bundle => routes mount AND respond with zero infra. The anonymous (no-cookie) path
    // returns {authenticated:false} without any DB/Redis call, which is exactly what the SPA bootstrap
    // reads first before falling back to the Access exchange.
    const authServices = buildAuthServices({
      stores: makeInMemoryStores(),
      cache: new InMemoryCacheClient(() => Date.now()),
      mailer: new FakeMailer(),
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const app = await buildServer({ env: loadEnv({ NODE_ENV: "test" }), authServices })
    try {
      const res = await app.inject({ method: "GET", url: "/v1/admin/auth/session" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ authenticated: false })
    } finally {
      await app.close()
    }
  })
})
