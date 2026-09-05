import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import type { RedisClient } from "../../src/adapters/redis.js"
import { loadEnv } from "../../src/env.js"

describe("health routes", () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    if (app) {
      await app.close()
      app = undefined
    }
  })

  it("GET /healthz returns 200 { ok: true }", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.service).toBe("civfix-api")
    expect(body.version).toBeUndefined()
    expect(res.headers["cache-control"]).toBe("no-store")
  })

  it("L19: /readyz is rate limited (no longer on the limiter allowlist), /healthz is not", async () => {
    app = await buildServer({ env: loadEnv() })
    const ready = await app.inject({ method: "GET", url: "/readyz" })
    expect(ready.headers["x-ratelimit-limit"]).toBeDefined()
    expect(ready.headers["cache-control"]).toBe("no-store")
    const live = await app.inject({ method: "GET", url: "/healthz" })
    expect(live.headers["x-ratelimit-limit"]).toBeUndefined()
  })

  it("L19: /readyz memoizes its verdict so a flood costs one backend probe", async () => {
    let pings = 0
    const env = loadEnv()
    const container = buildContainer(env)
    const stub = { ping: async () => (pings++, "PONG") } as unknown as RedisClient
    Object.defineProperty(container, "redis", { get: () => stub })
    Object.defineProperty(container, "getRedis", { value: () => stub })
    app = await buildServer({ env, container })

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/readyz" })
      expect(res.statusCode).toBe(200)
    }
    expect(pings).toBe(1)
  })

  it("echoes x-request-id header", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "test-req-123" },
    })
    expect(res.headers["x-request-id"]).toBe("test-req-123")
  })

  it("GET /readyz returns 200 with skipped checks in all-fakes mode", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/readyz" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.checks.db).toBe("skipped")
    expect(body.checks.redis).toBe("skipped")
  })

  it("H11: readiness ignores the USE_FAKE_* flags — a configured backend is always probed", async () => {
    const env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://u:p@localhost:5432/civfix",
      USE_FAKE_CHAT: "1",
      USE_FAKE_PUSH: "1",
      USE_FAKE_JOBS: "1",
      USE_FAKE_USER_CHANNEL: "1",
    })
    const container = buildContainer(env)
    expect(container.usesRealDb).toBe(true)
    expect(container.usesRealRedis).toBe(false)
    Object.defineProperty(container, "getDb", {
      value: () => ({
        sql: () => Promise.reject(new Error("db down")),
      }),
    })
    app = await buildServer({ env, container })
    const res = await app.inject({ method: "GET", url: "/readyz" })
    expect(res.statusCode).toBe(503)
    const body = res.json()
    expect(body.checks.db).toBe("down")
    expect(body.checks.redis).toBe("skipped")
  })

  it("unknown route returns the 404 error envelope", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.code).toBe("NOT_FOUND")
    expect(typeof body.requestId).toBe("string")
  })

  it("P2-6: sets a lock-down CSP and keeps nosniff on responses", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/healthz" })
    const csp = res.headers["content-security-policy"]
    expect(typeof csp).toBe("string")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
  })
})
