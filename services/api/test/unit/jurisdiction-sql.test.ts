/**
 * Unit test for the canonical jurisdiction-resolution SQL (src/db/sql/jurisdiction.ts). Pure string
 * assertions, no DB: this query is the single source of truth shared by the spatial integration test
 * and (later) the jurisdiction-service, so its exact shape is load-bearing and worth pinning.
 */

import { describe, expect, it } from "vitest"
import { JURISDICTION_RESOLVE_SQL } from "../../src/db/sql/jurisdiction.js"

describe("JURISDICTION_RESOLVE_SQL", () => {
  const sql = JURISDICTION_RESOLVE_SQL

  it("selects exactly the routing columns", () => {
    expect(sql).toMatch(/^SELECT geoid, name, layer/)
  })

  it("filters by ST_Contains against a 4326 point built from positional params (lng, lat)", () => {
    // Coordinate order matters: ST_MakePoint(x=lng=$1, y=lat=$2).
    expect(sql).toContain("ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))")
  })

  it("orders place -> county -> state so the most specific jurisdiction wins", () => {
    expect(sql).toContain("ORDER BY CASE layer WHEN 'place' THEN 0 WHEN 'county' THEN 1 ELSE 2 END")
  })

  it("returns at most one row", () => {
    expect(sql.trimEnd().endsWith("LIMIT 1")).toBe(true)
  })

  it("references the jurisdictions table", () => {
    expect(sql).toContain("FROM jurisdictions")
  })
})
