import { describe, it, expect } from "vitest"
import {
  makeMapboxReverseGeocode,
  formatMapboxReverse,
  mapboxPrecision,
} from "../../src/adapters/reverse-geocode.mapbox.js"

function okFetch(props: unknown): typeof fetch {
  return async () =>
    ({
      ok: true,
      json: async () => ({ features: [{ properties: props }] }),
    }) as unknown as Response
}

describe("formatMapboxReverse", () => {
  it("builds '<addr>, City, ST' and drops US country", () => {
    expect(
      formatMapboxReverse({
        name: "123 Imperial Hwy",
        context: {
          place: { name: "Inglewood" },
          region: { region_code: "CA" },
          country: { country_code: "us", name: "United States" },
        },
      }),
    ).toBe("123 Imperial Hwy, Inglewood, CA")
  })
  it("keeps a non-US country", () => {
    expect(
      formatMapboxReverse({
        name: "Stanley Park",
        context: {
          place: { name: "Vancouver" },
          region: { region_code: "BC" },
          country: { country_code: "ca", name: "Canada" },
        },
      }),
    ).toBe("Stanley Park, Vancouver, BC, Canada")
  })
  it("returns null for empty input", () => {
    expect(formatMapboxReverse({})).toBeNull()
  })
})

describe("makeMapboxReverseGeocode", () => {
  it("returns a formatted address for a coordinate", async () => {
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: okFetch({
        feature_type: "address",
        name: "1 Main St",
        context: {
          place: { name: "Springfield" },
          region: { region_code: "IL" },
          country: { country_code: "us" },
        },
      }),
    })
    expect(await geocode(39.8, -89.6)).toEqual({
      line: "1 Main St, Springfield, IL",
      precision: "street",
      provider: "mapbox",
    })
  })
  it("returns null on non-ok HTTP", async () => {
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: async () => ({ ok: false }) as unknown as Response,
    })
    expect(await geocode(39.8, -89.6)).toBeNull()
  })
  it("returns null when fetch throws", async () => {
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: async () => {
        throw new Error("net")
      },
    })
    expect(await geocode(39.8, -89.6)).toBeNull()
  })
  it("returns null for empty features", async () => {
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: async () =>
        ({
          ok: true,
          json: async () => ({ features: [] }),
        }) as unknown as Response,
    })
    expect(await geocode(39.8, -89.6)).toBeNull()
  })
  it("does not call fetch for a non-finite coordinate", async () => {
    let called = false
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: async () => {
        called = true
        return { ok: true, json: async () => ({}) } as unknown as Response
      },
    })
    expect(await geocode(Number.NaN, -89.6)).toBeNull()
    expect(called).toBe(false)
  })
  it("sends redirect:error (SSRF guard)", async () => {
    let opts: RequestInit | undefined
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: (async (_u: string, o: RequestInit) => {
        opts = o
        return { ok: true, json: async () => ({ features: [] }) } as unknown as Response
      }) as unknown as typeof fetch,
    })
    await geocode(39.8, -89.6)
    expect(opts?.redirect).toBe("error")
  })
})

/**
 * Mapbox is the OPT-IN primary, so what it REFUSES to answer matters as much as what it answers: a
 * place-only hit must fall through to Photon and then to the local TIGER locality rung rather than
 * short-circuit the chain with the vaguest line available.
 */
describe("mapboxPrecision", () => {
  it("claims street only with a house number", () => {
    expect(
      mapboxPrecision({ context: { address: { address_number: "123", name: "123 Main St" } } }),
    ).toBe("street")
    expect(mapboxPrecision({ feature_type: "address", name: "123 Main St" })).toBe("street")
  })

  it("refuses street for a digit-leading name the response never called an address", () => {
    expect(mapboxPrecision({ name: "123 Main St" })).toBeNull()
    expect(
      mapboxPrecision({
        feature_type: "poi",
        name: "24 Hour Fitness",
        context: { street: { name: "Sepulveda Blvd" } },
      }),
    ).toBe("intersection")
  })

  it("claims intersection for a named street with no number", () => {
    expect(mapboxPrecision({ name: "Main St", context: { street: { name: "Main St" } } })).toBe(
      "intersection",
    )
  })

  it("claims NOTHING for a place-only hit, so the chain keeps going", () => {
    expect(
      mapboxPrecision({ name: "Los Angeles", context: { place: { name: "Los Angeles" } } }),
    ).toBeNull()
    expect(mapboxPrecision({})).toBeNull()
  })
})

describe("makeMapboxReverseGeocode precision ladder", () => {
  it("returns intersection (no fabricated number) for a street-only feature", async () => {
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: okFetch({
        name: "Main St",
        context: {
          street: { name: "Main St" },
          place: { name: "Springfield" },
          region: { region_code: "IL" },
        },
      }),
    })
    expect(await geocode(39.8, -89.6)).toEqual({
      line: "Main St, Springfield, IL",
      precision: "intersection",
      provider: "mapbox",
    })
  })

  it("returns null rather than a locality line", async () => {
    const geocode = makeMapboxReverseGeocode({
      token: "pk.test",
      fetchImpl: okFetch({
        name: "Springfield",
        context: { place: { name: "Springfield" }, region: { region_code: "IL" } },
      }),
    })
    expect(await geocode(39.8, -89.6)).toBeNull()
  })
})
