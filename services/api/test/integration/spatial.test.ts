/**
 * Spatial integration test: jurisdiction resolution (place -> county -> state precedence).
 *
 * Requires Docker (a real PostGIS container). When Docker is unavailable the whole describe block is
 * SKIPPED (not failed) via describe.skipIf, so the local suite stays green; CI runs it for real.
 *
 * It exercises the SAME query the jurisdiction-service will use: src/db/sql/jurisdiction.ts. The
 * probe points and their expected results come from src/db/seed-fixtures.ts, the single source of
 * truth shared with the seed.
 */

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

const pg = await withPg()

describe.skipIf(!pg)("spatial: jurisdiction resolution", () => {
  let h: PgHarness
  beforeAll(() => {
    // Non-null here: skipIf(!pg) guarantees we only run when pg is a live harness.
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
