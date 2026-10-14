import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { resolveJurisdiction } from "../../src/db/sql/jurisdiction.js"
import {
  LA_CITY,
  LA_COUNTY,
  PROBE_COUNTY_NOT_CITY,
  PROBE_INSIDE_CITY,
  PROBE_OUTSIDE_ALL,
} from "../../src/db/seed-fixtures.js"
import { FEDERAL_PROBES, PROBE_ANGELES_OVER_CITY } from "../../src/db/data/federal-lands.js"

const pg = await withPg()

describe.skipIf(!pg)("spatial: jurisdiction resolution", () => {
  let h: PgHarness
  beforeAll(() => {
    // skipIf(!pg) guarantees pg is a live harness here.
    h = pg as PgHarness
  })
  afterAll(async () => {
    await h.teardown()
  })

  it("resolves a point inside the city to the place layer", async () => {
    const r = await resolveJurisdiction(h.sql, PROBE_INSIDE_CITY.lng, PROBE_INSIDE_CITY.lat)
    expect(r).not.toBeNull()
    expect(r?.geoid).toBe(LA_CITY.geoid)
    expect(r?.layer).toBe("place")
  })

  it("resolves a point in county-but-not-city to the county (unincorporated path)", async () => {
    const r = await resolveJurisdiction(h.sql, PROBE_COUNTY_NOT_CITY.lng, PROBE_COUNTY_NOT_CITY.lat)
    expect(r).not.toBeNull()
    expect(r?.geoid).toBe(LA_COUNTY.geoid)
    expect(r?.layer).toBe("county")
  })

  it("resolves each real federal / tribal land to its OWN distinct unit (different parks -> different mappings)", async () => {
    // Each curated federal/tribal land must be its own jurisdiction, routable on its own.
    for (const probe of FEDERAL_PROBES) {
      const r = await resolveJurisdiction(h.sql, probe.lng, probe.lat)
      expect(r, probe.name).not.toBeNull()
      expect(r?.geoid, probe.name).toBe(probe.expectGeoid)
      expect(["federal", "tribal"], probe.name).toContain(r?.layer)
    }
  })

  it("routes a national-forest point to the forest, not the surrounding city (ownership overrides place)", async () => {
    const r = await resolveJurisdiction(
      h.sql,
      PROBE_ANGELES_OVER_CITY.lng,
      PROBE_ANGELES_OVER_CITY.lat,
    )
    expect(r).not.toBeNull()
    expect(r?.geoid).toBe(PROBE_ANGELES_OVER_CITY.expectGeoid)
    expect(r?.layer).toBe("federal")
  })

  it("returns null for a point outside all jurisdictions", async () => {
    const r = await resolveJurisdiction(h.sql, PROBE_OUTSIDE_ALL.lng, PROBE_OUTSIDE_ALL.lat)
    expect(r).toBeNull()
  })

  it("seed is idempotent: exactly one row per seeded geoid", async () => {
    const rows = await h.sql<{ geoid: string; n: number }[]>`
      SELECT geoid, count(*)::int AS n FROM jurisdictions GROUP BY geoid
    `
    for (const row of rows) expect(row.n).toBe(1)
  })
})
