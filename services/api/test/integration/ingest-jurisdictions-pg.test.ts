
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  ingestGeoJsonFile,
  upsertJurisdiction,
  type IngestRow,
} from "../../src/db/ingest-jurisdictions.js"
import { resolveJurisdiction } from "../../src/db/sql/jurisdiction.js"

const pg = await withPg()

function square(lng: number, lat: number, half: number): IngestRow["geometry"] {
  return {
    type: "Polygon",
    coordinates: [
      [
        [lng - half, lat - half],
        [lng + half, lat - half],
        [lng + half, lat + half],
        [lng - half, lat + half],
        [lng - half, lat - half],
      ],
    ],
  }
}

function row(over: Partial<IngestRow> & Pick<IngestRow, "geoid">): IngestRow {
  return {
    name: over.name ?? `Unit ${over.geoid}`,
    layer: over.layer ?? "federal",
    population: over.population ?? null,
    geometry: over.geometry ?? square(-100, 40, 0.5),
    geoid: over.geoid,
  }
}

describe.skipIf(!pg)("jurisdiction ingest (integration: real upsert)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function read(geoid: string) {
    const rows = await h.sql<
      {
        geoid: string
        name: string
        layer: string
        priority: number
        code: number | null
        population: number | null
        contact_emails: string[] | null
      }[]
    >`
      SELECT geoid, name, layer, priority, code, population, contact_emails
      FROM jurisdictions WHERE geoid = ${geoid}
    `
    return rows[0]
  }


  it("stamps a JURCODE from jurisdiction_code_seq on a NEW jurisdiction (never NULL)", async () => {
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-1", name: "Ingest Park", layer: "federal" }))
    const created = await read("PADUS-IN-1")
    expect(created).toBeDefined()
    expect(created!.code).not.toBeNull()
    expect(Number.isInteger(created!.code)).toBe(true)
    expect(created!.code!).toBeGreaterThan(0)
    expect(created!.priority).toBe(-2)
  })

  it("allocates DISTINCT codes to distinct jurisdictions from the one shared sequence", async () => {
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-2" }))
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-3" }))
    const a = await read("PADUS-IN-2")
    const b = await read("PADUS-IN-3")
    expect(a!.code).not.toBeNull()
    expect(b!.code).not.toBeNull()
    expect(a!.code).not.toBe(b!.code)
    const seeded = await read("0644000")
    expect(seeded!.code).not.toBeNull()
    expect(seeded!.code).not.toBe(a!.code)
  })

  it("PRESERVES an established code across a re-ingest while refreshing name/layer/priority/population", async () => {
    await upsertJurisdiction(
      h.sql,
      row({ geoid: "PADUS-IN-4", name: "Old Name", layer: "federal", population: 100 }),
    )
    const before = await read("PADUS-IN-4")
    expect(before!.code).not.toBeNull()

    await upsertJurisdiction(
      h.sql,
      row({ geoid: "PADUS-IN-4", name: "New Name", layer: "tribal", population: 250 }),
    )
    const after = await read("PADUS-IN-4")
    expect(after!.code).toBe(before!.code)
    expect(after!.name).toBe("New Name")
    expect(after!.layer).toBe("tribal")
    expect(after!.priority).toBe(-1)
    expect(after!.population).toBe(250)
  })

  it("BACKFILLS a code onto a row that predates code stamping, and keeps a stored population when the feed omits it", async () => {
    await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, geom, population)
      VALUES ('PADUS-IN-5', 'Legacy', 'federal', -2,
              ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(square(-100, 40, 0.5))}), 4326)), 777)
    `
    expect((await read("PADUS-IN-5"))!.code).toBeNull()

    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-5", name: "Legacy", population: null }))
    const after = await read("PADUS-IN-5")
    expect(after!.code).not.toBeNull()
    expect(after!.population).toBe(777)
  })


  it("CLEARS an all-placeholder contact list (the dev seed's example.gov addresses) on re-ingest", async () => {
    await h.sql`
      UPDATE jurisdictions SET contact_emails = ARRAY['trash@example.gov', 'graffiti@example.gov']
      WHERE geoid = '0644000'
    `
    await upsertJurisdiction(
      h.sql,
      row({ geoid: "0644000", name: "Los Angeles", layer: "place", geometry: square(-118.35, 34.1, 0.15) }),
    )
    const after = await read("0644000")
    expect(after!.contact_emails).toBeNull()
    expect(after!.name).toBe("Los Angeles")
  })

  it("PRESERVES operator-mapped contacts, and preserves a MIXED list containing one real address", async () => {
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-6" }))
    await h.sql`
      UPDATE jurisdictions SET contact_emails = ARRAY['311@lacity.org'] WHERE geoid = 'PADUS-IN-6'
    `
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-6", name: "Refreshed" }))
    expect((await read("PADUS-IN-6"))!.contact_emails).toEqual(["311@lacity.org"])

    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-7" }))
    await h.sql`
      UPDATE jurisdictions SET contact_emails = ARRAY['real@lacity.org', 'dev@example.gov']
      WHERE geoid = 'PADUS-IN-7'
    `
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-IN-7", name: "Refreshed" }))
    expect((await read("PADUS-IN-7"))!.contact_emails).toEqual(["real@lacity.org", "dev@example.gov"])
  })


  it("resolves overlapping SAME-LAYER polygons deterministically (priority, then geoid)", async () => {
    const pt = { lng: -101.25, lat: 41.25 }
    const geom = square(pt.lng, pt.lat, 0.25)
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-OVERLAP-B", name: "Parcel B", geometry: geom }))
    await upsertJurisdiction(h.sql, row({ geoid: "PADUS-OVERLAP-A", name: "Parcel A", geometry: geom }))

    const first = await resolveJurisdiction(h.sql, pt.lng, pt.lat)
    expect(first?.geoid).toBe("PADUS-OVERLAP-A")
    for (let i = 0; i < 3; i++) {
      expect((await resolveJurisdiction(h.sql, pt.lng, pt.lat))?.geoid).toBe("PADUS-OVERLAP-A")
    }

    await h.sql`UPDATE jurisdictions SET priority = -5 WHERE geoid = 'PADUS-OVERLAP-B'`
    expect((await resolveJurisdiction(h.sql, pt.lng, pt.lat))?.geoid).toBe("PADUS-OVERLAP-B")
  })

  it("layer rank still beats both tie-breaks (a federal parcel wins over a place whose geoid sorts first)", async () => {
    const pt = { lng: -103.25, lat: 43.25 }
    const geom = square(pt.lng, pt.lat, 0.25)
    await upsertJurisdiction(h.sql, row({ geoid: "AAA-PLACE", layer: "place", geometry: geom }))
    await upsertJurisdiction(h.sql, row({ geoid: "ZZZ-FEDERAL", layer: "federal", geometry: geom }))
    const r = await resolveJurisdiction(h.sql, pt.lng, pt.lat)
    expect(r?.geoid).toBe("ZZZ-FEDERAL")
    expect(r?.layer).toBe("federal")
  })


  it("ingestGeoJsonFile loads a FeatureCollection in one transaction, prefixing geoids and stamping codes", async () => {
    const fc = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { geoid: "9001", name: "File One" }, geometry: square(-105, 45, 0.2) },
        { type: "Feature", properties: { geoid: "9002", name: "File Two" }, geometry: square(-106, 45, 0.2) },
        { type: "Feature", properties: { geoid: "9003" }, geometry: square(-107, 45, 0.2) },
      ],
    })
    const res = await ingestGeoJsonFile(h.sql, fc, "federal", "FIXT-")
    expect(res).toEqual({ upserted: 2, skipped: 1, features: 3 })

    const one = await read("FIXT-9001")
    const two = await read("FIXT-9002")
    expect(one!.name).toBe("File One")
    expect(two!.name).toBe("File Two")
    expect(one!.code).not.toBeNull()
    expect(two!.code).not.toBeNull()
    expect(one!.code).not.toBe(two!.code)
    expect(await read("FIXT-9003")).toBeUndefined()
  })

  it("ingestGeoJsonFile REJECTS a non-FeatureCollection payload and writes nothing", async () => {
    await expect(
      ingestGeoJsonFile(h.sql, JSON.stringify({ type: "Feature", properties: {}, geometry: null }), "federal"),
    ).rejects.toThrow(/not a GeoJSON FeatureCollection/)
    await expect(ingestGeoJsonFile(h.sql, "{not json", "federal")).rejects.toThrow()
  })

  it("ingestGeoJsonFile is ATOMIC: one bad geometry rolls back the whole layer", async () => {
    const fc = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { geoid: "8001", name: "Atomic Good" }, geometry: square(-108, 46, 0.2) },
        {
          type: "Feature",
          properties: { geoid: "8002", name: "Atomic Bad" },
          geometry: { type: "Polygon", coordinates: "not-a-ring" },
        },
      ],
    })
    await expect(ingestGeoJsonFile(h.sql, fc, "federal", "ATOM-")).rejects.toThrow()
    expect(await read("ATOM-8001")).toBeUndefined()
    expect(await read("ATOM-8002")).toBeUndefined()
  })

  it("SKIPS a self-intersecting (ST_IsValid=false) polygon without storing it or aborting the layer", async () => {
    const bowtie: IngestRow["geometry"] = {
      type: "Polygon",
      coordinates: [
        [
          [-90, 40],
          [-88, 42],
          [-88, 40],
          [-90, 42],
          [-90, 40],
        ],
      ],
    }
    const fc = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { geoid: "7001", name: "Valid Unit" }, geometry: square(-92, 41, 0.2) },
        { type: "Feature", properties: { geoid: "7002", name: "Self Intersecting" }, geometry: bowtie },
      ],
    })
    const res = await ingestGeoJsonFile(h.sql, fc, "federal", "VALID-")
    expect(res).toEqual({ upserted: 1, skipped: 1, features: 2 })
    expect((await read("VALID-7001"))!.name).toBe("Valid Unit")
    expect(await read("VALID-7002")).toBeUndefined()
  })

  it("upsertJurisdiction returns whether a row was written (false for an invalid geometry)", async () => {
    const bowtie: IngestRow["geometry"] = {
      type: "Polygon",
      coordinates: [
        [
          [-70, 40],
          [-68, 42],
          [-68, 40],
          [-70, 42],
          [-70, 40],
        ],
      ],
    }
    expect(await upsertJurisdiction(h.sql, row({ geoid: "PADUS-VALID-1", geometry: square(-71, 41, 0.2) }))).toBe(true)
    expect(await upsertJurisdiction(h.sql, row({ geoid: "PADUS-INVALID-1", geometry: bowtie }))).toBe(false)
    expect(await read("PADUS-INVALID-1")).toBeUndefined()
  })
})
