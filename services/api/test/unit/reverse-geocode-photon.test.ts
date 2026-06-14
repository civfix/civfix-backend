import { describe, it, expect } from "vitest"
import {
  makePhotonReverseGeocode,
  formatPhotonReverse,
} from "../../src/adapters/reverse-geocode.photon.js"

/**
 * Unit tests for the best-effort Photon reverse geocoder. The factory takes an injected `fetchImpl`, so
 * the whole thing runs offline against canned responses. The contract under test: a usable result is
 * formatted into a one-line address; EVERYTHING else (bad coords, HTTP error, network throw, empty
 * result) resolves to null so report creation is never blocked.
 */

describe("formatPhotonReverse", () => {
  it("builds a '<number> <street>, City, ST' line and drops a US country", () => {
    expect(
      formatPhotonReverse({
        housenumber: "123",
        street: "Imperial Hwy",
        city: "Inglewood",
        state: "CA",
        country: "United States",
      }),
    ).toBe("123 Imperial Hwy, Inglewood, CA")
  })

  it("falls back to the place name and keeps a non-US country", () => {
    expect(
      formatPhotonReverse({ name: "Stanley Park", city: "Vancouver", state: "BC", country: "Canada" }),
    ).toBe("Stanley Park, Vancouver, BC, Canada")
  })

  it("returns null when there is nothing usable", () => {
    expect(formatPhotonReverse({})).toBeNull()
  })
})

/** A fake fetch returning a single Photon feature with the given properties. */
function okFetch(props: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, json: async () => ({ features: [{ properties: props }] }) }) as unknown as Response) as unknown as typeof fetch
}

describe("makePhotonReverseGeocode", () => {
  it("returns a formatted street address for a coordinate", async () => {
    const geocode = makePhotonReverseGeocode({
      fetchImpl: okFetch({ housenumber: "1", street: "Main St", city: "Springfield", state: "IL" }),
    })
    expect(await geocode(39.8, -89.6)).toBe("1 Main St, Springfield, IL")
  })

  it("returns null on a non-ok HTTP response", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as unknown as typeof fetch
    expect(await makePhotonReverseGeocode({ fetchImpl })(1, 2)).toBeNull()
  })

  it("returns null when fetch throws (network / abort)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    expect(await makePhotonReverseGeocode({ fetchImpl })(1, 2)).toBeNull()
  })

  it("returns null when Photon has no features", async () => {
    const fetchImpl = (async () =>
      ({ ok: true, json: async () => ({ features: [] }) }) as unknown as Response) as unknown as typeof fetch
    expect(await makePhotonReverseGeocode({ fetchImpl })(1, 2)).toBeNull()
  })

  it("does not fetch for non-finite coordinates", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return { ok: true, json: async () => ({ features: [] }) } as unknown as Response
    }) as unknown as typeof fetch
    expect(await makePhotonReverseGeocode({ fetchImpl })(Number.NaN, 2)).toBeNull()
    expect(called).toBe(false)
  })
})
