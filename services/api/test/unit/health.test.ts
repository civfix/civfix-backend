import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"

/**
 * Boots the server with the test env (all fakes on, no DB/Redis) and exercises the health routes
 * via app.inject so no socket is opened.
 */
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
    expect(typeof body.version).toBe("string")
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

  it("unknown route returns the 404 error envelope", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/does-not-exist" })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.code).toBe("NOT_FOUND")
    expect(typeof body.requestId).toBe("string")
  })
})
