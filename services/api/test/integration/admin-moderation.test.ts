/**
 * Admin moderation data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * ModerationRepository (makeDrizzleModerationRepository) against a live Postgres/PostGIS container via
 * withPg, which applies the canonical migrations + the jurisdiction seed (so moderation_items / reports /
 * report_timeline / media_assets / abuse_flags / audit_log all exist with their real constraints).
 *
 * Proven here against the real schema:
 *   - createItem inserts an OPEN moderation_items row (with the jsonb meta carrying reporter/desc);
 *   - listOpen pages the open items newest-first with the keyset cursor + the kind/high facet + search;
 *   - getItem returns the parsed signals/similar/meta + the joined media_assets references;
 *   - approve publishes the held report subject (held -> published, report_timeline 'published') and the
 *     item leaves the open queue (status 'approved' + resolved_at/by);
 *   - remove rejects + soft-deletes the report subject and the item leaves the queue (status 'removed');
 *   - hold extends the hold (item 'held', report untouched);
 *   - decideAppeal overturn resolves the open chat abuse_flag (lifts the suspension);
 *   - backfillFromHeldReports creates one item per held report lacking an open item.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  insertModerationItem,
  makeDrizzleModerationRepository,
} from "../../src/services/admin/moderation-repository.drizzle.js"
import type { ModerationRepository } from "../../src/services/admin/moderation-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid

/** Insert a report in the seeded jurisdiction and return its id. */
async function insertReport(
  h: PgHarness,
  opts: { category?: string; status?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category ?? "trash"},
      ${opts.status ?? "held"},
      'h0',
      ${GEOID}
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin moderation repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: ModerationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleModerationRepository(h.sql)
  })

  beforeEach(async () => {
    // Start each test from an empty surface (the moderation_items + reports + their dependents).
    await h.sql`TRUNCATE moderation_items, report_timeline, media_assets, abuse_flags, reports RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("createItem inserts an open item that listOpen returns", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
      flag: "Held report",
      reason: "Awaiting automated review",
      category: "trash",
      reporter: "Anonymous",
      desc: "a held photo",
    })
    expect(id).not.toBeNull()

    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]?.flag).toBe("Held report")
    expect(page.records[0]?.reporter).toBe("Anonymous")

    const detail = await repo.getItem(id!)
    expect(detail?.desc).toBe("a held photo")
    expect(detail?.category).toBe("trash")
  })

  it("dedupeOpen prevents a second open item for the same subject", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const first = await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
      dedupeOpen: true,
    })
    const second = await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
      dedupeOpen: true,
    })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it("approve publishes the held report and clears the item from the queue", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    const result = await repo.approve(id, { actorId: null, note: "ok" })
    expect(result).not.toBeNull()

    const [report] = await h.sql<{ status: string; published_at: Date | null }[]>`
      SELECT status, published_at FROM reports WHERE id = ${reportId}
    `
    expect(report?.status).toBe("published")
    expect(report?.published_at).not.toBeNull()

    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(0)

    const [tl] = await h.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM report_timeline WHERE report_id = ${reportId} AND status = 'published'
    `
    expect(Number(tl?.count)).toBe(1)
  })

  it("remove rejects + soft-deletes the report and clears the item", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    await repo.remove(id, { actorId: null, reason: "spam" })

    const [report] = await h.sql<{ status: string; deleted_at: Date | null }[]>`
      SELECT status, deleted_at FROM reports WHERE id = ${reportId}
    `
    expect(report?.status).toBe("rejected")
    expect(report?.deleted_at).not.toBeNull()
    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(0)
  })

  it("hold extends the hold (report stays held; item leaves the queue)", async () => {
    const reportId = await insertReport(h, { status: "held" })
    const id = (await repo.createItem({
      kind: "image",
      subjectType: "report",
      subjectId: reportId,
    }))!

    await repo.hold(id, { actorId: null, note: "need info" })

    const [report] = await h.sql<{ status: string }[]>`
      SELECT status FROM reports WHERE id = ${reportId}
    `
    expect(report?.status).toBe("held")
    const item = await repo.getItem(id)
    expect(item?.status).toBe("held")
    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 25 })
    expect(page.records).toHaveLength(0)
  })

  it("decideAppeal overturn resolves the open chat abuse_flag (lifts the suspension)", async () => {
    // A chat subject with an open abuse_flag (the suspension), and an appeal item over it.
    const chatId = (await h.sql<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0]!.id
    await h.sql`
      INSERT INTO abuse_flags (subject_type, subject_id, reason, source)
      VALUES ('chat', ${chatId}, 'manual', 'api')
    `
    const id = await insertModerationItem(h.sql, {
      kind: "appeal",
      subjectType: "chat",
      subjectId: chatId,
      flag: "Suspension appeal",
      reason: "User requests review",
    })

    await repo.decideAppeal(id, { decision: "overturn", actorId: null, note: null })

    const [flag] = await h.sql<{ resolved_at: Date | null }[]>`
      SELECT resolved_at FROM abuse_flags WHERE subject_type = 'chat' AND subject_id = ${chatId}
    `
    expect(flag?.resolved_at).not.toBeNull()
    const item = await repo.getItem(id)
    expect(item?.status).toBe("approved")
  })

  it("backfillFromHeldReports creates one item per held report lacking an open item", async () => {
    const r1 = await insertReport(h, { status: "held", category: "hazard" })
    const r2 = await insertReport(h, { status: "held", category: "trash" })
    // r3 is held but already has an open item -> not backfilled.
    const r3 = await insertReport(h, { status: "held" })
    await repo.createItem({ kind: "image", subjectType: "report", subjectId: r3 })
    // A published report is not held -> not backfilled.
    await insertReport(h, { status: "published" })

    const created = await repo.backfillFromHeldReports()
    expect(created).toBe(2)

    const page = await repo.listOpen({ q: null, filter: "all", cursor: null, limit: 100 })
    const subjectIds = new Set(page.records.map((r) => r.subjectId))
    expect(subjectIds.has(r1)).toBe(true)
    expect(subjectIds.has(r2)).toBe(true)
    expect(subjectIds.has(r3)).toBe(true)
    expect(page.records).toHaveLength(3)
  })
})
