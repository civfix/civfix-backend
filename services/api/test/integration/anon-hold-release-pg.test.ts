/**
 * Every anonymous submit opens a moderation_items row ("Held report" / "Hidden pending review") inside
 * the held-create transaction, but the AUTOMATED release path used to only flip the report to published,
 * so nothing closed the item. The admin queue lists `WHERE status='open'` with no join to the
 * report's current status, so it accumulated one permanently-open row per anonymous report ever
 * submitted, each asserting a report is hidden pending review while it is in fact live on the public map.
 *
 * The item now closes ATOMICALLY with the release, in publishHeldReport's own transaction, which is the
 * only place it can be asserted, so this runs against the real schema (Docker-gated). The gate cases
 * matter as much as the happy one: a release that is REFUSED (media not ready, an open abuse flag) must
 * leave the item open for the human it is queued for.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleAnonHoldReleaseRepo } from "../../src/services/anon-hold-release-repo.drizzle.js"
import type { AnonHoldReleaseRepo } from "../../src/services/anon-hold-release.js"

const pg = await withPg()

const PUBLISHED_AT = new Date("2026-08-01T00:00:00.000Z")

describe.skipIf(!pg)("F132: releasing a held anon report closes its moderation item", () => {
  let h: PgHarness
  let repo: AnonHoldReleaseRepo

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleAnonHoldReleaseRepo(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE moderation_items, abuse_flags, report_timeline RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM media_assets`
    await h.sql`DELETE FROM reports`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function heldAnonReport(): Promise<string> {
    const rows = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, visibility, h3_cell, anon_session_id)
      VALUES (
        ${randomUUID()},
        ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
        'device', 'trash', 'dump', 'held', 'unlisted', 'h0', ${randomUUID()}
      )
      RETURNING id
    `
    return rows[0]!.id
  }

  async function openItemFor(reportId: string): Promise<string> {
    const rows = await h.sql<{ id: string }[]>`
      INSERT INTO moderation_items (kind, subject_type, subject_id, flag, auto_action, status)
      VALUES ('image', 'report', ${reportId}, 'Held report', 'Hidden pending review', 'open')
      RETURNING id
    `
    return rows[0]!.id
  }

  async function itemState(id: string): Promise<{ status: string; resolved_at: Date | null }> {
    const rows = await h.sql<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM moderation_items WHERE id = ${id}
    `
    return rows[0]!
  }

  it("closes the open item as approved, in the same transaction as the publish", async () => {
    const reportId = await heldAnonReport()
    const itemId = await openItemFor(reportId)

    expect(await repo.publishHeldReport(reportId, PUBLISHED_AT)).toBe(true)

    const [report] = await h.sql<{ status: string }[]>`
      SELECT status FROM reports WHERE id = ${reportId}
    `
    expect(report!.status).toBe("published")

    const item = await itemState(itemId)
    expect(item.status).toBe("approved")
    expect(item.resolved_at).not.toBeNull()

    const open = await h.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM moderation_items WHERE status = 'open'
    `
    expect(open[0]!.n).toBe(0)
  })

  it("leaves the item OPEN when the release is refused by an unresolved abuse flag", async () => {
    const reportId = await heldAnonReport()
    const itemId = await openItemFor(reportId)
    await h.sql`
      INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
      VALUES ('report', ${reportId}, 'honeypot', 'api')
    `

    expect(await repo.publishHeldReport(reportId, PUBLISHED_AT)).toBe(false)

    const [report] = await h.sql<{ status: string }[]>`
      SELECT status FROM reports WHERE id = ${reportId}
    `
    expect(report!.status).toBe("held")
    expect((await itemState(itemId)).status).toBe("open")
  })

  it("closes only the released report's item, never another report's", async () => {
    const released = await heldAnonReport()
    const other = await heldAnonReport()
    const releasedItem = await openItemFor(released)
    const otherItem = await openItemFor(other)

    expect(await repo.publishHeldReport(released, PUBLISHED_AT)).toBe(true)

    expect((await itemState(releasedItem)).status).toBe("approved")
    expect((await itemState(otherItem)).status).toBe("open")
  })

  it("does not resurrect an already-resolved item (a second release is a no-op)", async () => {
    const reportId = await heldAnonReport()
    const itemId = await openItemFor(reportId)
    expect(await repo.publishHeldReport(reportId, PUBLISHED_AT)).toBe(true)
    const first = await itemState(itemId)

    expect(await repo.publishHeldReport(reportId, new Date("2026-08-02T00:00:00.000Z"))).toBe(false)
    expect(await itemState(itemId)).toEqual(first)
  })
})
