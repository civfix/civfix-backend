import { describe, it, expect } from "vitest"
import {
  composePhotonReverse,
  distanceMeters,
  isResidentialName,
  makePhotonReverseGeocode,
  formatPhotonReverse,
} from "../../src/adapters/reverse-geocode.photon.js"

/**
 * The Photon reverse geocoder is best-effort: a usable result is formatted into a one-line address;
 * EVERYTHING else (bad coords, HTTP error, network throw, empty result) resolves to null so report
 * creation is never blocked.
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
      formatPhotonReverse({
        name: "Stanley Park",
        city: "Vancouver",
        state: "BC",
        country: "Canada",
      }),
    ).toBe("Stanley Park, Vancouver, BC, Canada")
  })

  it("returns null when there is nothing usable", () => {
    expect(formatPhotonReverse({})).toBeNull()
  })
})

function okFetch(props: unknown): typeof fetch {
  return async () =>
    ({
      ok: true,
      json: async () => ({ features: [{ properties: props }] }),
    }) as unknown as Response
}

describe("makePhotonReverseGeocode", () => {
  it("returns a formatted street address for a coordinate", async () => {
    const geocode = makePhotonReverseGeocode({
      fetchImpl: okFetch({ housenumber: "1", street: "Main St", city: "Springfield", state: "IL" }),
    })
    expect(await geocode(39.8, -89.6)).toEqual({
      line: "1 Main St, Springfield, IL",
      precision: "street",
      provider: "photon",
    })
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
      ({
        ok: true,
        json: async () => ({ features: [] }),
      }) as unknown as Response) as unknown as typeof fetch
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

/**
 * The precision ladder (composePhotonReverse). Every rung here is a product decision about how much the
 * platform is allowed to CLAIM from OSM data that chronically lacks house numbers, so each one is
 * pinned: the exact hit, the cross-street composition, the single-road degrade, the landmark, the
 * residential guard that must never surface an occupant's name, and the refusal to answer at all rather
 * than return a city (the local TIGER geocoder owns the locality rung).
 */

const PIN = { lat: 34.05, lng: -118.25 }

/** A feature at an offset in metres roughly north of the pin. */
function featureAt(
  props: Record<string, unknown>,
  northMeters: number,
): {
  properties: Record<string, unknown>
  geometry: { coordinates: [number, number] }
} {
  const dLat = northMeters / 111_320
  return { properties: props, geometry: { coordinates: [PIN.lng, PIN.lat + dLat] } }
}

describe("distanceMeters", () => {
  it("measures a small northward offset to within a metre", () => {
    expect(distanceMeters(PIN, { lat: PIN.lat + 100 / 111_320, lng: PIN.lng })).toBeCloseTo(100, 0)
  })

  it("is zero for the same point", () => {
    expect(distanceMeters(PIN, PIN)).toBe(0)
  })
})

describe("isResidentialName", () => {
  it("flags a building or a place=house, which can carry an occupant name", () => {
    expect(
      isResidentialName({ osm_key: "building", osm_value: "residential", name: "The Smiths" }),
    ).toBe(true)
    expect(isResidentialName({ osm_key: "place", osm_value: "house", name: "Rose Cottage" })).toBe(
      true,
    )
  })

  it("does not flag a public amenity", () => {
    expect(
      isResidentialName({ osm_key: "leisure", osm_value: "park", name: "Vista Hermosa Park" }),
    ).toBe(false)
  })
})

describe("composePhotonReverse ladder", () => {
  it("street: a house number plus a street wins outright", () => {
    const composed = composePhotonReverse(
      [
        featureAt({ osm_key: "leisure", name: "Some Park", city: "Los Angeles", state: "CA" }, 5),
        featureAt(
          {
            housenumber: "123",
            street: "Main St",
            city: "Inglewood",
            state: "CA",
            osm_key: "place",
          },
          12,
        ),
      ],
      PIN,
    )
    expect(composed).toEqual({ line: "123 Main St, Inglewood, CA", precision: "street" })
  })

  it("intersection: two distinct named roads within 40 m compose a cross street", () => {
    const composed = composePhotonReverse(
      [
        featureAt({ osm_key: "highway", street: "Main St", city: "Inglewood", state: "CA" }, 8),
        featureAt({ osm_key: "highway", street: "5th Ave", city: "Inglewood", state: "CA" }, 20),
      ],
      PIN,
    )
    expect(composed).toEqual({
      line: "Main St & 5th Ave, Inglewood, CA",
      precision: "intersection",
    })
  })

  it("intersection: one road alone degrades to the bare street, never an invented number", () => {
    const composed = composePhotonReverse(
      [featureAt({ osm_key: "highway", street: "Main St", city: "Inglewood", state: "CA" }, 8)],
      PIN,
    )
    expect(composed).toEqual({ line: "Main St, Inglewood, CA", precision: "intersection" })
  })

  it("intersection: the same road name twice is ONE road, not a crossing with itself", () => {
    const composed = composePhotonReverse(
      [
        featureAt({ osm_key: "highway", street: "Main St", city: "Inglewood", state: "CA" }, 5),
        featureAt({ osm_key: "highway", street: "Main St", city: "Inglewood", state: "CA" }, 22),
      ],
      PIN,
    )
    expect(composed).toEqual({ line: "Main St, Inglewood, CA", precision: "intersection" })
  })

  it("intersection: a road beyond 40 m does not join the composition", () => {
    const composed = composePhotonReverse(
      [
        featureAt({ osm_key: "highway", street: "Main St", city: "Inglewood", state: "CA" }, 10),
        featureAt({ osm_key: "highway", street: "Far Blvd", city: "Inglewood", state: "CA" }, 55),
      ],
      PIN,
    )
    expect(composed).toEqual({ line: "Main St, Inglewood, CA", precision: "intersection" })
  })

  it("landmark: a named public feature within 60 m, stored RAW (no 'Near ' prefix)", () => {
    const composed = composePhotonReverse(
      [
        featureAt(
          {
            osm_key: "leisure",
            osm_value: "park",
            name: "Vista Hermosa Park",
            city: "Los Angeles",
            state: "CA",
          },
          45,
        ),
      ],
      PIN,
    )
    expect(composed).toEqual({
      line: "Vista Hermosa Park, Los Angeles, CA",
      precision: "landmark",
    })
  })

  it("landmark guard: a residential building's name is NEVER surfaced", () => {
    const composed = composePhotonReverse(
      [
        featureAt(
          {
            osm_key: "building",
            osm_value: "residential",
            name: "The Hendersons",
            city: "Los Angeles",
            state: "CA",
          },
          5,
        ),
      ],
      PIN,
    )
    expect(composed).toBeNull()
  })

  it("landmark: a feature beyond 60 m is out of range", () => {
    const composed = composePhotonReverse(
      [featureAt({ osm_key: "amenity", name: "Library", city: "Los Angeles", state: "CA" }, 90)],
      PIN,
    )
    expect(composed).toBeNull()
  })

  it("never claims locality: a city-only feature yields nothing (TIGER owns that rung)", () => {
    const composed = composePhotonReverse(
      [featureAt({ osm_key: "place", osm_value: "city", name: "Los Angeles", state: "CA" }, 5)],
      PIN,
    )
    expect(composed).toBeNull()
  })

  it("returns null for an empty feature set", () => {
    expect(composePhotonReverse([], PIN)).toBeNull()
  })
})

describe("makePhotonReverseGeocode request shape", () => {
  it("asks for several features within a 50 m radius so the ladder has candidates", async () => {
    let seen = ""
    const fetchImpl = (async (u: string) => {
      seen = u
      return { ok: true, json: async () => ({ features: [] }) } as unknown as Response
    }) as unknown as typeof fetch
    await makePhotonReverseGeocode({ fetchImpl })(34.05, -118.25)
    expect(seen).toContain("limit=5")
    expect(seen).toContain("radius=0.05")
  })
})
