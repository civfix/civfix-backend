
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

async function insertReport(
  h: PgHarness,
  opts: { category?: string; status?: string; reporterUserId?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid, reporter_user_id)
    VALUES (
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category ?? "trash"},
      ${opts.status ?? "held"},
      'h0',
      ${GEOID},
      ${opts.reporterUserId ?? null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertUser(h: PgHarness, handle: string): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, handle) VALUES (${`User ${handle}`}, ${handle}) RETURNING id
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

  // A reported POST has to resolve to its author (so the strike lands on the right account) and has to be
  // removable. Both switches in the repository fall through to a `default` that returns null/false, so a
  // subject type added to the enum without a case here files a queue item that no operator can action.
  it("removes a reported post: soft-deletes it and strikes its author", async () => {
    const authorId = await insertUser(h, "postauthor")
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${authorId}, 'post', 'reported content')
      RETURNING id
    `
    const postId = post!.id

    const id = (await repo.createItem({
      kind: "user_report",
      subjectType: "post",
      subjectId: postId,
      flag: "User report",
      reason: "harassment",
    }))!

    // The snapshot resolves through posts.author_id, not through a report's reporter.
    const detail = await repo.getItem(id)
    expect(detail?.user?.handle).toBe("postauthor")

    await repo.remove(id, { actorId: null, reason: "harassment" })

    // Soft delete, matching the user-facing delete: the row survives so replies keep their parent.
    const [row] = await h.sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM posts WHERE id = ${postId}
    `
    expect(row?.deleted_at).not.toBeNull()

    const [um] = await h.sql<{ strikes: number; removals: number }[]>`
      SELECT strikes, removals FROM user_moderation WHERE user_id = ${authorId}
    `

    expect(um?.strikes).toBe(1)
    expect(um?.removals).toBe(1)
  })

  it("removing a reported reply decrements its parent's reply_count", async () => {
    const authorId = await insertUser(h, "replyauthor")
    const [parent] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, reply_count)
      VALUES (${authorId}, 'post', 'the parent', 1)
      RETURNING id
    `
    const parentId = parent!.id
    const [reply] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, reply_to_id, thread_root_id)
      VALUES (${authorId}, 'reply', 'reported reply', ${parentId}, ${parentId})
      RETURNING id
    `

    const id = (await repo.createItem({
      kind: "user_report",
      subjectType: "post",
      subjectId: reply!.id,
      flag: "User report",
      reason: "harassment",
    }))!
    await repo.remove(id, { actorId: null, reason: "harassment" })

    const [counted] = await h.sql<{ reply_count: number }[]>`
      SELECT reply_count FROM posts WHERE id = ${parentId}
    `
    expect(counted?.reply_count).toBe(0)
  })

  it("remove strikes the reporter and createItem captures a real user snapshot", async () => {
    const userId = await insertUser(h, "rmreporter")
    const reportId = await insertReport(h, { status: "held", reporterUserId: userId })
    const id = (await repo.createItem({ kind: "image", subjectType: "report", subjectId: reportId }))!

    const detail = await repo.getItem(id)
    expect(detail?.user?.handle).toBe("rmreporter")
    expect(detail?.user?.strikes).toBe(0)

    await repo.remove(id, { actorId: null, reason: "spam" })
    const [um] = await h.sql<{ strikes: number; removals: number }[]>`
      SELECT strikes, removals FROM user_moderation WHERE user_id = ${userId}
    `
    expect(um?.strikes).toBe(1)
    expect(um?.removals).toBe(1)
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
    const r3 = await insertReport(h, { status: "held" })
    await repo.createItem({ kind: "image", subjectType: "report", subjectId: r3 })
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
