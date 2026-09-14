
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  makeDrizzleCleanupRepository,
  LINKED_EVENTS_PER_REPORT_CAP,
  MAX_EVENTS_PER_REPORT,
} from "../../src/services/cleanup-repository.drizzle.js"
import type { CleanupRepository } from "../../src/services/cleanup-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("cleanup<->report link bounds (integration)", () => {
  let h: PgHarness
  let repo: CleanupRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleCleanupRepository(h.sql)
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

  async function newCleanup(organizerId: string, title: string): Promise<string> {
    return await seedCleanup(h.sql, {
      organizerUserId: organizerId,
      title,
      lng: -118.25,
      lat: 34.05,
      scheduledAt: new Date(Date.now() + 2 * 86_400_000),
      jurisdictionGeoid: LA_CITY.geoid,
    })
  }

  async function newPublicReport(title: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        idempotency_key, geom, geom_source, category, title, status, visibility, h3_cell, jurisdiction_geoid
      )
      VALUES (
        gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', ${title},
        'published', 'public', 'h0', ${LA_CITY.geoid}
      )
      RETURNING id
    `
    return row!.id
  }

  async function newHiddenReport(title: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        idempotency_key, geom, geom_source, category, title, status, visibility, h3_cell, jurisdiction_geoid
      )
      VALUES (
        gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', ${title},
        'published', 'hidden', 'h0', ${LA_CITY.geoid}
      )
      RETURNING id
    `
    return row!.id
  }

  it("reconcile leaves a link to an invisible report intact and only unlinks what the host can see", async () => {
    const org = await newUser("Reconcile Org")
    const cleanupId = await newCleanup(org, "Reconcile sweep")
    const visibleKept = await newPublicReport("Kept")
    const visibleDropped = await newPublicReport("Dropped")
    const invisible = await newHiddenReport("Unlisted by erasure")
    const added = await newPublicReport("Added")
    for (const reportId of [visibleKept, visibleDropped, invisible]) {
      await h.sql`
        INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
        VALUES (${cleanupId}, ${reportId}, ${org})
      `
    }

    const diff = await repo.reconcileLinkedReports(cleanupId, [visibleKept, added], org)

    expect(diff.added).toEqual([added])
    expect(diff.removed).toEqual([visibleDropped])
    const remaining = await h.sql<{ report_id: string }[]>`
      SELECT report_id FROM cleanup_reports WHERE cleanup_id = ${cleanupId} ORDER BY report_id
    `
    expect(remaining.map((r) => r.report_id).sort()).toEqual(
      [visibleKept, invisible, added].sort(),
    )
    const unlinked = await h.sql<{ note: string | null }[]>`
      SELECT note FROM cleanup_timeline
      WHERE cleanup_id = ${cleanupId} AND kind = 'report_unlinked'
    `
    expect(unlinked).toHaveLength(1)
    expect(unlinked[0]!.note).toBe(`Unlinked report ${visibleDropped}`)
  })

  it("F064: the batched cleanup gallery honours the per-cleanup cap, newest link first", async () => {
    const org = await newUser("Gallery Org")
    const cleanupId = await newCleanup(org, "Gallery sweep")
    const reportIds: string[] = []
    for (let i = 0; i < 9; i++) reportIds.push(await newPublicReport(`Gallery ${i}`))
    for (const [i, reportId] of reportIds.entries()) {
      await h.sql`
        INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id, linked_at)
        VALUES (${cleanupId}, ${reportId}, ${org}, now() - make_interval(mins => ${9 - i}))
      `
    }

    const capped = await repo.loadLinkedReportsForCleanups([cleanupId], 4)
    const preview = capped.get(cleanupId)!
    expect(preview).toHaveLength(4)
    expect(preview.map((v) => v.id)).toEqual(reportIds.slice(-4).reverse())

    const full = await repo.loadLinkedReportsForCleanups([cleanupId])
    expect(full.get(cleanupId)).toHaveLength(9)
  })

  it("F065: the per-report event read is capped, and linking past MAX_EVENTS_PER_REPORT is refused", async () => {
    const org = await newUser("Link Cap Org")
    const reportId = await newPublicReport("Popular report")
    for (let i = 0; i < MAX_EVENTS_PER_REPORT; i++) {
      const cleanupId = await newCleanup(org, `Cap event ${i}`)
      await h.sql`
        INSERT INTO cleanup_reports (cleanup_id, report_id, linked_by_user_id)
        VALUES (${cleanupId}, ${reportId}, ${org})
      `
    }

    const grouped = await repo.loadLinkedEventsForReports([reportId])
    expect(grouped.get(reportId)).toHaveLength(LINKED_EVENTS_PER_REPORT_CAP)

    const overflow = await newCleanup(org, "Overflow event")
    await expect(repo.linkReports(overflow, [reportId], org)).rejects.toMatchObject({
      httpStatus: 422,
    })
    const linked = await h.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM cleanup_reports WHERE cleanup_id = ${overflow}
    `
    expect(linked[0]!.n).toBe(0)
  })
})
