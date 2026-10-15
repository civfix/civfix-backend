import { describe, it, expect } from "vitest"
import {
  parseCensusGeographies,
  CachedJurisdictionLookup,
  CensusJurisdictionLookup,
  FakeJurisdictionLookup,
  JurisdictionLookupUnavailableError,
  JURISDICTION_LOOKUP_CACHE_TTL_MS,
  type JurisdictionLookup,
  type JurisdictionLookupResult,
} from "../../src/adapters/jurisdiction-lookup.census.js"

const BASE_URL = "https://example.test/geocoder/geographies/coordinates"

function body(geographies: Record<string, unknown>): unknown {
  return { result: { geographies } }
}

function feature(geoid: string, name: string): Record<string, unknown> {
  return { GEOID: geoid, NAME: name }
}

function fakeResponse(opts: { ok: boolean; json: () => unknown }): Response {
  return {
    ok: opts.ok,
    json: async () => opts.json(),
  } as unknown as Response
}

describe("parseCensusGeographies (pure)", () => {
  it("prefers Incorporated Places over Counties/States and maps to 'place'", () => {
    const result = parseCensusGeographies(
      body({
        "Incorporated Places": [feature("0644000", "Los Angeles")],
        Counties: [feature("06037", "Los Angeles County")],
        States: [feature("06", "California")],
      }),
    )
    expect(result).toEqual({ geoid: "0644000", name: "Los Angeles", layer: "place" })
  })

  it("falls to Counties (layer 'county') when there is no Incorporated Place", () => {
    const result = parseCensusGeographies(
      body({
        "Incorporated Places": [],
        Counties: [feature("06037", "Los Angeles County")],
        States: [feature("06", "California")],
      }),
    )
    expect(result).toEqual({ geoid: "06037", name: "Los Angeles County", layer: "county" })
  })

  it("falls to States (layer 'state') when only a state collection is present", () => {
    const result = parseCensusGeographies(body({ States: [feature("06", "California")] }))
    expect(result).toEqual({ geoid: "06", name: "California", layer: "state" })
  })

  it("returns null for an empty geographies object", () => {
    expect(parseCensusGeographies(body({}))).toBeNull()
  })

  it("returns null when all three collections are present but empty", () => {
    expect(
      parseCensusGeographies(body({ "Incorporated Places": [], Counties: [], States: [] })),
    ).toBeNull()
  })

  it("returns null when the most-specific feature is missing GEOID or NAME (no silent degrade)", () => {
    expect(
      parseCensusGeographies(
        body({
          "Incorporated Places": [{ NAME: "Los Angeles" }],
          Counties: [feature("06037", "Los Angeles County")],
        }),
      ),
    ).toBeNull()
    expect(
      parseCensusGeographies(body({ "Incorporated Places": [{ GEOID: "0644000", NAME: "   " }] })),
    ).toBeNull()
  })

  it("returns null for completely malformed input (no throw)", () => {
    expect(parseCensusGeographies("nope")).toBeNull()
    expect(parseCensusGeographies(42)).toBeNull()
    expect(parseCensusGeographies(null)).toBeNull()
    expect(parseCensusGeographies(undefined)).toBeNull()
    expect(parseCensusGeographies({})).toBeNull()
    expect(parseCensusGeographies({ result: null })).toBeNull()
    expect(parseCensusGeographies({ result: { geographies: null } })).toBeNull()
    expect(parseCensusGeographies({ result: { geographies: 7 } })).toBeNull()
  })
})

describe("CensusJurisdictionLookup.lookup (injected fake fetch)", () => {
  it("returns the parsed result on a 200 + valid body, and hits the injected base URL with the right query", async () => {
    let calledUrl = ""
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the adapter under test calls fetch with a string URL
      calledUrl = String(input)
      return fakeResponse({
        ok: true,
        json: () => body({ "Incorporated Places": [feature("0644000", "Los Angeles")] }),
      })
    }

    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    const result = await lookup.lookup(34.05, -118.25)

    expect(result).toEqual({ geoid: "0644000", name: "Los Angeles", layer: "place" })
    expect(calledUrl.startsWith(`${BASE_URL}?`)).toBe(true)
    expect(calledUrl).toContain("x=-118.25")
    expect(calledUrl).toContain("y=34.05")
    expect(calledUrl).toContain("benchmark=Public_AR_Current")
    expect(calledUrl).toContain("vintage=Current_Current")
    expect(calledUrl).toContain("format=json")
  })

  it("THROWS unavailable on a non-200 response (F126: not a genuine miss)", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, json: () => ({}) })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).rejects.toBeInstanceOf(JurisdictionLookupUnavailableError)
  })

  it("THROWS unavailable when fetch rejects (network error)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).rejects.toBeInstanceOf(JurisdictionLookupUnavailableError)
  })

  it("THROWS unavailable when the body is malformed (json() throws)", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        ok: true,
        json: () => {
          throw new SyntaxError("Unexpected token < in JSON")
        },
      })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).rejects.toBeInstanceOf(JurisdictionLookupUnavailableError)
  })

  it("THROWS unavailable when the request is aborted/times out", async () => {
    const fetchImpl = (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        }
      })
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 1, fetchImpl })
    await expect(lookup.lookup(1, 2)).rejects.toBeInstanceOf(JurisdictionLookupUnavailableError)
  })

  it("returns null (genuine miss) when a 200 body parses to no jurisdiction", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: true, json: () => body({}) })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
  })

  it("returns null for a non-finite coordinate without calling fetch (defensive narrowing)", async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return fakeResponse({ ok: true, json: () => body({}) })
    }) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(Number.NaN, -118.25)).resolves.toBeNull()
    await expect(lookup.lookup(34.05, Number.POSITIVE_INFINITY)).resolves.toBeNull()
    expect(called).toBe(false)
  })
})

describe("FakeJurisdictionLookup", () => {
  it("returns null by default (offline local-only behavior)", async () => {
    await expect(new FakeJurisdictionLookup().lookup(1, 2)).resolves.toBeNull()
  })

  it("returns the canned result when one is supplied", async () => {
    const canned = { geoid: "0644000", name: "Los Angeles", layer: "place" } as const
    await expect(new FakeJurisdictionLookup(canned).lookup(1, 2)).resolves.toEqual(canned)
  })
})

describe("CachedJurisdictionLookup", () => {
  const LA: JurisdictionLookupResult = { geoid: "0644000", name: "Los Angeles", layer: "place" }

  function countingLookup(
    result: JurisdictionLookupResult | null = LA,
  ): JurisdictionLookup & { calls: Array<[number, number]> } {
    const calls: Array<[number, number]> = []
    return {
      calls,
      lookup(lat: number, lng: number) {
        calls.push([lat, lng])
        return Promise.resolve(result)
      },
    }
  }

  it("serves a repeat lookup of the same point from the memo", async () => {
    const inner = countingLookup()
    const cached = new CachedJurisdictionLookup(inner)

    await expect(cached.lookup(34.05, -118.25)).resolves.toEqual(LA)
    await expect(cached.lookup(34.05, -118.25)).resolves.toEqual(LA)
    await expect(cached.lookup(34.05, -118.25)).resolves.toEqual(LA)

    expect(inner.calls).toHaveLength(1)
  })

  it("caches MISSES too (an uncached negative would leave the amplification open)", async () => {
    const inner = countingLookup(null)
    const cached = new CachedJurisdictionLookup(inner)

    await expect(cached.lookup(40, -100)).resolves.toBeNull()
    await expect(cached.lookup(40, -100)).resolves.toBeNull()

    expect(inner.calls).toHaveLength(1)
  })

  it("passes the FULL-precision coordinate through; only the memo KEY is rounded", async () => {
    const inner = countingLookup()
    const cached = new CachedJurisdictionLookup(inner)

    await cached.lookup(34.0512345, -118.2512345)
    await cached.lookup(34.05123, -118.25124)

    expect(inner.calls).toEqual([[34.0512345, -118.2512345]])
  })

  it("does not share entries across distinct points", async () => {
    const inner = countingLookup()
    const cached = new CachedJurisdictionLookup(inner)

    await cached.lookup(34.05, -118.25)
    await cached.lookup(34.06, -118.25)
    await cached.lookup(34.05, -118.26)

    expect(inner.calls).toHaveLength(3)
  })

  it("re-fetches once the TTL has elapsed", async () => {
    const inner = countingLookup()
    let clock = 1_000
    const cached = new CachedJurisdictionLookup(inner, { ttlMs: 60_000, now: () => clock })

    await cached.lookup(34.05, -118.25)
    clock += 59_999
    await cached.lookup(34.05, -118.25)
    expect(inner.calls).toHaveLength(1)

    clock += 2
    await cached.lookup(34.05, -118.25)
    expect(inner.calls).toHaveLength(2)
  })

  it("collapses concurrent calls for one point into a single in-flight lookup", async () => {
    let calls = 0
    let release: ((value: JurisdictionLookupResult | null) => void) | null = null
    const inner: JurisdictionLookup = {
      lookup: () => {
        calls += 1
        return new Promise((resolve) => {
          release = resolve
        })
      },
    }
    const cached = new CachedJurisdictionLookup(inner)

    const all = Promise.all([
      cached.lookup(34.05, -118.25),
      cached.lookup(34.05, -118.25),
      cached.lookup(34.05, -118.25),
    ])
    expect(calls).toBe(1)
    release!(LA)
    await expect(all).resolves.toEqual([LA, LA, LA])
    expect(calls).toBe(1)
  })

  it("never retains a FAILED lookup", async () => {
    let calls = 0
    const inner: JurisdictionLookup = {
      lookup: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(LA)
      },
    }
    const cached = new CachedJurisdictionLookup(inner)

    await expect(cached.lookup(34.05, -118.25)).rejects.toThrow("boom")
    await expect(cached.lookup(34.05, -118.25)).resolves.toEqual(LA)
    expect(calls).toBe(2)
  })

  it("stays bounded: past maxEntries the oldest points are evicted", async () => {
    const inner = countingLookup()
    const cached = new CachedJurisdictionLookup(inner, { maxEntries: 2 })

    await cached.lookup(1, 1)
    await cached.lookup(2, 2)
    await cached.lookup(3, 3)
    await cached.lookup(3, 3)
    expect(inner.calls).toHaveLength(3)
    await cached.lookup(1, 1)
    expect(inner.calls).toHaveLength(4)
  })

  it("passes non-finite coordinates straight through (never keyed)", async () => {
    const inner = countingLookup()
    const cached = new CachedJurisdictionLookup(inner)

    await cached.lookup(Number.NaN, -118.25)
    await cached.lookup(Number.NaN, -118.25)

    expect(inner.calls).toHaveLength(2)
  })

  it("defaults to a minutes-long TTL (boundaries are effectively static)", () => {
    expect(JURISDICTION_LOOKUP_CACHE_TTL_MS).toBeGreaterThanOrEqual(60_000)
  })
})
