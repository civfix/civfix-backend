/**
 * Pure unit test (no DB) for the shared jurisdiction layer-ranking constant
 * (JURISDICTION_LAYER_RANK_CASE in src/db/sql/jurisdiction.ts).
 *
 * This constant is THE single ranking definition shared by the write-time resolver
 * (JURISDICTION_RESOLVE_SQL) and the backfill CLI (src/db/backfill-jurisdictions.ts, which
 * embeds it verbatim via `sql.unsafe`). Because both paths interpolate the exact same string, a
 * backfilled report resolves identically to a fresh insert; there is no second, drifting copy of the
 * CASE expression to keep in sync. Here we pin the literal value and the ordering it encodes.
 *
 * NOTE: the byte-for-byte tie between JURISDICTION_RESOLVE_SQL and this constant is asserted in
 * jurisdiction-sql.test.ts (next to the existing RESOLVE_SQL assertions), so the drift guard lives
 * beside the SQL it guards; here we assert the constant in isolation.
 */

import { describe, expect, it } from "vitest"
import { JURISDICTION_LAYER_RANK_CASE } from "../../src/db/sql/jurisdiction.js"

describe("JURISDICTION_LAYER_RANK_CASE", () => {
  it("is the exact, byte-for-byte ranking CASE expression", () => {
    expect(JURISDICTION_LAYER_RANK_CASE).toBe(
      "CASE layer WHEN 'federal' THEN 0 WHEN 'tribal' THEN 1 WHEN 'place' THEN 2 WHEN 'county' THEN 3 ELSE 4 END",
    )
  })

  it("has no leading/trailing whitespace so it drops straight into an ORDER BY clause", () => {
    expect(JURISDICTION_LAYER_RANK_CASE).toBe(JURISDICTION_LAYER_RANK_CASE.trim())
  })

  it("maps each layer to its rank: federal 0, tribal 1, place 2, county 3, ELSE (state) 4", () => {
    expect(JURISDICTION_LAYER_RANK_CASE).toContain("WHEN 'federal' THEN 0")
    expect(JURISDICTION_LAYER_RANK_CASE).toContain("WHEN 'tribal' THEN 1")
    expect(JURISDICTION_LAYER_RANK_CASE).toContain("WHEN 'place' THEN 2")
    expect(JURISDICTION_LAYER_RANK_CASE).toContain("WHEN 'county' THEN 3")
    expect(JURISDICTION_LAYER_RANK_CASE).toContain("ELSE 4")
  })

  it("orders federal before tribal before place before county (ascending, most-specific first)", () => {
    const s = JURISDICTION_LAYER_RANK_CASE
    const federal = s.indexOf("'federal'")
    const tribal = s.indexOf("'tribal'")
    const place = s.indexOf("'place'")
    const county = s.indexOf("'county'")
    expect(federal).toBeGreaterThanOrEqual(0)
    expect(federal).toBeLessThan(tribal)
    expect(tribal).toBeLessThan(place)
    expect(place).toBeLessThan(county)
  })
})
