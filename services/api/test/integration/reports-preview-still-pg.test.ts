// firstReadyStillLateral is the one join that picks a report's thumbnail. The event gallery once
// hand-rolled a wider copy, so a video-with-poster report had a thumbnail there and nowhere else. These
// assert the surfaces agree asset by asset, including that a thumbless video never hands back its raw
// .mp4 key as a thumbnail.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { seedMediaAsset, servedKeyFor } from "../helpers/media-pg.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { LA_CITY, PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("first-visible-still preview policy (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newReport(reporterId: string, title: string): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, category, type, title, status, visibility, geom, geom_source,
        idempotency_key, h3_cell
      )
      VALUES (
        ${reporterId}, 'trash', 'trash', ${title}, 'published', 'public',
        ST_SetSRID(ST_MakePoint(${PROBE_INSIDE_CITY.lng}, ${PROBE_INSIDE_CITY.lat}), 4326), 'device',
        ${randomUUID()}, 'h0'
      ) RETURNING id
    `
    return r!.id
  }

  async function addMedia(
    reportId: string,
    opts: {
      kind: "image" | "video"
      r2Key: string
      thumbKey?: string | null
      status?: "ready" | "validating"
      createdAt?: Date
    },
  ): Promise<void> {
    await seedMediaAsset(h.sql, {
      reportId,
      kind: opts.kind,
      r2Key: opts.r2Key,
      thumbKey: opts.thumbKey ?? null,
      status: opts.status ?? "ready",
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    })
  }

  async function galleryThumb(reportId: string, organizerId: string): Promise<string | null> {
    const cleanupId = await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title: "Preview policy sweep",
      lng: PROBE_INSIDE_CITY.lng,
      lat: PROBE_INSIDE_CITY.lat,
    })
    await h.sql`
      INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
      VALUES (${cleanupId}, ${reportId}, ${organizerId})
    `
    const repo = makeDrizzleCleanupRepository(h.sql)
    const grouped = await repo.loadLinkedReportsForCleanups([cleanupId])
    const view = grouped.get(cleanupId)?.find((r) => r.id === reportId)
    expect(view).toBeDefined()
    return view!.thumbKey
  }

  async function pinKeys(
    reportId: string,
  ): Promise<{ thumbKey: string | null; r2Key: string | null }> {
    const repo = makeDrizzleReportRepository(h.sql)
    const [west, south, east, north] = LA_CITY.bbox
    const pins = await repo.findMapCandidates({ west, south, east, north }, null, null, 500)
    const pin = pins.find((p) => p.id === reportId)
    expect(pin).toBeDefined()
    return { thumbKey: pin!.thumbKey, r2Key: pin!.r2Key }
  }

  it("a video WITH a poster previews identically in the gallery and on the map pin", async () => {
    const org = await newUser("Still Org A")
    const reportId = await newReport(org, "Video with poster")
    await addMedia(reportId, {
      kind: "video",
      r2Key: "media/clip.mp4",
      thumbKey: "media/clip-poster.jpg",
    })

    // The service prefers thumbKey over r2Key.
    const pin = await pinKeys(reportId)
    expect(pin.thumbKey).toBe("media/clip-poster.jpg")
    expect(pin.r2Key).toBe(servedKeyFor("media/clip.mp4"))
    expect(await galleryThumb(reportId, org)).toBe("media/clip-poster.jpg")
  })

  it("a THUMBLESS video previews on neither surface (no raw .mp4 key as a thumbnail)", async () => {
    const org = await newUser("Still Org B")
    const reportId = await newReport(org, "Video without poster")
    await addMedia(reportId, { kind: "video", r2Key: "media/raw.mp4", thumbKey: null })

    const pin = await pinKeys(reportId)
    expect(pin.thumbKey).toBeNull()
    expect(pin.r2Key).toBeNull()
    expect(await galleryThumb(reportId, org)).toBeNull()
  })

  it("an image with no thumb yet falls back to its full-size key on both surfaces", async () => {
    const org = await newUser("Still Org C")
    const reportId = await newReport(org, "Image without thumb")
    await addMedia(reportId, { kind: "image", r2Key: "media/photo.jpg", thumbKey: null })

    const pin = await pinKeys(reportId)
    expect(pin.thumbKey).toBeNull()
    expect(pin.r2Key).toBe(servedKeyFor("media/photo.jpg"))
    expect(await galleryThumb(reportId, org)).toBe(servedKeyFor("media/photo.jpg"))
  })

  it("only READY assets can preview, and the earliest qualifying one wins on both surfaces", async () => {
    const org = await newUser("Still Org D")
    const reportId = await newReport(org, "Ordering")
    await addMedia(reportId, {
      kind: "image",
      r2Key: "media/pending.jpg",
      thumbKey: "media/pending-t.jpg",
      status: "validating",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    await addMedia(reportId, {
      kind: "video",
      r2Key: "media/first.mp4",
      thumbKey: "media/first-poster.jpg",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    })
    await addMedia(reportId, {
      kind: "image",
      r2Key: "media/second.jpg",
      thumbKey: "media/second-t.jpg",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    })

    const pin = await pinKeys(reportId)
    expect(pin.thumbKey).toBe("media/first-poster.jpg")
    expect(await galleryThumb(reportId, org)).toBe("media/first-poster.jpg")
  })
})
