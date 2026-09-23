import { describe, expect, it } from "vitest"
import { normalizeFeatures } from "../../src/db/ingest-jurisdictions.js"

/**
 * Pure, DB-free unit tests for the ingest CLI's optional load-time geoid prefix (Design A). The prefix
 * namespaces the non-FIPS layers — AIANNH/tribal ("AIANNH-") and PAD-US/federal ("PADUS-") — so their
 * geoids stay globally unique (no 5-char AIANNH-vs-county PK collision) AND so uspsFromGeoid() returns
 * null for them, which makes the TIGER geocoder fall back to the authoritative spatial state query
 * instead of trusting a bogus FIPS prefix (geocoder.tiger.ts:152-155). TIGER place/county/state ingest
 * with NO prefix and keep their raw Census GEOID so the geocoder's FIPS shortcut stays valid.
 *
 * These tests pin: prefix applied to the computed geoid, empty/absent prefix as a no-op (backward
 * compatibility), single application even across duplicate raw geoids (no double-prefix), prefix
 * orthogonality to skip-counting and layer fallback, and prefixing of a geoid read from an alternate
 * property key. No DB, no fixture files — inline GeoJSON literals.
 */

/** A minimal valid Polygon ring (closed, CCW-ish) — enough to pass the isPolygon check. */
const validPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-118, 34],
      [-117, 34],
      [-117, 35],
      [-118, 35],
      [-118, 34],
    ],
  ],
}

/** Wrap features in a FeatureCollection. Cast through `unknown` to satisfy the loose GeoJSON types. */
function fc(features: unknown[]): Parameters<typeof normalizeFeatures>[0] {
  return { type: "FeatureCollection", features } as Parameters<typeof normalizeFeatures>[0]
}

describe("normalizeFeatures geoid prefix", () => {
  it("prepends the prefix to the computed geoid (AIANNH-/tribal)", () => {
    const { rows } = normalizeFeatures(
      fc([{ type: "Feature", properties: { geoid: "0010", name: "T" }, geometry: validPolygon }]),
      "tribal",
      "AIANNH-",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.geoid).toBe("AIANNH-0010")
    expect(rows[0]?.layer).toBe("tribal")
  })

  it("is a no-op for an empty prefix and for an absent prefix (backward compatible)", () => {
    const feature = {
      type: "Feature",
      properties: { geoid: "0010", name: "T" },
      geometry: validPolygon,
    }
    expect(normalizeFeatures(fc([feature]), "tribal", "").rows[0]?.geoid).toBe("0010")
    expect(normalizeFeatures(fc([feature]), "tribal").rows[0]?.geoid).toBe("0010")
  })

  it("applies the prefix exactly once even across duplicate raw geoids (no double-prefix)", () => {
    const { rows } = normalizeFeatures(
      fc([
        { type: "Feature", properties: { geoid: "0010", name: "A" }, geometry: validPolygon },
        { type: "Feature", properties: { geoid: "0010", name: "B" }, geometry: validPolygon },
      ]),
      "tribal",
      "AIANNH-",
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.geoid).toBe("AIANNH-0010")
    expect(rows[1]?.geoid).toBe("AIANNH-0010")
  })

  it("counts skipped features (missing geoid) independently of the prefix", () => {
    const { rows, skipped } = normalizeFeatures(
      fc([
        { type: "Feature", properties: { geoid: "0010", name: "Valid" }, geometry: validPolygon },
        { type: "Feature", properties: { name: "NoGeoid1" }, geometry: validPolygon },
        { type: "Feature", properties: { name: "NoGeoid2" }, geometry: validPolygon },
      ]),
      "tribal",
      "AIANNH-",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.geoid).toBe("AIANNH-0010")
    expect(skipped).toBe(2)
  })

  it("layer fallback is orthogonal to the prefix (no layer prop -> defaultLayer, geoid still prefixed)", () => {
    const { rows } = normalizeFeatures(
      fc([{ type: "Feature", properties: { geoid: "0010", name: "T" }, geometry: validPolygon }]),
      "tribal",
      "AIANNH-",
    )
    expect(rows[0]?.layer).toBe("tribal")
    expect(rows[0]?.geoid).toBe("AIANNH-0010")
  })

  it("BACKWARD COMPATIBLE: a TIGER place ingest with no prefix keeps its raw Census GEOID", () => {
    // 0644000 (LA city) keeps a leading "06" FIPS prefix so the geocoder's uspsFromGeoid shortcut stays
    // valid. Prefixing it would (wrongly) make uspsFromGeoid return null.
    const { rows } = normalizeFeatures(
      fc([
        {
          type: "Feature",
          properties: { geoid: "0644000", name: "Los Angeles" },
          geometry: validPolygon,
        },
      ]),
      "place",
    )
    expect(rows[0]?.geoid).toBe("0644000")
    expect(rows[0]?.layer).toBe("place")
  })

  it("prefixes a geoid read from an alternate property key (OBJECTID -> PADUS-/federal)", () => {
    // PAD-US carries the id under OBJECTID; the alpha prefix makes uspsFromGeoid() return null so the
    // geocoder uses the spatial state query rather than misreading OBJECTID's first 2 digits as a FIPS.
    const { rows } = normalizeFeatures(
      fc([
        { type: "Feature", properties: { OBJECTID: "12345", name: "Fed" }, geometry: validPolygon },
      ]),
      "federal",
      "PADUS-",
    )
    expect(rows[0]?.geoid).toBe("PADUS-12345")
    expect(rows[0]?.layer).toBe("federal")
  })
})
