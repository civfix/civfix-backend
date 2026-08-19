
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
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
    const id = randomUUID()
    await h.sql`
      INSERT INTO cleanups (id, organizer_user_id, type, title, geom, scheduled_at, status, jurisdiction_geoid)
      VALUES (
        ${id}, ${organizerId}, 'site', ${title},
        ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326),
        now() + interval '2 days', 'upcoming', ${LA_CITY.geoid}
      )
    `
    return id
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
