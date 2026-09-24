/**
 * Regression guard for the operator-dashboard 404: admin.civfix.org returned
 *   {"code":"NOT_FOUND","message":"Route GET /admin/auth/session not found"}
 * because the API booted in all-fakes mode (NODE_ENV !== "production", so DATABASE_URL/REDIS_URL were
 * not required and stayed empty). With no infra there is no auth bundle, and registerRoutes mounts
 * neither /auth/* nor /admin/*.
 *
 * The deploy fix forces NODE_ENV=production; these tests lock the invariant it relies on: the auth and
 * admin routes mount IFF an auth bundle is present, and the DATABASE_URL/REDIS_URL pair drives that.
 *
 * Infra-free: the "present" case asserts only that makeServer DECORATED the bundle, before any
 * ready()/inject(), so the lazily-connecting DB/Redis handles never open a socket.
 */

import { describe, it, expect } from "vitest"
import { FakeMailer } from "@civfix/shared/fakes"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"
import { makeInMemoryStores } from "../../src/auth/stores.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { makeAuthServices } from "../../src/auth/auth-services.js"
import { StubJwksVerifier } from "../helpers/auth.js"

/** The not-found handler's message prefix; a domain 404 (AppError) never starts with this. */
const routeMissingPrefix = (method: string): string => `Route ${method} `

describe("auth/admin route mounting is gated on the auth bundle", () => {
  it("does NOT mount /auth/* or /admin/* with no DATABASE_URL/REDIS_URL (reproduces the reported 404)", async () => {
    const app = await makeServer({ env: loadEnv({ NODE_ENV: "test" }) })
    try {
      expect(app.hasDecorator("authServices")).toBe(false)

      // The exact failing request: route-missing, not a domain 404.
      const admin = await app.inject({ method: "GET", url: "/v1/admin/auth/session" })
      expect(admin.statusCode).toBe(404)
      const adminBody = admin.json() as { code?: string; message?: string }
      expect(adminBody.code).toBe("NOT_FOUND")
      expect(adminBody.message?.startsWith(routeMissingPrefix("GET"))).toBe(true)

      // The citizen route is gated by the SAME bundle, so the whole auth surface is gone, not just the
      // admin plugin.
      const citizen = await app.inject({ method: "GET", url: "/v1/auth/session" })
      expect(citizen.statusCode).toBe(404)
      expect(
        (citizen.json() as { message?: string }).message?.startsWith(routeMissingPrefix("GET")),
      ).toBe(true)

      const health = await app.inject({ method: "GET", url: "/healthz" })
      expect(health.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it("builds the auth bundle when DATABASE_URL + REDIS_URL are present (the gate opens)", async () => {
    // ioredis is lazyConnect and postgres connects on first query, so without ready()/inject() the bogus
    // URLs below are never dialed.
    const app = await makeServer({
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
    // The anonymous path answers without any DB/Redis call; it is what the SPA bootstrap reads before
    // falling back to the Access exchange.
    const authServices = makeAuthServices({
      stores: makeInMemoryStores(),
      cache: new InMemoryCacheClient(() => Date.now()),
      mailer: new FakeMailer(),
      oauthConfig: {},
      verifier: new StubJwksVerifier(),
      now: () => Date.now(),
    })
    const app = await makeServer({ env: loadEnv({ NODE_ENV: "test" }), authServices })
    try {
      const res = await app.inject({ method: "GET", url: "/v1/admin/auth/session" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ authenticated: false })
    } finally {
      await app.close()
    }
  })
})
