import { describe, it, expect, afterEach, vi } from "vitest"
import type { FastifyInstance } from "fastify"
import { buildServer } from "../../src/server.js"
import { buildContainer } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import type { Container } from "../../src/di.js"
import type { ReverseGeocode, ReverseResult } from "../../src/adapters/reverse-geocode.chain.js"

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
  // Plan override: the map uses the OpenStreetMap (CARTO Voyager) RASTER basemap directly in the
  // clients; the platform serves no pmtiles. tileinfo advertises that same raster basemap. pmtilesUrl is
  // always "" (no vector basemap); rasterUrl defaults to the CARTO Voyager template, overridable via the
  // optional TILES_RASTER_URL. minZoom/maxZoom/bounds remain env-tunable.
  it("advertises the default OpenStreetMap/CARTO Voyager raster basemap when unconfigured", async () => {
    // The vitest env sets no TILES_* vars, so this exercises the built-in defaults.
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({ method: "GET", url: "/v1/map/tileinfo" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // No self-hosted vector basemap.
    expect(body.pmtilesUrl).toBe("")
    expect(body.styleUrl).toBeUndefined()
    // The OpenStreetMap-derived CARTO Voyager raster default.
    expect(body.rasterUrl).toBe(
      "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    )
    expect(body.attribution).toBe("(c) OpenStreetMap contributors, (c) CARTO")
    expect(body.minZoom).toBe(1)
    expect(body.maxZoom).toBe(19)
    expect(body.bounds).toEqual([-125, 24, -66, 50])
  })

  it("honors TILES_RASTER_URL as an override plus env-driven zoom/bounds", async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      TILES_RASTER_URL: "https://tiles.example/{z}/{x}/{y}.png",
      TILES_MIN_ZOOM: "3",
      TILES_MAX_ZOOM: "17",
      TILES_BOUNDS: "-130,20,-60,55",
    })
    const container = buildContainer(env)
    app = await buildServer({ env, container })

    const res = await app.inject({ method: "GET", url: "/v1/map/tileinfo" })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pmtilesUrl).toBe("")
    expect(body.rasterUrl).toBe("https://tiles.example/{z}/{x}/{y}.png")
    expect(body.minZoom).toBe(3)
    expect(body.maxZoom).toBe(17)
    expect(body.bounds).toEqual([-130, 20, -60, 55])
    expect(typeof body.attribution).toBe("string")
  })
})

describe("POST /map/reverse-label", () => {
  it("returns the FakeGeocoder label for a point", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/reverse-label",
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
      url: "/v1/map/reverse-label",
      payload: { lat: 999, lng: -118.25 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

/**
 * The street-level preview the creation flows call. Runs on the fake geocoder for the locality half and
 * an injected chain for the street half, so it is offline: the container's real chain is a live Photon
 * request, which has no business in a unit test. There is no database here either, which is itself part
 * of the contract - the cache swallows its own unavailability and the endpoint still answers.
 */
function withStreetChain(container: Container, result: ReverseResult | null): Container {
  ;(container as { streetReverseGeocode: ReverseGeocode }).streetReverseGeocode = async () => result
  return container
}

describe("POST /map/resolve-address", () => {
  it("returns the chain's rung plus the locality hint", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const container = withStreetChain(buildContainer(env), {
      line: "123 Imperial Hwy, Inglewood, CA",
      precision: "street",
      provider: "photon",
    })
    app = await buildServer({ env, container })

    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-address",
      payload: { lat: 34.05, lng: -118.25 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      address: "123 Imperial Hwy, Inglewood, CA",
      precision: "street",
      // FakeGeocoder defaults to "Los Angeles, CA".
      cityStateLabel: "Los Angeles, CA",
    })
  })

  it("falls back to locality on a chain miss, and says so", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const container = withStreetChain(buildContainer(env), null)
    app = await buildServer({ env, container })

    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-address",
      payload: { lat: 34.05, lng: -118.25 },
    })
    expect(res.statusCode).toBe(200)
    // precision 'locality' is what tells the client to ask the host to type an address instead.
    expect(res.json()).toEqual({
      address: "Los Angeles, CA",
      precision: "locality",
      cityStateLabel: "Los Angeles, CA",
    })
  })

  it("returns a landmark line RAW, leaving the 'Near ' prefix to the client's locale", async () => {
    const env = loadEnv({ NODE_ENV: "test" })
    const container = withStreetChain(buildContainer(env), {
      line: "Vista Hermosa Park, Los Angeles, CA",
      precision: "landmark",
      provider: "photon",
    })
    app = await buildServer({ env, container })

    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-address",
      payload: { lat: 34.05, lng: -118.25 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().address).toBe("Vista Hermosa Park, Los Angeles, CA")
    expect(res.json().precision).toBe("landmark")
  })

  it("rejects a malformed body with the 422 validation envelope", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/resolve-address",
      payload: { lat: 999, lng: -118.25 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("POST /map/jurisdictions/:geoid/suggest-contact (validation, no DB)", () => {
  // Body validation runs BEFORE any DB access, so the "needs a contact" + bad-email cases are clean 422s
  // with no Postgres wired. The 404 (unknown geoid) and 201 (audit written) paths need the DB and are
  // covered by the Docker-gated integration test.
  it("422s when neither an email nor a form URL is provided", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/jurisdictions/0644000/suggest-contact",
      payload: { note: "no contact here" },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("422s a malformed contact email", async () => {
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/jurisdictions/0644000/suggest-contact",
      payload: { email: "not-an-email" },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })
})

describe("GET /map/cleanups bbox validation (P2)", () => {
  // The bbox ordering check runs at query-parse time, BEFORE any DB access, so an inverted bbox is a
  // clean 422 even with no database wired (the valid-bbox happy path needs Postgres -> integration test).
  it("422s an inverted bbox (west >= east) without a silent empty result", async () => {
    app = await buildServer({ env: loadEnv() })
    const bbox = JSON.stringify({ west: -118.2, south: 34.0, east: -118.5, north: 34.2 })
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/cleanups?bbox=${encodeURIComponent(bbox)}`,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe("VALIDATION")
  })

  it("422s a degenerate bbox (south >= north)", async () => {
    app = await buildServer({ env: loadEnv() })
    const bbox = JSON.stringify({ west: -118.5, south: 34.2, east: -118.2, north: 34.0 })
    const res = await app.inject({
      method: "GET",
      url: `/v1/map/cleanups?bbox=${encodeURIComponent(bbox)}`,
    })
    expect(res.statusCode).toBe(422)
  })
})

describe("POST /map/suggest", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Capture every outbound provider request; the body shape is Photon's (no MAPBOX_TOKEN in test env). */
  function captureFetch(urls: string[]): void {
    vi.stubGlobal("fetch", (input: string | URL) => {
      urls.push(String(input))
      return Promise.resolve(
        new Response(JSON.stringify({ features: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    })
  }

  /**
   * F162: the contract's `language` field (the caller's app locale) has to REACH the provider. The route
   * used to destructure only q/proximity/proximityZoom/limit, so every request was silently English and
   * the drop was invisible (200 + plausible results). "de" is one of Photon's supported languages, so a
   * forwarded value survives `photonLang` verbatim while a dropped one folds to the "en" default.
   */
  it("F162: forwards the caller's language to the suggest provider", async () => {
    const urls: string[] = []
    captureFetch(urls)
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/suggest",
      payload: { q: "Marienplatz", language: "de" },
    })
    expect(res.statusCode).toBe(200)
    expect(urls).toHaveLength(1)
    expect(new URL(urls[0]!).searchParams.get("lang")).toBe("de")
    expect(new URL(urls[0]!).searchParams.get("q")).toBe("Marienplatz")
  })

  it('keeps the provider\'s "en" default when the caller sends no language', async () => {
    const urls: string[] = []
    captureFetch(urls)
    app = await buildServer({ env: loadEnv() })
    const res = await app.inject({
      method: "POST",
      url: "/v1/map/suggest",
      payload: { q: "Main Street" },
    })
    expect(res.statusCode).toBe(200)
    expect(new URL(urls[0]!).searchParams.get("lang")).toBe("en")
  })
})
