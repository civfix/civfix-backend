/**
 * Offline validation of the curated real federal/tribal lands dataset (src/db/data/federal-lands.ts).
 *
 * The end-to-end spatial resolution runs in the Docker-gated integration test (spatial.test.ts). These
 * pure-geometry checks run with NO database and prove the seeded data is internally consistent: each
 * unit is distinct, its generated boundary is a valid closed ring that CONTAINS the probe the spatial
 * test fires (so that test will resolve to it), and the Angeles-National-Forest probe genuinely sits in
 * both the forest and the seeded LA city box (the setup behind "federal ownership beats place").
 */

import { describe, expect, it } from "vitest"
import {
  FEDERAL_LANDS,
  FEDERAL_PROBES,
  PROBE_ANGELES_OVER_CITY,
  federalLandCenter,
  federalLandGeoJson,
  type FederalLand,
} from "../../src/db/data/federal-lands.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

type Ring = [number, number][]
type BBox = readonly [number, number, number, number]

/** The generated octagon ring (closed) for a unit. */
function ringOf(land: FederalLand): Ring {
  const geo = JSON.parse(federalLandGeoJson(land.bbox)) as { coordinates: Ring[] }
  return geo.coordinates[0]!
}

/** Ray-casting point-in-ring for a single [lng,lat] ring. */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function inBbox(lng: number, lat: number, b: BBox): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]
}

function bboxIntersect(a: BBox, b: BBox): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

describe("federal lands dataset", () => {
  it("every unit has a unique geoid, a federal/tribal layer, and a sane bounding extent", () => {
    const geoids = FEDERAL_LANDS.map((l) => l.geoid)
    expect(new Set(geoids).size).toBe(geoids.length) // unique
    for (const land of FEDERAL_LANDS) {
      expect(["federal", "tribal"]).toContain(land.layer)
      const [x0, y0, x1, y1] = land.bbox
      expect(x0).toBeGreaterThanOrEqual(-180)
      expect(x1).toBeLessThanOrEqual(180)
      expect(y0).toBeGreaterThanOrEqual(-90)
      expect(y1).toBeLessThanOrEqual(90)
      expect(x0).toBeLessThan(x1)
      expect(y0).toBeLessThan(y1)
      expect(land.name.length).toBeGreaterThan(0)
    }
    // A real MIX: at least one federal and at least one tribal unit.
    expect(FEDERAL_LANDS.some((l) => l.layer === "federal")).toBe(true)
    expect(FEDERAL_LANDS.some((l) => l.layer === "tribal")).toBe(true)
  })

  it("generates a valid closed octagon ring whose vertices stay within the bounding extent", () => {
    for (const land of FEDERAL_LANDS) {
      const ring = ringOf(land)
      expect(ring).toHaveLength(9) // octagon: 8 vertices + closing point
      expect(ring[0]).toEqual(ring[ring.length - 1]) // closed
      for (const [lng, lat] of ring) {
        expect(inBbox(lng, lat, land.bbox)).toBe(true)
      }
    }
  })

  it("each unit's center sits inside its own boundary (so the spatial probe resolves to it)", () => {
    for (const land of FEDERAL_LANDS) {
      const c = federalLandCenter(land.bbox)
      expect(pointInRing(c.lng, c.lat, ringOf(land)), land.geoid).toBe(true)
    }
  })

  it("FEDERAL_PROBES has one center probe per unit, each pointing at that unit's own geoid", () => {
    expect(FEDERAL_PROBES).toHaveLength(FEDERAL_LANDS.length)
    for (const probe of FEDERAL_PROBES) {
      const land = FEDERAL_LANDS.find((l) => l.geoid === probe.expectGeoid)
      expect(land, probe.name).toBeDefined()
      expect(pointInRing(probe.lng, probe.lat, ringOf(land!)), probe.name).toBe(true)
    }
  })

  it("curated units are geographically DISTINCT (no two bounding extents intersect)", () => {
    for (let i = 0; i < FEDERAL_LANDS.length; i++) {
      for (let j = i + 1; j < FEDERAL_LANDS.length; j++) {
        const a = FEDERAL_LANDS[i]!
        const b = FEDERAL_LANDS[j]!
        expect(bboxIntersect(a.bbox, b.bbox), `${a.geoid} vs ${b.geoid}`).toBe(false)
      }
    }
  })

  it("the Angeles-over-city probe lies inside BOTH the forest and the seeded LA city box", () => {
    // This overlap is what makes resolveJurisdiction return the forest (federal) over the city (place).
    const angeles = FEDERAL_LANDS.find((l) => l.geoid === "USFS-ANGELES")!
    expect(PROBE_ANGELES_OVER_CITY.expectGeoid).toBe("USFS-ANGELES")
    expect(pointInRing(PROBE_ANGELES_OVER_CITY.lng, PROBE_ANGELES_OVER_CITY.lat, ringOf(angeles))).toBe(
      true,
    )
    expect(inBbox(PROBE_ANGELES_OVER_CITY.lng, PROBE_ANGELES_OVER_CITY.lat, LA_CITY.bbox)).toBe(true)
  })
})
