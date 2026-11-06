import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"

// Pins the response headers @fastify/helmet and @fastify/cors produce with our options, so a plugin major
// that changes a default shows up here instead of in production. Every value is exact on purpose.

let prod = false
vi.mock("../../src/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/env.js")>()
  return { ...actual, isProd: () => prod }
})

const ALLOWED_ORIGIN = "https://civfix.org"
const EVIL_ORIGIN = "https://evil.example"

const HELMET_SET: Record<string, string> = {
  "content-security-policy":
    "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-frame-options": "SAMEORIGIN",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
}

const HSTS = "max-age=63072000; includeSubDomains; preload"

const EXPOSED =
  "X-Anon-Token, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After"

const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
  "access-control-expose-headers",
]

// The admin plane's stealth 404 for a caller with no session, as the lane answered it before the plugin
// majors moved; the header pins must not change it.
const ADMIN_SESSION_NO_SESSION_STATUS = 404

let app: FastifyInstance | undefined

afterEach(async () => {
  prod = false
  if (app) {
    await app.close()
    app = undefined
  }
})

async function build(): Promise<FastifyInstance> {
  app = await makeServer({ env: loadEnv({ NODE_ENV: "test", WEB_ORIGINS: ALLOWED_ORIGIN }) })
  return app
}

type Headers = Record<string, string | string[] | number | undefined>

function expectHelmetSet(headers: Headers): void {
  for (const [name, value] of Object.entries(HELMET_SET)) {
    expect(headers[name], name).toBe(value)
  }
  expect(headers["cross-origin-embedder-policy"]).toBeUndefined()
}

describe("security headers (helmet)", () => {
  it("T1: GET /healthz outside prod carries the Helmet set and no HSTS", async () => {
    const server = await build()
    const res = await server.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expectHelmetSet(res.headers)
    expect(res.headers["strict-transport-security"]).toBeUndefined()
  })

  it("T2: GET /v1/admin/auth/session with no session outside prod keeps its status and the Helmet set, no HSTS", async () => {
    const server = await build()
    const res = await server.inject({ method: "GET", url: "/v1/admin/auth/session" })
    expect(res.statusCode).toBe(ADMIN_SESSION_NO_SESSION_STATUS)
    expectHelmetSet(res.headers)
    expect(res.headers["strict-transport-security"]).toBeUndefined()
  })

  it("T3: in prod both routes carry the Helmet set plus the two-year preload HSTS", async () => {
    prod = true
    const server = await build()
    const health = await server.inject({ method: "GET", url: "/healthz" })
    expectHelmetSet(health.headers)
    expect(health.headers["strict-transport-security"]).toBe(HSTS)
    const admin = await server.inject({ method: "GET", url: "/v1/admin/auth/session" })
    expectHelmetSet(admin.headers)
    expect(admin.headers["strict-transport-security"]).toBe(HSTS)
  })
})

describe("CORS", () => {
  it("T4: a preflight from an allowed origin gets the full allow set", async () => {
    const server = await build()
    const res = await server.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-csrf-token",
      },
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN)
    expect(res.headers["access-control-allow-credentials"]).toBe("true")
    expect(res.headers["access-control-allow-methods"]).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    )
    expect(res.headers["access-control-allow-headers"]).toBe("content-type,x-csrf-token")
    expect(res.headers["access-control-max-age"]).toBe("600")
    expect(res.headers["access-control-expose-headers"]).toBe(EXPOSED)
    const vary = String(res.headers.vary)
      .split(",")
      .map((v) => v.trim().toLowerCase())
    expect(vary).toContain("origin")
    expect(vary).toContain("access-control-request-headers")
  })

  it("T5: a simple request from an allowed origin is allowed with credentials and the exposed headers", async () => {
    const server = await build()
    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ALLOWED_ORIGIN },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN)
    expect(res.headers["access-control-allow-credentials"]).toBe("true")
    expect(res.headers["access-control-expose-headers"]).toBe(EXPOSED)
  })

  it("T6: a disallowed origin gets no CORS header on the preflight or the request", async () => {
    const server = await build()
    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: EVIL_ORIGIN, "access-control-request-method": "POST" },
    })
    const get = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: EVIL_ORIGIN },
    })
    for (const res of [preflight, get]) {
      for (const name of CORS_HEADERS) {
        expect(res.headers[name], name).toBeUndefined()
      }
    }
  })
})
