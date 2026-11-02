import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import type { JurisdictionDTO } from "@civfix/contract"
import { makeServer } from "../../src/server.js"
import { loadEnv } from "../../src/env.js"

const resolveForPoint = vi.fn<(lat: number, lng: number) => Promise<JurisdictionDTO | null>>()

vi.mock("../../src/services/route-geo-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/route-geo-helpers.js")>()),
  makeRouteJurisdictionService: () => ({ resolveForPoint }),
}))

const LA: JurisdictionDTO = {
  geoid: "0644000",
  name: "Los Angeles",
  layer: "place",
  cityStateLabel: "Los Angeles, CA",
  routable: true,
}

let app: FastifyInstance | undefined

afterEach(async () => {
  resolveForPoint.mockReset()
  if (app) {
    await app.close()
    app = undefined
  }
})

function resolve(server: FastifyInstance) {
  return server.inject({
    method: "POST",
    url: "/v1/map/resolve-jurisdiction",
    payload: { lat: 34.05, lng: -118.25 },
  })
}

describe("POST /map/resolve-jurisdiction", () => {
  it("answers 200 with the jurisdiction covering the point", async () => {
    resolveForPoint.mockResolvedValue(LA)
    app = await makeServer({ env: loadEnv() })
    const res = await resolve(app)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(LA)
    expect(resolveForPoint).toHaveBeenCalledWith(34.05, -118.25)
  })

  // The clients map NOT_FOUND to "no jurisdiction here".
  it("answers 404 NOT_FOUND when no jurisdiction covers the point", async () => {
    resolveForPoint.mockResolvedValue(null)
    app = await makeServer({ env: loadEnv() })
    const res = await resolve(app)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" })
  })
})
