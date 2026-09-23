// The version gate must see the version Fastify's router sees. `request.url` is raw while find-my-way
// percent-decodes before matching (`/%761/ping` serves `/v1/ping`), so a single escape once bypassed
// sunset and unsupported-version enforcement. A 400 (not a 404) proves the gate rejected the request:
// `/v2/*` has no route, so a skipped gate falls through to not-found.

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
    // Fastify rejects an undecodable URI before onRequest hooks run; the guarded decode exists so a future
    // hook order still cannot throw out of the gate. Either way it must be a client error, never a 500.
    const res = await app.inject({ method: "GET", url: "/%zz/x" })
    expect([400, 404]).toContain(res.statusCode)
  })
})
