import { describe, it, expect } from "vitest"
import { FakeGeocoder, FakeJobs } from "@civfix/shared/fakes"
import type { Container } from "../../src/di.js"
import type { Sql } from "../../src/db/client.js"
import type {
  JurisdictionLookup,
  JurisdictionLookupResult,
} from "../../src/adapters/jurisdiction-lookup.census.js"
import {
  makeGeoidResolver,
  makeRouteJurisdictionService,
} from "../../src/services/route-geo-helpers.js"

/**
 * Route-level jurisdiction wiring (services/route-geo-helpers.ts).
 *
 * The one behavior worth pinning offline is WHICH surfaces memoize the external Census lookup: the anon-ok
 * map resolve opts in (`cacheLookup: true`), the submit-path resolver does NOT, and the memo is held per
 * CONTAINER — the service is rebuilt on every request, so a per-service cache would never see a hit, and a
 * bare module singleton would leak one container's coverage answers into another's tests.
 */

const LA: JurisdictionLookupResult = { geoid: "0644000", name: "Los Angeles", layer: "place" }

/** Counting lookup: `calls` records every coordinate that reached the (would-be) Census request. */
function countingLookup(): JurisdictionLookup & { calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = []
  return {
    calls,
    lookup(lat: number, lng: number) {
      calls.push([lat, lng])
      return Promise.resolve(LA)
    },
  }
}

/**
 * Minimal fake `sql` tag: `.unsafe` answers the canonical resolver with a MISS (so every resolve takes the
 * Census fallback) and the tagged form answers the lazy insert / health read with no rows. `statements`
 * counts the tagged calls.
 */
function fakeSql(statements: string[]): Sql {
  const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    statements.push(strings.join(""))
    return Promise.resolve([])
  }
  ;(fn as unknown as { unsafe: unknown }).unsafe = () => Promise.resolve([])
  return fn as unknown as Sql
}

/** Just the slice of the container these builders read. */
function fakeContainer(lookup: JurisdictionLookup, statements: string[] = []): Container {
  return {
    getDb: () => ({ sql: fakeSql(statements) }),
    geocoder: new FakeGeocoder(),
    jobs: new FakeJobs(),
    jurisdictionLookup: lookup,
  } as unknown as Container
}

describe("makeRouteJurisdictionService", () => {
  it("cacheLookup: repeat resolves of one point make ONE outbound lookup, across rebuilt services", async () => {
    const lookup = countingLookup()
    const container = fakeContainer(lookup)

    // Each call rebuilds the service exactly as a request handler does.
    await makeRouteJurisdictionService(container, { cacheLookup: true }).resolveForPoint(34.05, -118.25)
    await makeRouteJurisdictionService(container, { cacheLookup: true }).resolveForPoint(34.05, -118.25)
    await makeRouteJurisdictionService(container, { cacheLookup: true }).resolveForPoint(34.05, -118.25)

    expect(lookup.calls).toHaveLength(1)
  })

  it("without cacheLookup the submit-path behavior is unchanged (one lookup per resolve)", async () => {
    const lookup = countingLookup()
    const container = fakeContainer(lookup)

    await makeRouteJurisdictionService(container).resolveForPoint(34.05, -118.25)
    await makeRouteJurisdictionService(container).resolveForPoint(34.05, -118.25)

    expect(lookup.calls).toHaveLength(2)
  })

  it("makeGeoidResolver (reports/anon/cleanups submits) is uncached", async () => {
    const lookup = countingLookup()
    const resolve = makeGeoidResolver(fakeContainer(lookup))

    await expect(resolve(34.05, -118.25)).resolves.toBe(LA.geoid)
    await expect(resolve(34.05, -118.25)).resolves.toBe(LA.geoid)

    expect(lookup.calls).toHaveLength(2)
  })

  it("holds the memo per container, never process-wide", async () => {
    const lookupA = countingLookup()
    const lookupB = countingLookup()

    await makeRouteJurisdictionService(fakeContainer(lookupA), { cacheLookup: true }).resolveForPoint(
      34.05,
      -118.25,
    )
    await makeRouteJurisdictionService(fakeContainer(lookupB), { cacheLookup: true }).resolveForPoint(
      34.05,
      -118.25,
    )

    // The second container asked its OWN lookup rather than reading the first one's answer.
    expect(lookupA.calls).toHaveLength(1)
    expect(lookupB.calls).toHaveLength(1)
  })

  it("a cached resolve still issues the NOT EXISTS-guarded insert (self-healing, never a code burn)", async () => {
    const statements: string[] = []
    const container = fakeContainer(countingLookup(), statements)

    await makeRouteJurisdictionService(container, { cacheLookup: true }).resolveForPoint(34.05, -118.25)
    await makeRouteJurisdictionService(container, { cacheLookup: true }).resolveForPoint(34.05, -118.25)

    expect(statements).not.toHaveLength(0)
    for (const text of statements) {
      expect(text).toContain("WHERE NOT EXISTS (SELECT 1 FROM jurisdictions WHERE geoid =")
      expect(text).not.toContain("VALUES (")
    }
  })
})
