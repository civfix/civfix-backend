/**
 * Reports integration test (Docker-gated). Exercises the REAL transaction path: the Drizzle/PostGIS
 * ReportRepository + the report service against a live PostGIS container (via withPg, which seeds the
 * canonical jurisdictions). It is driven at the service+repository layer (not over HTTP) so it needs no
 * Redis/auth - it proves the spatial write/read, jurisdiction resolution, media attach, timeline, and
 * the section-17 idempotency probe directly.
 *
 * Proven here (the Phase-1 done-criterion + the section-17 probe):
 *   - a created pin has the correct geom (ST_X/ST_Y round-trip), geom_source = device, the jurisdiction
 *     resolved from the seeded set, the media_asset attached (report_id set), and a timeline row;
 *   - submitting the SAME idempotency key again returns the SAME report id, inserts NO second report row,
 *     and does NOT orphan or duplicate the media (the asset stays attached to the original report).
 *   - a bbox query returns the inserted point.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf) so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeReportService, type ReportService } from "../../src/services/report-service.js"
import type { CreateReportRequest } from "@civfix/shared"
import { LA_CITY, PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("reports (integration: real transaction path)", () => {
  let h: PgHarness
  let service: ReportService
  let userId: string

  beforeAll(async () => {
    h = pg as PgHarness
    // The real jurisdiction resolver runs the canonical spatial query against the seeded jurisdictions.
    service = makeReportService({
      repo: makeDrizzleReportRepository(h.sql),
      resolveJurisdictionGeoid: async (lat, lng) => {
        const rows = await h.sql<{ geoid: string }[]>`
          SELECT geoid FROM jurisdictions
          WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
          ORDER BY CASE layer WHEN 'place' THEN 0 WHEN 'county' THEN 1 ELSE 2 END
          LIMIT 1
        `
        return rows[0]?.geoid ?? null
      },
      // Presign is irrelevant to the DB contract here; echo the key.
      presignMedia: (r2Key, thumbKey) =>
        Promise.resolve(
          thumbKey === null
            ? { url: `memory://${r2Key}` }
            : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
        ),
    })

    // A real reporter user (reports.reporter_user_id FK -> users.id).
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Reporter') RETURNING id
    `
    userId = u!.id
  })

  afterAll(async () => {
    await h.teardown()
  })

  /** Seed a finalized-but-unattached media_asset (as media-intake would have left it). */
  async function seedMedia(): Promise<{ id: string; uploadId: string }> {
    const uploadId = randomUUID()
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, byte_size)
      VALUES (${uploadId}, 'image', ${`uploads/2026/01/${"f".repeat(64)}`}, 'validating', 1024)
      RETURNING id
    `
    return { id: row!.id, uploadId }
  }

  function createReq(over: Partial<CreateReportRequest>): CreateReportRequest {
    return {
      idempotencyKey: over.idempotencyKey ?? randomUUID(),
      category: over.category ?? "trash",
      lat: over.lat ?? PROBE_INSIDE_CITY.lat,
      lng: over.lng ?? PROBE_INSIDE_CITY.lng,
      geomSource: over.geomSource ?? "device",
      mediaUploadIds: over.mediaUploadIds ?? [],
      ...(over.description !== undefined ? { description: over.description } : {}),
    }
  }

  it("creates a pin with correct geom, geom_source=device, jurisdiction, media attached, timeline", async () => {
    const media = await seedMedia()
    const key = randomUUID()
    const dto = await service.createReport(
      createReq({ idempotencyKey: key, category: "graffiti", mediaUploadIds: [media.uploadId] }),
      { userId },
    )

    // The DTO is the inside-city point, published immediately, resolved to LA city.
    expect(dto.status).toBe("published")
    expect(dto.geomSource).toBe("device")
    expect(dto.jurisdictionGeoid).toBe(LA_CITY.geoid)
    expect(dto.media).toHaveLength(1)
    expect(dto.media[0]!.id).toBe(media.id)
    expect(dto.timeline).toHaveLength(1)
    expect(dto.timeline[0]!.status).toBe("published")

    // Geom round-trip: ST_X/ST_Y match the submitted lng/lat.
    const [geo] = await h.sql<{ lng: number; lat: number; geom_source: string; h3_cell: string }[]>`
      SELECT ST_X(geom) AS lng, ST_Y(geom) AS lat, geom_source, h3_cell
      FROM reports WHERE id = ${dto.id}
    `
    expect(geo!.lng).toBeCloseTo(PROBE_INSIDE_CITY.lng, 9)
    expect(geo!.lat).toBeCloseTo(PROBE_INSIDE_CITY.lat, 9)
    expect(geo!.geom_source).toBe("device")
    expect(geo!.h3_cell.length).toBeGreaterThan(0)

    // The media_asset is now attached to this report.
    const [m] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBe(dto.id)

    // The timeline row exists in the DB.
    const tl = await h.sql<{ status: string }[]>`
      SELECT status FROM report_timeline WHERE report_id = ${dto.id}
    `
    expect(tl).toHaveLength(1)
    expect(tl[0]!.status).toBe("published")

    // The idempotency snapshot was persisted in the same transaction.
    const idem = await h.sql<{ key: string }[]>`
      SELECT key FROM idempotency_keys WHERE key = ${key} AND scope = 'report_create'
    `
    expect(idem).toHaveLength(1)
  })

  it("SECTION-17 PROBE: a duplicate idempotency key returns the original, no new row, no orphan/dup media", async () => {
    const media = await seedMedia()
    const key = randomUUID()
    const req = createReq({ idempotencyKey: key, mediaUploadIds: [media.uploadId] })

    const first = await service.createReport(req, { userId })

    // Count reports + media-attachments BEFORE the retry.
    const before = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(before[0]!.n).toBe(1)

    // Submit the SAME key again (with a different-looking body to prove the original wins).
    const second = await service.createReport(
      createReq({ idempotencyKey: key, category: "hazard", description: "changed", mediaUploadIds: [media.uploadId] }),
      { userId },
    )

    // Same id returned, original content (category trash, not hazard).
    expect(second.id).toBe(first.id)
    expect(second.category).toBe(first.category)
    expect(second.category).toBe("trash")

    // Still exactly ONE report row for that key (no duplicate).
    const after = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(after[0]!.n).toBe(1)

    // The media asset is attached to exactly ONE report (the original) - not orphaned, not duplicated.
    const mediaRows = await h.sql<{ id: string; report_id: string | null }[]>`
      SELECT id, report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(mediaRows).toHaveLength(1)
    expect(mediaRows[0]!.report_id).toBe(first.id)
  })

  it("does not steal a media asset already attached to a different report", async () => {
    // Create report A owning the media.
    const media = await seedMedia()
    const a = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [media.uploadId] }),
      { userId },
    )
    // Report B tries to claim the same upload id.
    const b = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [media.uploadId] }),
      { userId },
    )
    expect(b.media).toHaveLength(0)
    const [m] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBe(a.id)
  })

  it("a bbox query returns the inserted point (published + public)", async () => {
    const key = randomUUID()
    const created = await service.createReport(
      createReq({ idempotencyKey: key, category: "water" }),
      { userId },
    )

    // Query the LA city bbox at high zoom (individual pins) and expect the new pin to be present.
    const [west, south, east, north] = LA_CITY.bbox
    const res = await service.listReportsInBBox({ west, south, east, north }, null, 16)
    const ids = res.pins.map((p) => p.id)
    expect(ids).toContain(created.id)
    const pin = res.pins.find((p) => p.id === created.id)!
    expect(pin.lat).toBeCloseTo(PROBE_INSIDE_CITY.lat, 6)
    expect(pin.lng).toBeCloseTo(PROBE_INSIDE_CITY.lng, 6)
  })
})
