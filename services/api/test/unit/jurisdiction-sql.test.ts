/**
 * Unit test for the canonical jurisdiction-resolution SQL (src/db/sql/jurisdiction.ts). Pure string
 * assertions, no DB: this query is the single source of truth shared by the spatial integration test
 * and (later) the jurisdiction-service, so its exact shape is load-bearing and worth pinning.
 */

import { describe, expect, it } from "vitest"
import {
  JURISDICTION_LAYER_RANK_CASE,
  JURISDICTION_RESOLVE_ORDER_BY,
  JURISDICTION_RESOLVE_SQL,
} from "../../src/db/sql/jurisdiction.js"

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
    // The resolver and the backfill CLI both interpolate this one constant; asserting the
    // RESOLVE_SQL contains it byte-for-byte proves the refactor preserved the SQL AND that there is a
    // single ranking source of truth.
    expect(JURISDICTION_RESOLVE_SQL).toContain(JURISDICTION_LAYER_RANK_CASE)
  })

  // The rank CASE alone left SAME-LAYER overlaps (PAD-US federal Fee parcels, a dev-seeded fixture
  // polygon over the real boundary it duplicates) undecided, so Postgres was free to return either row:
  // the write-time resolver and the keyset backfill could stamp DIFFERENT geoids, hence different
  // routing, for one point. `priority, geoid` makes the choice a total order. These assertions pin the
  // whole ORDER BY list, because "the rank case is present" (above) stayed true while the tie-breaks
  // were missing, which is exactly how the bug survived.

  it("appends the total-order tie-breaks AFTER the rank case: ...END, priority, geoid", () => {
    expect(sql).toContain(`ORDER BY ${JURISDICTION_LAYER_RANK_CASE}, priority, geoid`)
  })

  it("the ORDER BY clause is the shared ORDER_BY constant, immediately followed by LIMIT 1", () => {
    // Byte-for-byte: the resolver interpolates the SAME string src/db/backfill-keyset.ts feeds to
    // sql.unsafe(), so nothing can be appended on one side only.
    expect(sql).toContain(`ORDER BY ${JURISDICTION_RESOLVE_ORDER_BY}\nLIMIT 1`)
    expect(sql.trimEnd().endsWith(`ORDER BY ${JURISDICTION_RESOLVE_ORDER_BY}\nLIMIT 1`)).toBe(true)
  })

  it("does NOT order by the bare rank case (the pre-fix, nondeterministic shape)", () => {
    // The regression this guards: `ORDER BY <rank case>` then straight to LIMIT 1.
    expect(sql).not.toMatch(/END\s*\r?\nLIMIT 1/)
    expect(sql).not.toContain(`ORDER BY ${JURISDICTION_LAYER_RANK_CASE}\nLIMIT 1`)
  })
})

describe("JURISDICTION_RESOLVE_ORDER_BY", () => {
  it("is the layer rank followed by priority then geoid, byte-for-byte", () => {
    expect(JURISDICTION_RESOLVE_ORDER_BY).toBe(
      "CASE layer WHEN 'federal' THEN 0 WHEN 'tribal' THEN 1 WHEN 'place' THEN 2 WHEN 'county' THEN 3 ELSE 4 END, priority, geoid",
    )
  })

  it("ends with `END, priority, geoid`: rank first, then curated priority, then the PK", () => {
    expect(JURISDICTION_RESOLVE_ORDER_BY.endsWith("END, priority, geoid")).toBe(true)
    // Order among the tie-breaks matters: `priority` (curated per-row ordering within a layer) must be
    // consulted BEFORE the arbitrary-but-total `geoid`.
    expect(JURISDICTION_RESOLVE_ORDER_BY.indexOf("priority")).toBeLessThan(
      JURISDICTION_RESOLVE_ORDER_BY.indexOf("geoid"),
    )
  })

  it("starts with the shared rank case (composed, not re-typed)", () => {
    expect(JURISDICTION_RESOLVE_ORDER_BY.startsWith(JURISDICTION_LAYER_RANK_CASE)).toBe(true)
  })

  it("is safe to drop straight into an ORDER BY clause (no leading/trailing whitespace, no ORDER BY)", () => {
    // src/db/backfill-keyset.ts interpolates it with sql.unsafe() right after the literal "ORDER BY ",
    // so a stray "ORDER BY" prefix or surrounding whitespace would produce invalid SQL at runtime.
    expect(JURISDICTION_RESOLVE_ORDER_BY).toBe(JURISDICTION_RESOLVE_ORDER_BY.trim())
    expect(JURISDICTION_RESOLVE_ORDER_BY).not.toContain("ORDER BY")
    expect(JURISDICTION_RESOLVE_ORDER_BY).not.toContain(";")
  })
})
