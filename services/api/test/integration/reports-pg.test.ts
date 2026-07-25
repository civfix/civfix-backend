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
      type: over.type ?? "dump",
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

  it("REJECTS (422) a create whose media is already attached to a different report, and leaves it on A", async () => {
    // Create report A owning the media.
    const media = await seedMedia()
    const a = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [media.uploadId] }),
      { userId },
    )

    // Report B tries to claim the same upload id. The claim UPDATE matches 0 rows, and (M-media-claim)
    // an unclaimable id now FAILS THE WHOLE CREATE instead of being silently dropped: the reporter used
    // to get a 201 with their photo missing from the gallery and no way to tell that had happened.
    const keyB = randomUUID()
    await expect(
      service.createReport(
        createReq({ idempotencyKey: keyB, mediaUploadIds: [media.uploadId] }),
        { userId },
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: "One or more media uploads are unavailable." },
    })

    // THE SECURITY ASSERTION (unchanged): the asset stays bound to report A. B must never be able to
    // re-point another report's photo at itself.
    const [m] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBe(a.id)

    // ...and the rejection rolled the whole transaction back: no half-created report row, no timeline
    // row, no idempotency snapshot that a retry would replay as a success.
    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE idempotency_key = ${keyB}
    `
    expect(rows[0]!.n).toBe(0)
    const idem = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM idempotency_keys WHERE key = ${keyB} AND scope = 'report_create'
    `
    expect(idem[0]!.n).toBe(0)
  })

  it("REJECTS (422) a create naming an UNKNOWN upload id, and creates nothing", async () => {
    // Same fail-closed rule for an id that matches no media_assets row at all (a typo, a client replaying
    // a stale draft, or a probe). The pre-fix behavior was a 201 with an empty gallery.
    const key = randomUUID()
    await expect(
      service.createReport(createReq({ idempotencyKey: key, mediaUploadIds: [randomUUID()] }), {
        userId,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })

    const rows = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(rows[0]!.n).toBe(0)
  })

  it("REJECTS (422) a create naming a REJECTED asset (moderation cannot be laundered by re-claiming)", async () => {
    const media = await seedMedia()
    await h.sql`UPDATE media_assets SET status = 'rejected' WHERE id = ${media.id}`

    const key = randomUUID()
    await expect(
      service.createReport(createReq({ idempotencyKey: key, mediaUploadIds: [media.uploadId] }), {
        userId,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })

    const [m] = await h.sql<{ report_id: string | null; status: string }[]>`
      SELECT report_id, status FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBeNull()
    expect(m!.status).toBe("rejected")
  })

  it("L18: an asset already bound to a POST cannot be cross-published into a report (422, stays on the post)", async () => {
    // The claim used to guard only report_id, so the holder of an uploadId could re-bind an image from a
    // post (or a private DM/chat message, same column pattern) into a public report gallery. The predicate
    // now also requires post_id IS NULL AND chat_message_id IS NULL.
    const media = await seedMedia()
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${userId}, 'post', 'has a photo') RETURNING id
    `
    await h.sql`
      UPDATE media_assets SET post_id = ${post!.id}, purpose = 'post' WHERE id = ${media.id}
    `

    const key = randomUUID()
    await expect(
      service.createReport(createReq({ idempotencyKey: key, mediaUploadIds: [media.uploadId] }), {
        userId,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "VALIDATION" })

    const [m] = await h.sql<{ report_id: string | null; post_id: string | null }[]>`
      SELECT report_id, post_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBeNull()
    expect(m!.post_id).toBe(post!.id)
  })

  it("accepts a REPEATED upload id in one request (deduped) and attaches it exactly once", async () => {
    // The claim compares against the DEDUPED input (`new Set(...)`) because one repeated id claims one
    // row; comparing against the raw array length would 422 a legitimate duplicate-id request.
    const media = await seedMedia()
    const dto = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [media.uploadId, media.uploadId] }),
      { userId },
    )
    expect(dto.media).toHaveLength(1)
    expect(dto.media[0]!.id).toBe(media.id)
    const [m] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBe(dto.id)
  })

  /**
   * A genuinely street-level viewport around PROBE_INSIDE_CITY (where every fixture report is created).
   *
   * M14 made the client's `zoom` advisory: the effective zoom is min(requested, impliedZoomForBBox), so a
   * bbox must be small enough to JUSTIFY per-pin zoom before listReportsInBBox will return pins at all.
   * The seeded LA_CITY bbox (0.3° lng x 0.2° lat) implies 12, one step under CLUSTER_ZOOM_THRESHOLD, so
   * these tests use a ~0.04° box (implies 16) — asserting on `pins` with a city-wide bbox would silently
   * assert on an empty array forever.
   */
  const STREET_BBOX = {
    west: PROBE_INSIDE_CITY.lng - 0.02,
    east: PROBE_INSIDE_CITY.lng + 0.02,
    south: PROBE_INSIDE_CITY.lat - 0.01,
    north: PROBE_INSIDE_CITY.lat + 0.01,
  }

  it("a bbox query returns the inserted point (published + public)", async () => {
    const key = randomUUID()
    const created = await service.createReport(
      createReq({ idempotencyKey: key, category: "water", type: "infrastructure" }),
      { userId },
    )
    // The fine-grained type (0021) round-trips through the create transaction onto the DTO.
    expect(created.type).toBe("infrastructure")

    // Query a street-level bbox at high zoom (individual pins) and expect the new pin to be present.
    const res = await service.listReportsInBBox(STREET_BBOX, null, null, 16)
    const ids = res.pins.map((p) => p.id)
    expect(ids).toContain(created.id)
    const pin = res.pins.find((p) => p.id === created.id)!
    expect(pin.lat).toBeCloseTo(PROBE_INSIDE_CITY.lat, 6)
    expect(pin.lng).toBeCloseTo(PROBE_INSIDE_CITY.lng, 6)
    // The pin carries the fine-grained type alongside category.
    expect(pin.type).toBe("infrastructure")
    // The per-category counts cover every candidate regardless of the cluster/pin split.
    expect(res.counts?.water).toBeGreaterThanOrEqual(1)
  })

  it("M14: the SAME point over a city-wide bbox clusters even when the client claims zoom 22", async () => {
    // The anonymous-DoS fix: `zoom` used to be a free query parameter, so bbox=<whole world>&zoom=22
    // skipped clustering and forced up to 2000 report rows + 2000 media presigns per request. The bbox
    // extent now caps the zoom, so a claimed street-level zoom over a city cannot reach the per-pin
    // branch. Proven against a live DB (not just the pure clustering unit test) because the presign
    // fan-out lives on the service side of that branch.
    const created = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), category: "hazard", type: "pavement" }),
      { userId },
    )

    const [west, south, east, north] = LA_CITY.bbox
    const wide = await service.listReportsInBBox({ west, south, east, north }, null, null, 22)
    expect(wide.pins).toHaveLength(0)
    expect(wide.clusters.length).toBeGreaterThan(0)
    // The report is still COUNTED (and clustered near its true location) — it is not filtered out.
    const total = wide.clusters.reduce((n, c) => n + c.count, 0)
    expect(total).toBeGreaterThanOrEqual(1)
    expect(wide.counts?.hazard).toBeGreaterThanOrEqual(1)

    // ...and the identical query over a street-level bbox DOES return it as a pin, so the zero above is
    // the clamp and not a broken visibility filter.
    const tight = await service.listReportsInBBox(STREET_BBOX, null, null, 22)
    expect(tight.clusters).toHaveLength(0)
    expect(tight.pins.map((p) => p.id)).toContain(created.id)
  })

  it("the type filter narrows a bbox query to matching reports only (0021)", async () => {
    // Two published+public reports at the same point with DIFFERENT fine types; the type filter narrows.
    const dump = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), category: "trash", type: "dump" }),
      { userId },
    )
    const graffiti = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), category: "graffiti", type: "graffiti" }),
      { userId },
    )

    const res = await service.listReportsInBBox(STREET_BBOX, null, ["dump"], 16)
    const ids = res.pins.map((p) => p.id)
    expect(ids).toContain(dump.id)
    expect(ids).not.toContain(graffiti.id)
    expect(res.pins.every((p) => p.type === "dump")).toBe(true)
    // Unfiltered, both are in view — so the exclusion above is the filter, not the bbox.
    const all = await service.listReportsInBBox(STREET_BBOX, null, null, 16)
    expect(all.pins.map((p) => p.id)).toContain(graffiti.id)
  })
})
