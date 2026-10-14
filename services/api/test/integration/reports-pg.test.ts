// Driven at the service+repository layer against real PostGIS (withPg seeds the canonical
// jurisdictions), so it needs no Redis or auth.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeReportService, type ReportService } from "../../src/services/report-service.js"
import type { CreateReportRequest } from "@civfix/shared"
import { CALIFORNIA, LA_CITY, PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("reports (integration: real transaction path)", () => {
  let h: PgHarness
  let service: ReportService
  let userId: string

  beforeAll(async () => {
    h = pg as PgHarness
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
      presignMedia: (r2Key, thumbKey) =>
        Promise.resolve(
          thumbKey === null
            ? { url: `memory://${r2Key}` }
            : { url: `memory://${r2Key}`, thumbUrl: `memory://${thumbKey}` },
        ),
    })

    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Reporter') RETURNING id
    `
    userId = u!.id
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function seedMedia(): Promise<{ id: string; uploadId: string }> {
    const uploadId = randomUUID()
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, byte_size, finalized_at)
      VALUES (${uploadId}, 'image', ${`uploads/2026/01/${"f".repeat(64)}`}, 'validating', 1024, now())
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

    expect(dto.status).toBe("published")
    expect(dto.geomSource).toBe("device")
    expect(dto.jurisdictionGeoid).toBe(LA_CITY.geoid)
    expect(dto.media).toHaveLength(1)
    expect(dto.media[0]!.id).toBe(media.id)
    expect(dto.timeline).toHaveLength(1)
    expect(dto.timeline[0]!.status).toBe("published")

    const [geo] = await h.sql<{ lng: number; lat: number; geom_source: string; h3_cell: string }[]>`
      SELECT ST_X(geom) AS lng, ST_Y(geom) AS lat, geom_source, h3_cell
      FROM reports WHERE id = ${dto.id}
    `
    expect(geo!.lng).toBeCloseTo(PROBE_INSIDE_CITY.lng, 9)
    expect(geo!.lat).toBeCloseTo(PROBE_INSIDE_CITY.lat, 9)
    expect(geo!.geom_source).toBe("device")
    expect(geo!.h3_cell.length).toBeGreaterThan(0)

    const [m] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBe(dto.id)

    const tl = await h.sql<{ status: string }[]>`
      SELECT status FROM report_timeline WHERE report_id = ${dto.id}
    `
    expect(tl).toHaveLength(1)
    expect(tl[0]!.status).toBe("published")

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

    const before = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(before[0]!.n).toBe(1)

    // A different body under the same key proves the original wins.
    const second = await service.createReport(
      createReq({
        idempotencyKey: key,
        category: "hazard",
        description: "changed",
        mediaUploadIds: [media.uploadId],
      }),
      { userId },
    )

    expect(second.id).toBe(first.id)
    expect(second.category).toBe(first.category)
    expect(second.category).toBe("trash")

    const after = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reports WHERE idempotency_key = ${key}
    `
    expect(after[0]!.n).toBe(1)

    const mediaRows = await h.sql<{ id: string; report_id: string | null }[]>`
      SELECT id, report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(mediaRows).toHaveLength(1)
    expect(mediaRows[0]!.report_id).toBe(first.id)
  })

  it("F087e: REJECTS (422) a create whose media is VALIDATING but never finalized, leaving the row unbound", async () => {
    // A row is created 'validating' at PRESIGN time, before any bytes exist. Binding one of those made a
    // permanently stranded asset: bound (so findOrphans skips it), unfinalized (so the stuck sweep skips
    // it), with no media.checks job behind it, and for an anon report it wedged the hold-release gate
    // forever, because the report waits on media that will never resolve.
    const uploadId = randomUUID()
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO media_assets (upload_id, kind, r2_key, status, byte_size)
      VALUES (${uploadId}, 'image', ${`uploads/2026/01/${uploadId}`}, 'validating', 1024)
      RETURNING id
    `

    await expect(
      service.createReport(
        createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [uploadId] }),
        {
          userId,
        },
      ),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: "One or more media uploads are unavailable." },
    })

    const [after] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${row!.id}
    `
    expect(after!.report_id).toBeNull()

    // Once finalize stamps the watermark the same upload binds, so this is a timing gate on the intake
    // handshake, not a restriction on what may be attached.
    await h.sql`UPDATE media_assets SET finalized_at = now() WHERE id = ${row!.id}`
    const ok = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [uploadId] }),
      { userId },
    )
    expect(ok.media.map((m) => m.id)).toEqual([row!.id])
  })

  it("REJECTS (422) a create whose media is already attached to a different report, and leaves it on A", async () => {
    const media = await seedMedia()
    const a = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), mediaUploadIds: [media.uploadId] }),
      { userId },
    )

    // An unclaimable id fails the whole create instead of being silently dropped: the reporter used to
    // get a 201 with their photo missing from the gallery and no way to tell.
    const keyB = randomUUID()
    await expect(
      service.createReport(createReq({ idempotencyKey: keyB, mediaUploadIds: [media.uploadId] }), {
        userId,
      }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: "One or more media uploads are unavailable." },
    })

    // Security: B must never be able to re-point another report's photo at itself.
    const [m] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(m!.report_id).toBe(a.id)

    // The whole transaction rolled back: no idempotency snapshot a retry would replay as a success.
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
    // a stale draft, or a probe).
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

  // The client's `zoom` is advisory (effective zoom is min(requested, impliedZoomForBBox)), so the bbox
  // must be small enough to justify per-pin zoom. A state-wide bbox implies 7 and would make every `pins`
  // assertion check an empty array forever; this ~0.04° box implies 16.
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
    expect(created.type).toBe("infrastructure")

    const res = await service.listReportsInBBox(STREET_BBOX, null, null, 16)
    const ids = res.pins.map((p) => p.id)
    expect(ids).toContain(created.id)
    const pin = res.pins.find((p) => p.id === created.id)!
    expect(pin.lat).toBeCloseTo(PROBE_INSIDE_CITY.lat, 6)
    expect(pin.lng).toBeCloseTo(PROBE_INSIDE_CITY.lng, 6)
    expect(pin.type).toBe("infrastructure")
    // Counts cover every candidate regardless of the cluster/pin split.
    expect(res.counts?.water).toBeGreaterThanOrEqual(1)
  })

  it("M14: the SAME point over a state-wide bbox clusters even when the client claims zoom 22", async () => {
    // Anonymous DoS guard: a free `zoom` let bbox=<whole world>&zoom=22 skip clustering and force up to
    // 2000 rows + 2000 presigns per request, so the bbox extent caps the zoom. Proven against a live DB
    // because the presign fan-out lives on the service side of that branch.
    const created = await service.createReport(
      createReq({ idempotencyKey: randomUUID(), category: "hazard", type: "pavement" }),
      { userId },
    )

    const [west, south, east, north] = CALIFORNIA.bbox
    const wide = await service.listReportsInBBox({ west, south, east, north }, null, null, 22)
    expect(wide.pins).toHaveLength(0)
    expect(wide.clusters.length).toBeGreaterThan(0)
    // Still counted and clustered near its true location, not filtered out.
    const total = wide.clusters.reduce((n, c) => n + c.count, 0)
    expect(total).toBeGreaterThanOrEqual(1)
    expect(wide.counts?.hazard).toBeGreaterThanOrEqual(1)

    // A street-level bbox returns it as a pin, so the zero above is the clamp, not a visibility filter.
    const tight = await service.listReportsInBBox(STREET_BBOX, null, null, 22)
    expect(tight.clusters).toHaveLength(0)
    expect(tight.pins.map((p) => p.id)).toContain(created.id)
  })

  it("the type filter narrows a bbox query to matching reports only (0021)", async () => {
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
    // Unfiltered, both are in view, so the exclusion above is the filter, not the bbox.
    const all = await service.listReportsInBBox(STREET_BBOX, null, null, 16)
    expect(all.pins.map((p) => p.id)).toContain(graffiti.id)
  })
})
