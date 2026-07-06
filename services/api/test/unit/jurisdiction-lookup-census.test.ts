import { describe, it, expect } from "vitest"
import {
  parseCensusGeographies,
  CensusJurisdictionLookup,
  FakeJurisdictionLookup,
} from "../../src/adapters/jurisdiction-lookup.census.js"


const BASE_URL = "https://example.test/geocoder/geographies/coordinates"

function body(geographies: Record<string, unknown>): unknown {
  return { result: { geographies } }
}

function feature(geoid: string, name: string): Record<string, unknown> {
  return { GEOID: geoid, NAME: name }
}

function fakeResponse(opts: { ok: boolean; json: () => unknown | Promise<unknown> }): Response {
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
      parseCensusGeographies(
        body({ "Incorporated Places": [], Counties: [], States: [] }),
      ),
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
      parseCensusGeographies(
        body({ "Incorporated Places": [{ GEOID: "0644000", NAME: "   " }] }),
      ),
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
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calledUrl = String(input)
      return fakeResponse({
        ok: true,
        json: () => body({ "Incorporated Places": [feature("0644000", "Los Angeles")] }),
      })
    }) as unknown as typeof fetch

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

  it("returns null on a non-200 response", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: false, json: () => ({}) })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
  })

  it("returns null when fetch rejects (network error) — never throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
  })

  it("returns null when the body is malformed (json() throws) — never throws", async () => {
    const fetchImpl = (async () =>
      fakeResponse({
        ok: true,
        json: () => {
          throw new SyntaxError("Unexpected token < in JSON")
        },
      })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
  })

  it("returns null when the request is aborted/times out — never throws", async () => {
    const fetchImpl = ((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        }
      })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 1, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
  })

  it("returns null when a 200 body parses to no jurisdiction", async () => {
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
