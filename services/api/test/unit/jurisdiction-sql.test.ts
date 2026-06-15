/**
 * Unit test for the canonical jurisdiction-resolution SQL (src/db/sql/jurisdiction.ts). Pure string
 * assertions, no DB: this query is the single source of truth shared by the spatial integration test
 * and (later) the jurisdiction-service, so its exact shape is load-bearing and worth pinning.
 */

import { describe, expect, it } from "vitest"
import { JURISDICTION_LAYER_RANK_CASE, JURISDICTION_RESOLVE_SQL } from "../../src/db/sql/jurisdiction.js"

describe("JURISDICTION_RESOLVE_SQL", () => {
  const sql = JURISDICTION_RESOLVE_SQL

  it("selects exactly the routing columns", () => {
    expect(sql).toMatch(/^SELECT geoid, name, layer/)
  })

  it("filters by ST_Contains against a 4326 point built from positional params (lng, lat)", () => {
    // Coordinate order matters: ST_MakePoint(x=lng=$1, y=lat=$2).
    expect(sql).toContain("ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))")
  })

  it("orders federal -> tribal -> place -> county -> state so the most specific authority wins", () => {
    expect(sql).toContain(
      "ORDER BY CASE layer WHEN 'federal' THEN 0 WHEN 'tribal' THEN 1 WHEN 'place' THEN 2 WHEN 'county' THEN 3 ELSE 4 END",
    )
  })

  it("returns at most one row", () => {
    expect(sql.trimEnd().endsWith("LIMIT 1")).toBe(true)
  })

  it("references the jurisdictions table", () => {
    expect(sql).toContain("FROM jurisdictions")
  })

  it("embeds the shared JURISDICTION_LAYER_RANK_CASE constant so the resolver and backfill can never drift", () => {
    // The resolver and the Phase-5 backfill CLI both interpolate this one constant; asserting the
    // RESOLVE_SQL contains it byte-for-byte proves the refactor preserved the SQL AND that there is a
    // single ranking source of truth.
    expect(JURISDICTION_RESOLVE_SQL).toContain(JURISDICTION_LAYER_RANK_CASE)
  })
})
