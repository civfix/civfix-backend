/**
 * Proves the `onRequest` version gate (`src/versioning/version-gate.ts`) enforces the served-versions
 * policy (`src/versioning/policy.ts`) correctly under TODAY's dormant policy: only `v1` exists and is
 * `current`, MIN_SUPPORTED is `v1`, and nothing is deprecated or sunset. Under that policy the gate's
 * single active job is rejecting malformed / unknown / below-floor `/vN` segments while letting served
 * versions and all unversioned/system paths through untouched.
 *
 * Rather than stand up the full DI bundle, this builds a MINIMAL, self-contained Fastify instance wired
 * exactly like `makeServer` around the gate: the same request-id generator (so the error envelope's
 * `requestId` is populated) and the same canonical error handler (`makeErrorHandler`) that renders an
 * AppError into `{ code, message, requestId }` with the AppError's HTTP status. On top of that it
 * registers the gate plus four trivial probe routes:
 *
 *   - GET /v1/ping     a SERVED current version  → must pass through the gate to a real handler (200).
 *   - GET /healthz     an unversioned system path → must bypass the gate (200).
 *   - GET /verify      first segment "verify" is NOT /^v\d+$/ → bypass (200).
 *   - GET /v1foo/x     first segment "v1foo" is NOT /^v\d+$/ → bypass (200), NOT treated as a version.
 *
 * Unknown (`/v2`, `/v99`) and below-floor (`/v0`) versions have NO registered route on purpose: the gate
 * runs at `onRequest`, ahead of route matching, so it rejects them with 400 UNSUPPORTED_API_VERSION
 * before Fastify could ever answer a route-missing 404. Asserting the 400 (not a 404) is exactly what
 * proves the gate, not the router, produced the rejection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import { genReqId } from "../../src/plugins/request-id.js"
import { registerVersionGate } from "../../src/versioning/version-gate.js"
import {
  isVersionSegment,
  versionStatus,
  isBelowMinSupported,
  isServedVersion,
} from "../../src/versioning/policy.js"

/**
 * A minimal Fastify instance wired around the version gate the same way `makeServer` is: the gate's
 * `onRequest` hook runs ahead of route matching, the canonical error handler renders AppError → wire
 * envelope, and a handful of probe routes stand in for the real surface.
 */
async function buildGateProbeServer(): Promise<FastifyInstance> {
  const app = Fastify({ genReqId, logger: false })

  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())

  // Registered before routes, exactly as makeServer does, so it fires at onRequest ahead of handlers.
  await registerVersionGate(app)

  // A SERVED current version: reaching this 200 proves the gate let it through.
  app.get("/v1/ping", async () => ({ pong: true }))

  // Unversioned / system paths: each must bypass the gate entirely.
  app.get("/healthz", async () => ({ ok: true }))
  app.get("/verify", async () => ({ verify: true }))
  app.get("/v1foo/x", async () => ({ notAVersion: true }))

  await app.ready()
  return app
}

let app: FastifyInstance

beforeAll(async () => {
  app = await buildGateProbeServer()
})

afterAll(async () => {
  await app.close()
})

describe("version gate: dormant policy (v1=current, MIN=v1, nothing deprecated/sunset)", () => {
  it("lets a SERVED current version through to its handler: GET /v1/ping is not gate-rejected", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ping" })
    // The gate did not reject: the real handler ran. Specifically it is NOT the gate's 400/410, and the
    // route exists so it is not a route-missing 404 either.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ pong: true })
    const body = res.json() as { code?: string }
    expect(body.code).not.toBe("UNSUPPORTED_API_VERSION")
    expect(body.code).not.toBe("API_VERSION_SUNSET")
  })

  it("rejects an UNKNOWN version /v2/<x> with 400 UNSUPPORTED_API_VERSION (before route matching)", async () => {
    const res = await app.inject({ method: "GET", url: "/v2/something" })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { code?: string; requestId?: string }
    expect(body.code).toBe("UNSUPPORTED_API_VERSION")
    // It is the gate, not the not-found handler: a 400, not a route-missing 404.
    expect(typeof body.requestId).toBe("string")
  })

  it("rejects a far-future UNKNOWN version /v99/x with 400 UNSUPPORTED_API_VERSION", async () => {
    const res = await app.inject({ method: "GET", url: "/v99/x" })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code?: string }).code).toBe("UNSUPPORTED_API_VERSION")
  })

  it("rejects a BELOW-MIN version /v0/x with 400 UNSUPPORTED_API_VERSION", async () => {
    const res = await app.inject({ method: "GET", url: "/v0/x" })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code?: string }).code).toBe("UNSUPPORTED_API_VERSION")
  })

  it("bypasses the gate for the unversioned system path /healthz (200, not gate-rejected)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })

  it("does not treat a non-version first segment 'verify' as a version (200)", async () => {
    const res = await app.inject({ method: "GET", url: "/verify" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ verify: true })
  })

  it("does not treat 'v1foo' (not /^v\\d+$/) as a version (200, bypasses the gate)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1foo/x" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ notAVersion: true })
  })

  it("DORMANT deprecation: a served /v1 response carries NO Deprecation/Sunset header today", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ping" })
    expect(res.statusCode).toBe(200)
    expect(res.headers.deprecation).toBeUndefined()
    expect(res.headers.sunset).toBeUndefined()
  })

  it("ignores a query string when reading the version segment: /v2/x?foo=1 still rejects", async () => {
    const res = await app.inject({ method: "GET", url: "/v2/x?foo=1" })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code?: string }).code).toBe("UNSUPPORTED_API_VERSION")
  })
})

describe("version policy: pure helpers (today's policy)", () => {
  it("isVersionSegment: matches /^v\\d+$/ only", () => {
    expect(isVersionSegment("v1")).toBe(true)
    expect(isVersionSegment("v0")).toBe(true)
    expect(isVersionSegment("v2")).toBe(true)
    expect(isVersionSegment("v99")).toBe(true)
    expect(isVersionSegment("v1foo")).toBe(false)
    expect(isVersionSegment("verify")).toBe(false)
    expect(isVersionSegment("healthz")).toBe(false)
    expect(isVersionSegment("")).toBe(false)
  })

  it("versionStatus: v1 is current; unknown vN is null; non-version is null", () => {
    expect(versionStatus("v1")).toEqual({ status: "current" })
    expect(versionStatus("v2")).toBeNull()
    expect(versionStatus("v99")).toBeNull()
    expect(versionStatus("verify")).toBeNull()
  })

  it("isServedVersion: only v1 is served today", () => {
    expect(isServedVersion("v1")).toBe(true)
    expect(isServedVersion("v2")).toBe(false)
    expect(isServedVersion("v0")).toBe(false)
  })

  it("isBelowMinSupported: v0 is below the v1 floor; v1+ and non-versions are not", () => {
    expect(isBelowMinSupported("v0")).toBe(true)
    expect(isBelowMinSupported("v1")).toBe(false)
    expect(isBelowMinSupported("v2")).toBe(false)
    expect(isBelowMinSupported("verify")).toBe(false)
  })
})
