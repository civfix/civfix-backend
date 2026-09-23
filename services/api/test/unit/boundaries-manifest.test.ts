/**
 * Unit tests for the Path-A boundary-prep manifest (src/db/boundaries/manifest.ts). Pure: no DB, no
 * network, no file IO — the manifest is deterministic for a given vintage, so we assert its shape.
 *
 * The manifest is load-bearing in three ways that these tests pin:
 *   1. Coverage: exactly the 50 states get a per-state PLACE job (territories deferred to Design B).
 *   2. Correctness of the conversion args: every job reprojects to EPSG:4326; only places filter G4110.
 *   3. The single-application prefix rule: AIANNH/PAD-US carry their prefix as METADATA only — it must
 *      NEVER leak into the ogr2ogr conversion args (prefixing happens once, at ingest).
 *
 * The layer-enum drift guard ties every job.layer to JURISDICTION_LAYER_VALUES so a future enum change
 * can't silently desync the manifest. The federal<tribal resolver ranking is OWNED by jurisdiction.ts
 * (JURISDICTION_LAYER_RANK_CASE), not the manifest — documented here, asserted there.
 */

import { describe, expect, it } from "vitest"
import {
  boundaryManifest,
  STATE_FIPS,
  DEFAULT_TIGER_VINTAGE,
  PADUS_VERSION,
  vintageTag,
} from "../../src/db/boundaries/manifest.js"
import { JURISDICTION_LAYER_VALUES } from "../../src/db/schema/types.js"

/** Find the index of an arg in ogr2ogrArgs (helper for "flag immediately followed by value" checks). */
function argIndex(args: string[], flag: string): number {
  return args.indexOf(flag)
}

describe("boundaryManifest", () => {
  const jobs = boundaryManifest()

  it("emits exactly one PLACE job per state, covering all 50 state FIPS", () => {
    const placeJobs = jobs.filter((j) => j.layer === "place")
    expect(placeJobs).toHaveLength(50)
    expect(placeJobs).toHaveLength(STATE_FIPS.length)

    // The <SS> baked into each place job's outFile/url must be exactly the STATE_FIPS set.
    const fipsFromOutFile = new Set(
      placeJobs.map((j) => j.outFile.replace(/^places_(\d{2})\.geojson$/, "$1")),
    )
    expect(fipsFromOutFile).toEqual(new Set(STATE_FIPS))
    for (const j of placeJobs) {
      const ss = j.outFile.replace(/^places_(\d{2})\.geojson$/, "$1")
      expect(j.sourceUrl).toContain(`_${ss}_place.zip`)
    }
  })

  it("points every TIGER job at the census TIGER<vintage> directory", () => {
    const re = new RegExp(`^https://www2\\.census\\.gov/geo/tiger/TIGER${DEFAULT_TIGER_VINTAGE}/`)
    // Every job EXCEPT the PAD-US federal one (USGS-hosted) is a TIGER download.
    const tigerJobs = jobs.filter((j) => j.layer !== "federal")
    expect(tigerJobs.length).toBeGreaterThan(0)
    for (const j of tigerJobs) {
      expect(j.sourceUrl).toMatch(re)
    }
  })

  it("filters places to MTFCC G4110 and nothing else carries that filter", () => {
    for (const j of jobs) {
      if (j.layer === "place") {
        const i = argIndex(j.ogr2ogrArgs, "-where")
        expect(i).toBeGreaterThanOrEqual(0)
        expect(j.ogr2ogrArgs[i + 1]).toBe("MTFCC='G4110'")
      } else {
        // state / county / tribal jobs must NOT carry the G4110 MTFCC filter.
        expect(j.ogr2ogrArgs.join(" ")).not.toContain("MTFCC='G4110'")
      }
    }
  })

  it("reprojects EVERY job to EPSG:4326 (NAD83 -> WGS84)", () => {
    for (const j of jobs) {
      const i = argIndex(j.ogr2ogrArgs, "-t_srs")
      expect(i).toBeGreaterThanOrEqual(0)
      expect(j.ogr2ogrArgs[i + 1]).toBe("EPSG:4326")
    }
  })

  it("scopes the PAD-US federal job to FEDERAL manager (via OGR -sql on the Fee layer)", () => {
    const federal = jobs.find((j) => j.layer === "federal")
    expect(federal).toBeDefined()
    // Federal reads the version-named Fee feature class from the national GDB via the DEFAULT OGR SQL
    // dialect (reliably carries geometry), filters Mang_Type='FED', and aliases the GDB's OBJECTID/Unit_Nm
    // -> GEOID/NAME (so they land as GeoJSON properties the ingest CLI reads), promoting to MultiPolygon.
    const i = argIndex(federal!.ogr2ogrArgs, "-sql")
    expect(i).toBeGreaterThanOrEqual(0)
    const sql = federal!.ogr2ogrArgs[i + 1] ?? ""
    expect(sql).toContain("Mang_Type='FED'")
    expect(sql).toContain("AS GEOID")
    expect(sql).toContain("AS NAME")
    expect(sql).toContain("Fee")
    expect(federal!.ogr2ogrArgs).toContain("PROMOTE_TO_MULTI")
    // The federal source is the USGS ScienceBase GDB, and it extracts to a .gdb the runner reads.
    expect(federal!.sourceUrl).toContain("sciencebase.gov")
    expect(federal!.sourcePath).toMatch(/\.gdb$/)
  })

  it("declares a concrete sourcePath for every job (no basename heuristic)", () => {
    for (const j of jobs) {
      expect(j.sourcePath.length).toBeGreaterThan(0)
      // TIGER/AIANNH jobs convert a like-named shapefile; only the federal job reads a geodatabase.
      if (j.layer === "federal") expect(j.sourcePath).toMatch(/\.gdb$/)
      else expect(j.sourcePath).toMatch(/\.shp$/)
    }
  })

  it("records the AIANNH and PAD-US geoid prefixes as metadata", () => {
    const tribal = jobs.find((j) => j.layer === "tribal")
    const federal = jobs.find((j) => j.layer === "federal")
    expect(tribal?.ingestGeoidPrefix).toBe("AIANNH-")
    expect(federal?.ingestGeoidPrefix).toBe("PADUS-")
  })

  it("keeps the FIPS-hierarchical TIGER layers prefix-free (raw Census GEOID)", () => {
    for (const j of jobs) {
      if (j.layer === "state" || j.layer === "county" || j.layer === "place") {
        expect(j.ingestGeoidPrefix).toBeNull()
      }
    }
  })

  it("never leaks a geoid prefix into the ogr2ogr conversion args", () => {
    // The prefix is applied ONCE, at ingest — it must not appear in any conversion command.
    for (const j of jobs) {
      const joined = j.ogr2ogrArgs.join(" ")
      expect(joined).not.toContain("AIANNH-")
      expect(joined).not.toContain("PADUS-")
    }
  })

  it("uses only valid jurisdiction layers, covering exactly the five Design-A layers", () => {
    const valid = new Set<string>(JURISDICTION_LAYER_VALUES)
    for (const j of jobs) {
      expect(valid.has(j.layer)).toBe(true)
    }
    const used = new Set(jobs.map((j) => j.layer))
    // Design A ingests all five layers; the set is a subset of the enum AND exactly these five.
    expect(used).toEqual(new Set(["state", "county", "place", "tribal", "federal"]))
  })

  it("documents (no code assertion needed) that federal<tribal ranking is owned by jurisdiction.ts", () => {
    // The manifest only declares WHICH layers to ingest. The resolver precedence
    // (federal 0 < tribal 1 < place 2 < county 3 < state 4) lives in JURISDICTION_LAYER_RANK_CASE in
    // src/db/sql/jurisdiction.ts and is drift-guarded by jurisdiction-sql.test.ts. Nothing to assert
    // here beyond recording the ownership boundary.
    expect(true).toBe(true)
  })

  it("resolves 'latest' to the default vintage (no network probe)", () => {
    expect(boundaryManifest("latest")).toEqual(boundaryManifest(DEFAULT_TIGER_VINTAGE))
  })
})

describe("vintageTag", () => {
  it("is the canonical 'tiger<year>-padus<version>' identity shared by CI + the on-box cron", () => {
    expect(vintageTag(2025, "4.1")).toBe("tiger2025-padus4.1")
    // Defaults to the manifest's PAD-US version when omitted (the value CI + cron both derive).
    expect(vintageTag(DEFAULT_TIGER_VINTAGE)).toBe(
      `tiger${DEFAULT_TIGER_VINTAGE}-padus${PADUS_VERSION}`,
    )
  })
})
