import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { CreateReportRequest } from "@civfix/shared"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedMediaAsset, type SeededMedia } from "../helpers/media-pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import { makeReportService, type ReportService } from "../../src/services/report-service.js"
import { PROBE_INSIDE_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const UNAVAILABLE = "One or more media uploads are unavailable."

describe.skipIf(!pg)("report media claim (integration: only unbound report media)", () => {
  let h: PgHarness
  let service: ReportService
  let attackerId: string

  beforeAll(async () => {
    h = pg as PgHarness
    service = makeReportService({
      repo: makeDrizzleReportRepository(h.sql),
      resolveJurisdictionGeoid: () => Promise.resolve(null),
      presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
    })
    attackerId = await newUser("attacker")
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  function createReq(mediaUploadIds: string[]): CreateReportRequest {
    return {
      idempotencyKey: randomUUID(),
      category: "trash",
      type: "dump",
      lat: PROBE_INSIDE_CITY.lat,
      lng: PROBE_INSIDE_CITY.lng,
      geomSource: "device",
      mediaUploadIds,
    }
  }

  async function expectUnclaimable(media: SeededMedia, purpose: string): Promise<void> {
    await expect(
      service.createReport(createReq([media.uploadId]), { userId: attackerId }),
    ).rejects.toMatchObject({
      httpStatus: 422,
      code: "VALIDATION",
      fields: { mediaUploadIds: UNAVAILABLE },
    })
    const [row] = await h.sql<{ report_id: string | null; purpose: string }[]>`
      SELECT report_id, purpose FROM media_assets WHERE id = ${media.id}
    `
    expect(row!.report_id).toBeNull()
    expect(row!.purpose).toBe(purpose)
  }

  it("refuses another user's avatar, which keeps purpose 'report'", async () => {
    const victim = await newUser("avatar victim")
    const media = await seedMediaAsset(h.sql)
    await h.sql`UPDATE users SET avatar_media_id = ${media.id} WHERE id = ${victim}`

    await expectUnclaimable(media, "report")
  })

  it("refuses a chat group avatar", async () => {
    const owner = await newUser("group owner")
    const media = await seedMediaAsset(h.sql)
    await h.sql`
      INSERT INTO chat_groups (name, owner_id, visibility, avatar_media_id)
      VALUES ('Neighbors', ${owner}, 'public', ${media.id})
    `

    await expectUnclaimable(media, "report")
  })

  it("refuses an organization logo", async () => {
    const media = await seedMediaAsset(h.sql, { purpose: "org_logo" })
    const slug = `org-${randomUUID().slice(0, 8)}`
    await h.sql`
      INSERT INTO organizations (slug, name, logo_media_id) VALUES (${slug}, ${slug}, ${media.id})
    `

    await expectUnclaimable(media, "org_logo")
  })

  it("refuses a private event's cover image", async () => {
    const organizer = await newUser("event organizer")
    const media = await seedMediaAsset(h.sql, { purpose: "event_cover" })
    const cleanupId = await seedCleanup(h.sql, {
      organizerUserId: organizer,
      coverMediaId: media.id,
    })
    await h.sql`UPDATE cleanups SET visibility = 'private' WHERE id = ${cleanupId}`

    await expectUnclaimable(media, "event_cover")
  })

  it("refuses a verification document even when nothing else binds it", async () => {
    const media = await seedMediaAsset(h.sql, { purpose: "verification" })

    await expectUnclaimable(media, "verification")
  })

  it("still claims the reporter's own unbound report upload", async () => {
    const media = await seedMediaAsset(h.sql)

    const dto = await service.createReport(createReq([media.uploadId]), { userId: attackerId })

    expect(dto.media.map((m) => m.id)).toEqual([media.id])
    const [row] = await h.sql<{ report_id: string | null }[]>`
      SELECT report_id FROM media_assets WHERE id = ${media.id}
    `
    expect(row!.report_id).toBe(dto.id)
  })
})
