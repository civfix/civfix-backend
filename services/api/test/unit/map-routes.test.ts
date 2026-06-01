import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"

/**
 * Route-level tests for the map plugin that need NO database: tileinfo (pure env read) and
 * reverse-label (FakeGeocoder seam). Exercised through the real Fastify app via app.inject with all
 * fakes on. The DB-backed endpoints (resolve-jurisdiction, cleanups) are covered by the Docker-gated
 * integration test instead.
 */

let app: FastifyInstance | undefined

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
})

describe("GET /map/tileinfo", () => {
  it("returns env-driven values when the TILES_* vars are set", async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      TILES_PMTILES_URL: "https://tiles.example/basemap.pmtiles",
      TILES_RASTER_URL: "https://tiles.example/{z}/{x}/{y}.png",
      TILES_STYLE_URL: "https://tiles.example/style.json",
      TILES_MIN_ZOOM: "3",
      TILES_MAX_ZOOM: "17",
      TILES_BOUNDS: "-130,20,-60,55",
    })
    const container = buildContainer(env)
    app = await buildServer({ env, container })

    const res = await app.inject({ method: "GET", url: "/map/tileinfo" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pmtilesUrl).toBe("https://tiles.example/basemap.pmtiles")
    expect(body.rasterUrl).toBe("https://tiles.example/{z}/{x}/{y}.png")
    expect(body.styleUrl).toBe("https://tiles.example/style.json")
    expect(body.minZoom).toBe(3)
    expect(body.maxZoom).toBe(17)
    expect(body.bounds).toEqual([-130, 20, -60, 55])
    expect(typeof body.attribution).toBe("string")
  })

  it("returns a safe default (empty pmtilesUrl, default zoom/bounds) when unconfigured", async () => {
    // The vitest env sets no TILES_* vars, so this exercises the documented degraded default.
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/map/tileinfo" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Never 500s; pmtilesUrl is "" and the raster/style fallbacks are simply absent.
    expect(body.pmtilesUrl).toBe("")
    expect(body.rasterUrl).toBeUndefined()
    expect(body.styleUrl).toBeUndefined()
    expect(body.minZoom).toBe(1)
    expect(body.maxZoom).toBe(19)
    expect(body.bounds).toEqual([-125, 24, -66, 50])
  })
})

describe("POST /map/reverse-label", () => {
  it("returns the FakeGeocoder label for a point", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/map/reverse-label",
      payload: { lat: 34.05, lng: -118.25 },
    })
    expect(res.statusCode).toBe(200)
    // FakeGeocoder defaults to "Los Angeles, CA".
    expect(res.json()).toEqual({ cityStateLabel: "Los Angeles, CA" })
  })

  it("rejects a malformed body with the 422 validation envelope", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/map/reverse-label",
      payload: { lat: 999, lng: -118.25 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})
