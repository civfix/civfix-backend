// Pins the order of claims and the failure behavior, not any vendor's wire format. The ladder sits on the
// report-create path, so a failing provider, geocoder or cache costs one rung and never an error, and only
// a chain answer is cached so an outage cannot lock a point at city grade for half a year.

import { describe, it, expect } from "vitest"
import { FakeGeocoder } from "@civfix/shared/fakes"
import { geocodePointKey } from "@civfix/shared"
import type { ReverseGeocode, ReverseResult } from "../../src/adapters/reverse-geocode.chain.js"
import {
  addressProvenance,
  makeAddressResolver,
  type ResolvedAddress,
} from "../../src/services/address-resolver.js"
import {
  GEOCODE_CACHE_NEGATIVE_TTL_MS,
  GEOCODE_CACHE_TTL_MS,
  isChainAnswer,
  isFreshEntry,
  makeGeocodeCache,
  type GeocodeCache,
  type GeocodeCacheEntry,
} from "../../src/services/geocode-cache.js"
import type { Sql } from "../../src/db/client.js"

const LA = { lat: 34.05223, lng: -118.24368 }

function chain(result: ReverseResult | null): ReverseGeocode & { calls: number } {
  const fn = Object.assign(
    async (): Promise<ReverseResult | null> => {
      fn.calls += 1
      return result
    },
    { calls: 0 },
  )
  return fn
}

function memoryCache(): GeocodeCache & { rows: Map<string, GeocodeCacheEntry>; writes: number } {
  const rows = new Map<string, GeocodeCacheEntry>()
  const cache = {
    rows,
    writes: 0,
    read: async (key: string) => rows.get(key) ?? null,
    write: async (key: string, entry: GeocodeCacheEntry) => {
      cache.writes += 1
      rows.set(key, entry)
    },
  }
  return cache
}

function expiringCache(clock: { now: Date }): GeocodeCache & {
  rows: Map<string, GeocodeCacheEntry & { resolvedAt: Date }>
} {
  const rows = new Map<string, GeocodeCacheEntry & { resolvedAt: Date }>()
  return {
    rows,
    read: async (key: string) => {
      const row = rows.get(key)
      if (row === undefined) return null
      return isFreshEntry(row, clock.now) ? row : null
    },
    write: async (key: string, entry: GeocodeCacheEntry) => {
      rows.set(key, { ...entry, resolvedAt: clock.now })
    },
  }
}

describe("makeAddressResolver ladder", () => {
  it("takes the chain's rung verbatim and still reports the locality hint", async () => {
    const resolve = makeAddressResolver({
      streetReverseGeocode: chain({
        line: "123 Main St, Inglewood, CA",
        precision: "street",
        provider: "photon",
      }),
      geocoder: new FakeGeocoder(),
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "123 Main St, Inglewood, CA",
      precision: "street",
      cityStateLabel: "Los Angeles, CA",
    })
  })

  it("passes a landmark line through RAW - the 'Near ' prefix is a display concern", async () => {
    const resolve = makeAddressResolver({
      streetReverseGeocode: chain({
        line: "Vista Hermosa Park, Los Angeles, CA",
        precision: "landmark",
        provider: "photon",
      }),
      geocoder: new FakeGeocoder(),
    })

    const out = await resolve(LA.lat, LA.lng)
    expect(out.address).toBe("Vista Hermosa Park, Los Angeles, CA")
    expect(out.address?.startsWith("Near ")).toBe(false)
    expect(out.precision).toBe("landmark")
  })

  it("degrades a chain miss to the TIGER label at locality", async () => {
    const resolve = makeAddressResolver({
      streetReverseGeocode: chain(null),
      geocoder: new FakeGeocoder(),
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "Los Angeles, CA",
      precision: "locality",
      cityStateLabel: "Los Angeles, CA",
    })
  })

  it("answers nothing-at-all when both halves come up empty, with cityStateLabel still a string", async () => {
    const resolve = makeAddressResolver({
      streetReverseGeocode: chain(null),
      geocoder: { cityStateLabel: async () => null },
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: null,
      precision: null,
      cityStateLabel: "",
    })
  })

  it("a THROWING provider costs one rung, never an error", async () => {
    const resolve = makeAddressResolver({
      streetReverseGeocode: async () => {
        throw new Error("vendor down")
      },
      geocoder: new FakeGeocoder(),
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "Los Angeles, CA",
      precision: "locality",
      cityStateLabel: "Los Angeles, CA",
    })
  })

  it("a THROWING geocoder still lets the chain's answer through", async () => {
    const resolve = makeAddressResolver({
      streetReverseGeocode: chain({
        line: "123 Main St, Inglewood, CA",
        precision: "street",
        provider: "mapbox",
      }),
      geocoder: {
        cityStateLabel: async () => {
          throw new Error("postgis down")
        },
      },
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "123 Main St, Inglewood, CA",
      precision: "street",
      cityStateLabel: "",
    })
  })

  it("does not call a provider for a non-finite coordinate", async () => {
    const provider = chain({ line: "x", precision: "street", provider: "photon" })
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: new FakeGeocoder(),
    })

    await expect(resolve(Number.NaN, LA.lng)).resolves.toEqual({
      address: null,
      precision: null,
      cityStateLabel: "",
    })
    expect(provider.calls).toBe(0)
  })
})

describe("makeAddressResolver caching", () => {
  it("reads through: the second resolve of a point makes NO provider call", async () => {
    const provider = chain({
      line: "123 Main St, Inglewood, CA",
      precision: "street",
      provider: "photon",
    })
    const cache = memoryCache()
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: new FakeGeocoder(),
      cache,
    })

    await resolve(LA.lat, LA.lng)
    await resolve(LA.lat, LA.lng)

    expect(provider.calls).toBe(1)
    expect(cache.writes).toBe(1)
  })

  it("keys on the SHARED 5-decimal point key, so a sub-metre pin nudge is a hit", async () => {
    const provider = chain({
      line: "Main St, Inglewood, CA",
      precision: "intersection",
      provider: "photon",
    })
    const cache = memoryCache()
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: new FakeGeocoder(),
      cache,
    })

    await resolve(LA.lat, LA.lng)
    // Well inside the 5th decimal (~1.1 m), as a dragged pin produces.
    await resolve(LA.lat + 0.000001, LA.lng - 0.000002)

    expect(provider.calls).toBe(1)
    expect([...cache.rows.keys()]).toEqual([geocodePointKey(LA)])
  })

  it("caches the NEGATIVE result too, so a dead point does not re-fire the chain per drag", async () => {
    const provider = chain(null)
    const cache = memoryCache()
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: { cityStateLabel: async () => null },
      cache,
    })

    await resolve(LA.lat, LA.lng)
    await resolve(LA.lat, LA.lng)

    expect(provider.calls).toBe(1)
    expect(cache.rows.get(geocodePointKey(LA))).toEqual({
      address: null,
      precision: null,
      cityStateLabel: "",
      provider: null,
    })
    // The second resolve must NOT rewrite the row: a refreshed resolved_at would push the negative
    // entry's expiry out forever on a point that is being resolved continuously.
    expect(cache.writes).toBe(1)
  })

  it("records which adapter answered", async () => {
    const cache = memoryCache()
    await makeAddressResolver({
      streetReverseGeocode: chain({
        line: "123 Main St, Inglewood, CA",
        precision: "street",
        provider: "mapbox",
      }),
      geocoder: new FakeGeocoder(),
      cache,
    })(LA.lat, LA.lng)

    expect(cache.rows.get(geocodePointKey(LA))?.provider).toBe("mapbox")
  })

  it("NEVER caches the locality rung: a chain miss stores a null row, not the TIGER label", async () => {
    const cache = memoryCache()
    const out = await makeAddressResolver({
      streetReverseGeocode: chain(null),
      geocoder: new FakeGeocoder(),
      cache,
    })(LA.lat, LA.lng)

    expect(out).toEqual({
      address: "Los Angeles, CA",
      precision: "locality",
      cityStateLabel: "Los Angeles, CA",
    })
    expect(cache.rows.get(geocodePointKey(LA))).toEqual({
      address: null,
      precision: null,
      cityStateLabel: "Los Angeles, CA",
      provider: null,
    })
  })

  it("re-runs the chain once the negative entry expires, and UPGRADES the point", async () => {
    const clock = { now: new Date("2026-09-16T00:00:00Z") }
    const cache = expiringCache(clock)
    let down = true
    const provider: ReverseGeocode = async () =>
      down ? null : { line: "123 Main St, Inglewood, CA", precision: "street", provider: "photon" }
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: new FakeGeocoder(),
      cache,
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "Los Angeles, CA",
      precision: "locality",
      cityStateLabel: "Los Angeles, CA",
    })
    // The short-TTL null row is what makes the re-run possible at all.
    expect(cache.rows.get(geocodePointKey(LA))?.address).toBeNull()

    down = false
    clock.now = new Date(clock.now.getTime() + GEOCODE_CACHE_NEGATIVE_TTL_MS + 1000)

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "123 Main St, Inglewood, CA",
      precision: "street",
      cityStateLabel: "Los Angeles, CA",
    })
    expect(cache.rows.get(geocodePointKey(LA))?.precision).toBe("street")
  })

  it("keeps serving a chain answer for months - only the misses are short-lived", async () => {
    const clock = { now: new Date("2026-09-16T00:00:00Z") }
    const cache = expiringCache(clock)
    const provider = chain({
      line: "123 Main St, Inglewood, CA",
      precision: "street",
      provider: "photon",
    })
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: new FakeGeocoder(),
      cache,
    })

    await resolve(LA.lat, LA.lng)
    clock.now = new Date(clock.now.getTime() + GEOCODE_CACHE_TTL_MS / 2)
    await expect(resolve(LA.lat, LA.lng)).resolves.toMatchObject({ precision: "street" })

    expect(provider.calls).toBe(1)
  })

  it("an UNREACHABLE cache degrades to no caching, never to an error", async () => {
    const provider = chain({
      line: "123 Main St, Inglewood, CA",
      precision: "street",
      provider: "photon",
    })
    const resolve = makeAddressResolver({
      streetReverseGeocode: provider,
      geocoder: new FakeGeocoder(),
      cache: {
        read: async () => {
          throw new Error("no db")
        },
        write: async () => {
          throw new Error("no db")
        },
      },
    })

    await expect(resolve(LA.lat, LA.lng)).resolves.toEqual({
      address: "123 Main St, Inglewood, CA",
      precision: "street",
      cityStateLabel: "Los Angeles, CA",
    })
    expect(provider.calls).toBe(1)
  })
})

// `makeGeocodeCache` must swallow a DB that is missing, locked or absent entirely (the fully-faked offline
// server has no connection at all), so the resolver can treat it as infallible.
function fakeSql(rows: unknown[], calls: string[] = []): Sql {
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
    calls.push(strings.join(""))
    return Promise.resolve(rows)
  }
  return fn as unknown as Sql
}

describe("makeGeocodeCache", () => {
  it("returns a fresh row", async () => {
    const cache = makeGeocodeCache({
      getSql: () =>
        fakeSql([
          {
            address: "123 Main St, Inglewood, CA",
            address_precision: "street",
            city_state_label: "Inglewood, CA",
            provider: "photon",
            resolved_at: new Date(),
          },
        ]),
    })

    await expect(cache.read("34.05223,-118.24368")).resolves.toEqual({
      address: "123 Main St, Inglewood, CA",
      precision: "street",
      cityStateLabel: "Inglewood, CA",
      provider: "photon",
    })
  })

  it("reports a row past the positive TTL as a MISS, so it is re-resolved and overwritten", async () => {
    const stale = new Date(Date.now() - GEOCODE_CACHE_TTL_MS - 1000)
    const cache = makeGeocodeCache({
      getSql: () =>
        fakeSql([
          {
            address: "123 Main St, Inglewood, CA",
            address_precision: "street",
            city_state_label: "Inglewood, CA",
            provider: "photon",
            resolved_at: stale,
          },
        ]),
    })

    await expect(cache.read("34.05223,-118.24368")).resolves.toBeNull()
  })

  it("expires a NEGATIVE row in minutes: an outage cannot poison a point for months", () => {
    const now = new Date()
    const aged = (ms: number): Date => new Date(now.getTime() - ms)
    const negative = (ms: number): { address: null; precision: null; resolvedAt: Date } => ({
      address: null,
      precision: null,
      resolvedAt: aged(ms),
    })

    expect(isFreshEntry(negative(60 * 60 * 1000), now)).toBe(false)
    expect(isFreshEntry(negative(GEOCODE_CACHE_NEGATIVE_TTL_MS / 2), now)).toBe(true)
    expect(
      isFreshEntry(
        { address: "123 Main St", precision: "street", resolvedAt: aged(60 * 60 * 1000) },
        now,
      ),
    ).toBe(true)
  })

  it("gives a LOCALITY row the negative TTL, so a legacy one cannot outlive the blip that wrote it", () => {
    const now = new Date()
    const row = {
      address: "Los Angeles, CA",
      precision: "locality" as const,
      resolvedAt: new Date(now.getTime() - 60 * 60 * 1000),
    }

    expect(isChainAnswer(row)).toBe(false)
    expect(isFreshEntry(row, now)).toBe(false)
  })

  it("a stale LOCALITY row is a read MISS, so the chain gets its next chance", async () => {
    const cache = makeGeocodeCache({
      getSql: () =>
        fakeSql([
          {
            address: "Los Angeles, CA",
            address_precision: "locality",
            city_state_label: "Los Angeles, CA",
            provider: "tiger",
            resolved_at: new Date(Date.now() - GEOCODE_CACHE_NEGATIVE_TTL_MS - 1000),
          },
        ]),
    })

    await expect(cache.read("34.05223,-118.24368")).resolves.toBeNull()
  })

  it("swallows a DB that is not there at all (the offline faked server)", async () => {
    const cache = makeGeocodeCache({
      getSql: () => {
        throw new Error("no database configured")
      },
    })

    await expect(cache.read("34.05223,-118.24368")).resolves.toBeNull()
    await expect(
      cache.write("34.05223,-118.24368", {
        address: null,
        precision: null,
        cityStateLabel: "",
        provider: null,
      }),
    ).resolves.toBeUndefined()
  })
})

describe("addressProvenance", () => {
  const resolved: ResolvedAddress = {
    address: "123 Main St, Inglewood, CA",
    precision: "street",
    cityStateLabel: "Inglewood, CA",
  }

  it("marks the reporter's own text 'user' with NO precision", () => {
    expect(addressProvenance("NW corner by the bus stop", resolved)).toEqual({
      addr: "NW corner by the bus stop",
      addrSource: "user",
      addrPrecision: null,
    })
  })

  it("marks a server resolve 'resolved' and keeps the rung it reached", () => {
    expect(addressProvenance("", resolved)).toEqual({
      addr: "123 Main St, Inglewood, CA",
      addrSource: "resolved",
      addrPrecision: "street",
    })
  })

  it("keeps a locality-grade snapshot, labelled honestly rather than dropped", () => {
    expect(
      addressProvenance("", {
        address: "Los Angeles, CA",
        precision: "locality",
        cityStateLabel: "Los Angeles, CA",
      }),
    ).toEqual({ addr: "Los Angeles, CA", addrSource: "resolved", addrPrecision: "locality" })
  })

  it("leaves all three NULL when nothing resolved - filing is never blocked on this", () => {
    expect(addressProvenance("", null)).toEqual({
      addr: null,
      addrSource: null,
      addrPrecision: null,
    })
    expect(addressProvenance("", { address: null, precision: null, cityStateLabel: "" })).toEqual({
      addr: null,
      addrSource: null,
      addrPrecision: null,
    })
  })

  it("clamps a server-derived line to the wire cap, which never applied to it", () => {
    const long = "A".repeat(500)
    const out = addressProvenance("", { address: long, precision: "street", cityStateLabel: "" })
    expect(out.addr).toHaveLength(300)
  })
})
