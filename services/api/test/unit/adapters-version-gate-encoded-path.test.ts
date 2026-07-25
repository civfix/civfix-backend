/**
 * PERCENT-ENCODED VERSION SEGMENT: the version gate must see the same version Fastify's ROUTER sees.
 *
 * The gate reads `request.url`, which is RAW, while find-my-way percent-DECODES before matching: `GET
 * /%761/ping` is served by the static route `/v1/ping`. So the gate saw the segment "%761", decided it was
 * not a `/vN` at all, and skipped enforcement entirely — sunset (410) and unsupported (400) rejection plus
 * the Deprecation/Sunset headers were all bypassable with a single percent-escape. Latent while v1 is the
 * only version, and a complete defeat of the policy the moment a v2 exists.
 *
 * Asserting a 400 (not a 404) is what proves the GATE rejected the request: `/v2/*` has no registered
 * route, so a gate that skipped enforcement would fall through to the not-found handler.
 *
 * (File named for this wave's adapters/errors pass; it exercises src/versioning/version-gate.ts.)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { ErrorCode } from "@civfix/shared"
import { makeErrorHandler, makeNotFoundHandler } from "../../src/errors/http-mapper.js"
import { genReqId } from "../../src/plugins/request-id.js"
import { registerVersionGate } from "../../src/versioning/version-gate.js"

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify({ genReqId, logger: false })
  app.setErrorHandler(makeErrorHandler())
  app.setNotFoundHandler(makeNotFoundHandler())
  await registerVersionGate(app)
  app.get("/v1/ping", async () => ({ ok: true }))
  app.get("/healthz", async () => ({ ok: true }))
  app.get("/v1foo/x", async () => ({ ok: true }))
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe("version gate with a percent-encoded first segment", () => {
  it("rejects an encoded UNKNOWN version (400, not a route-missing 404)", async () => {
    for (const url of ["/v%32/reports", "/%7632/reports", "/v%339/reports"]) {
      const res = await app.inject({ method: "GET", url })
      expect(res.statusCode, url).toBe(400)
      expect(res.json<{ code: string }>().code).toBe(ErrorCode.UNSUPPORTED_API_VERSION)
    }
  })

  it("rejects an encoded BELOW-FLOOR version", async () => {
    const res = await app.inject({ method: "GET", url: "/%760/reports" })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe(ErrorCode.UNSUPPORTED_API_VERSION)
  })

  it("still allows the served current version, encoded or not (parity with the router)", async () => {
    for (const url of ["/v1/ping", "/%761/ping", "/v%31/ping"]) {
      const res = await app.inject({ method: "GET", url })
      expect(res.statusCode, url).toBe(200)
    }
  })

  it("leaves unversioned and version-LIKE paths alone", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200)
    expect((await app.inject({ method: "GET", url: "/v1foo/x" })).statusCode).toBe(200)
    // "%76" decodes to "v" alone, which is not a /vN.
    expect((await app.inject({ method: "GET", url: "/%76/x" })).statusCode).toBe(404)
  })

  it("does not turn a malformed escape into a 500", async () => {
    // Fastify itself rejects an undecodable URI before onRequest hooks run, so the gate never sees "%zz";
    // the guarded decode exists so that a future hook order (or a decodable-but-odd segment) still cannot
    // throw out of the gate. Either way the outcome must be a client error, never a 500.
    const res = await app.inject({ method: "GET", url: "/%zz/x" })
    expect([400, 404]).toContain(res.statusCode)
  })
})
