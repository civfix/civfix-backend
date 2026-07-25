/**
 * "The report's first visible still" — ONE preview policy across every surface (Docker-gated).
 *
 * report-sql.ts:firstReadyStillLateral is the single join that decides which media asset stands in as a
 * report's thumbnail. The event gallery (cleanup-repository.drizzle.ts:loadLinkedReportsForCleanups) used to
 * hand-roll its own copy with a WIDER guard than the map/search/post-card sites, so a report whose only
 * ready asset was a video-with-poster showed a thumbnail in the gallery and nowhere else. These tests assert
 * the two surfaces agree, asset by asset — including the case the gallery's local copy was written for (a
 * thumbless video must never hand its raw .mp4 key back as a thumbnail).
 *
 * Both surfaces are exercised through their real repositories against a live PostGIS container.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
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

  /** A published+public report at the in-city probe point (so it lands in the LA_CITY bbox query). */
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
    await h.sql`
      INSERT INTO media_assets (upload_id, report_id, kind, r2_key, thumb_key, status, created_at)
      VALUES (
        ${randomUUID()}, ${reportId}, ${opts.kind}, ${opts.r2Key}, ${opts.thumbKey ?? null},
        ${opts.status ?? "ready"}, ${opts.createdAt ?? new Date()}
      )
    `
  }

  /** The event gallery's view of a report (via a cleanup it is linked to). */
  async function galleryThumb(reportId: string, organizerId: string): Promise<string | null> {
    const cleanupId = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status)
      VALUES (
        ${cleanupId}, ${organizerId}, 'site', 'Preview policy sweep',
        ST_SetSRID(ST_MakePoint(${PROBE_INSIDE_CITY.lng}, ${PROBE_INSIDE_CITY.lat}), 4326),
        now() + interval '1 day', 'upcoming'
      )
    `
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

  /** The map pin's view of the same report (selectPublicPins -> firstReadyStillLateral). */
  async function pinKeys(reportId: string): Promise<{ thumbKey: string | null; r2Key: string | null }> {
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

    // Map pin: the poster is offered as the thumb (the service prefers thumbKey over r2Key).
    const pin = await pinKeys(reportId)
    expect(pin.thumbKey).toBe("media/clip-poster.jpg")
    expect(pin.r2Key).toBe("media/clip.mp4")
    // Gallery: the single rendered key is the SAME poster (was the only surface that showed one before).
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
    expect(pin.r2Key).toBe("media/photo.jpg")
    expect(await galleryThumb(reportId, org)).toBe("media/photo.jpg")
  })

  it("only READY assets can preview, and the earliest qualifying one wins on both surfaces", async () => {
    const org = await newUser("Still Org D")
    const reportId = await newReport(org, "Ordering")
    // Still validating (invisible), oldest.
    await addMedia(reportId, {
      kind: "image",
      r2Key: "media/pending.jpg",
      thumbKey: "media/pending-t.jpg",
      status: "validating",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    // Earliest READY asset: a video poster.
    await addMedia(reportId, {
      kind: "video",
      r2Key: "media/first.mp4",
      thumbKey: "media/first-poster.jpg",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    })
    // Later ready image must not win.
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
