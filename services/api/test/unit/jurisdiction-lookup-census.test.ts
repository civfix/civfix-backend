import { describe, it, expect } from "vitest"
import {
  parseCensusGeographies,
  CensusJurisdictionLookup,
  FakeJurisdictionLookup,
} from "../../src/adapters/jurisdiction-lookup.census.js"

/**
 * Unit tests for the write-time Census jurisdiction fallback. Fully OFFLINE: the pure response parser is
 * driven by mock JSON bodies, and the HTTP impl is exercised with an INJECTED fake fetch (no network, no
 * DB, no real timers). The two invariants under test:
 *   1. parseCensusGeographies precedence (place > county > state) + null on every malformed/empty shape.
 *   2. CensusJurisdictionLookup.lookup is best-effort: it returns the parsed hit on success and null on a
 *      non-200, a network rejection, a malformed body, or a timeout/abort — and NEVER throws.
 */

const BASE_URL = "https://example.test/geocoder/geographies/coordinates"

/** Build a minimal Census Geographies response body with the supplied collections. */
function body(geographies: Record<string, unknown>): unknown {
  return { result: { geographies } }
}

/** A Census feature carries (at least) a GEOID + NAME; we read only those. */
function feature(geoid: string, name: string): Record<string, unknown> {
  return { GEOID: geoid, NAME: name }
}

/** Make a Response-like object good enough for the lookup (ok + json()). */
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
    // A place feature with no GEOID -> null (we do NOT fall through to the county for the same point).
    expect(
      parseCensusGeographies(
        body({
          "Incorporated Places": [{ NAME: "Los Angeles" }],
          Counties: [feature("06037", "Los Angeles County")],
        }),
      ),
    ).toBeNull()
    // A place feature with a blank NAME -> null.
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
    // Type the input via `typeof fetch`'s own parameter type (from @types/node) rather than the DOM
    // global `RequestInfo`, which is not in this project's lib (ES2022 + node, no DOM).
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
    // URL uses the injected base + the pinned benchmark/vintage and x=lng, y=lat (note the order).
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
    // Emulate the AbortController firing: fetch rejects with an AbortError once the signal is aborted.
    const fetchImpl = ((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          })
        }
      })) as unknown as typeof fetch
    // A 1ms timeout guarantees the controller aborts before any (never-arriving) response.
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 1, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
  })

  it("returns null when a 200 body parses to no jurisdiction", async () => {
    const fetchImpl = (async () =>
      fakeResponse({ ok: true, json: () => body({}) })) as unknown as typeof fetch
    const lookup = new CensusJurisdictionLookup({ baseUrl: BASE_URL, timeoutMs: 50, fetchImpl })
    await expect(lookup.lookup(1, 2)).resolves.toBeNull()
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
