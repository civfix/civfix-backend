import { describe, it, expect, afterEach } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"

let app: FastifyInstance | undefined

afterEach(async () => {
  if (app) {
    await app.close()
    app = undefined
  }
})

const TRUSTED_EDGE_HEADERS = { "x-forwarded-for": "203.0.113.7" }

describe("GET /geo/approximate", () => {
  it("answers with the configured home region when no CF geo headers are present", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/v1/geo/approximate" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      lat: 34.0522,
      lng: -118.2437,
      radiusKm: 40,
      source: "region",
    })
    expect(res.headers["cache-control"]).toBe("private, max-age=300")
  })

  it("honors the HOME_REGION_* overrides", async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      HOME_REGION_LAT: "41.8781",
      HOME_REGION_LNG: "-87.6298",
      HOME_REGION_RADIUS_KM: "25",
    })
    app = await buildServer({ env, container: buildContainer(env) })
    const res = await app.inject({ method: "GET", url: "/v1/geo/approximate" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ lat: 41.8781, lng: -87.6298, radiusKm: 25, source: "region" })
  })

  it("uses the Cloudflare IP fix when the request came through the trusted proxy path", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "GET",
      url: "/v1/geo/approximate",
      headers: {
        ...TRUSTED_EDGE_HEADERS,
        "cf-iplatitude": "40.7128",
        "cf-iplongitude": "-74.006",
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ lat: 40.7128, lng: -74.006, radiusKm: 25, source: "ip" })
  })

  it("tightens the radius when Cloudflare resolved a city", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "GET",
      url: "/v1/geo/approximate",
      headers: {
        ...TRUSTED_EDGE_HEADERS,
        "cf-iplatitude": "40.7128",
        "cf-iplongitude": "-74.006",
        "cf-ipcity": "New York",
      },
    })
    expect(res.json()).toMatchObject({ radiusKm: 10, source: "ip" })
  })

  it("IGNORES CF geo headers supplied by an untrusted client and answers with the region", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "GET",
      url: "/v1/geo/approximate",
      remoteAddress: "8.8.8.8",
      headers: {
        "cf-iplatitude": "40.7128",
        "cf-iplongitude": "-74.006",
        "cf-ipcity": "New York",
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      lat: 34.0522,
      lng: -118.2437,
      radiusKm: 40,
      source: "region",
    })
  })

  it("falls back to the region when a trusted-edge header is malformed", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "GET",
      url: "/v1/geo/approximate",
      headers: {
        ...TRUSTED_EDGE_HEADERS,
        "cf-iplatitude": "not-a-number",
        "cf-iplongitude": "-74.006",
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ source: "region", lat: 34.0522, lng: -118.2437 })
  })

  it("422s an unrecognized query parameter (the request contract is strict)", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/v1/geo/approximate?foo=1" })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("refuses to boot on an out-of-range HOME_REGION_* value rather than serving it", () => {
    expect(() => loadEnv({ NODE_ENV: "test", HOME_REGION_LAT: "999" })).toThrow(/HOME_REGION_LAT/)
    expect(() => loadEnv({ NODE_ENV: "test", HOME_REGION_RADIUS_KM: "0" })).toThrow(
      /HOME_REGION_RADIUS_KM/,
    )
  })
})
