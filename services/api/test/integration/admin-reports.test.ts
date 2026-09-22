
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "../../src/services/admin/admin-report-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

async function insertUser(
  h: PgHarness,
  opts: { name?: string; handle?: string; emailVerified?: boolean } = {},
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO users (display_name, handle, email, email_verified)
    VALUES (
      ${opts.name ?? "Test User"},
      ${opts.handle ?? testHandle()},
      ${opts.handle ? `${opts.handle}@example.com` : null},
      ${opts.emailVerified ?? false}
    )
    RETURNING id
  `
  return rows[0]!.id
}

async function insertReport(
  h: PgHarness,
  opts: {
    category?: string
    status?: string
    reporterId?: string | null
    title?: string
    addr?: string | null
    referenceCode?: string | null
  },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, title, status, h3_cell, jurisdiction_geoid, addr, reference_code)
    VALUES (
      ${opts.reporterId ?? null},
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category ?? "trash"},
      ${opts.title ?? "Test report"},
      ${opts.status ?? "submitted"},
      'h0',
      ${GEOID},
      ${opts.addr ?? null},
      ${opts.referenceCode ?? null}
    )
    RETURNING id
  `
  return rows[0]!.id
}

describe.skipIf(!pg)("admin report repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: AdminReportRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleAdminReportRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE report_timeline, abuse_flags, audit_log, jurisdiction_contacts, notifications RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM media_assets`
    await h.sql`DELETE FROM reports`
    await h.sql`DELETE FROM users`
    await h.sql`UPDATE jurisdictions SET contact_emails = NULL, report_form_url = NULL WHERE geoid = ${GEOID}`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("F114: setStatus('rejected') stamps deleted_at so the report leaves every admin read", async () => {
    const id = await insertReport(h, { status: "submitted" })
    const changed = await repo.setStatus(id, {
      status: "rejected",
      note: "Rejected by an operator",
      actorId: null,
    })
    expect(changed).toBe(true)

    const rows = await h.sql<{ status: string; deleted_at: Date | null }[]>`
      SELECT status, deleted_at FROM reports WHERE id = ${id}
    `
    expect(rows[0]?.status).toBe("rejected")
    expect(rows[0]?.deleted_at).toBeInstanceOf(Date)

    const listed = await repo.listReports({
      q: null,
      statuses: ["rejected"],
      flaggedOnly: false,
      needsVerificationOnly: false,
      cursor: null,
      limit: 25,
    })
    expect(listed.records.some((r) => r.id === id)).toBe(false)
    expect(await repo.getReport(id)).toBeNull()
  })

  it("lists a report with confirmations, hasPhoto, and the flagged facet", async () => {
    const reporter = await insertUser(h, { name: "Jane", handle: "jane", emailVerified: true })
    const id = await insertReport(h, { reporterId: reporter, title: "Overflowing bin" })
    await h.sql`
      INSERT INTO media_assets (report_id, upload_id, kind, r2_key, status)
      VALUES (${id}, gen_random_uuid(), 'image', 'k/photo.jpg', 'ready')
    `
    const { records } = await repo.listReports({
      q: null,
      statuses: null,
      flaggedOnly: false,
      needsVerificationOnly: false,
      cursor: null,
      limit: 25,
    })
    expect(records).toHaveLength(1)
    const r = records[0]!
    expect(r.confirmations).toBe(0)
    expect(r.hasPhoto).toBe(true)
    expect(r.flagged).toBe(false)
    expect(r.reporter?.emailVerified).toBe(true)

    await repo.toggleFlag(id, { reason: "x", actorId: null })
    const flagged = await repo.listReports({
      q: null,
      statuses: null,
      flaggedOnly: true,
      needsVerificationOnly: false,
      cursor: null,
      limit: 25,
    })
    expect(flagged.records.map((x) => x.id)).toEqual([id])
  })

  it("search matches a reference code exactly and an address substring", async () => {
    const withCode = await insertReport(h, {
      title: "Pothole",
      addr: "1200 S Figueroa St",
      referenceCode: "PD-42-000001",
    })
    await insertReport(h, { title: "Graffiti", addr: "44 Sunset Blvd", referenceCode: "GR-42-000007" })

    const list = async (q: string): Promise<string[]> =>
      (
        await repo.listReports({
          q,
          statuses: null,
          flaggedOnly: false,
          needsVerificationOnly: false,
          cursor: null,
          limit: 25,
        })
      ).records.map((r) => r.id)

    expect(await list("pd-42-000001")).toEqual([withCode])
    expect(await list("PD-42")).toEqual([])
    expect(await list("figueroa")).toEqual([withCode])
    expect((await repo.countByBucket({ q: "figueroa" })).all).toBe(1)

    await repo.toggleFlag(withCode, { reason: "x", actorId: null })
    expect((await repo.countByBucket({ q: "figueroa" })).flagged).toBe(1)
    expect((await repo.countByBucket({ q: "sunset" })).flagged).toBe(0)
  })

  it("getRouting resolves the per-category -> default -> legacy contact precedence", async () => {
    const id = await insertReport(h, { category: "hazard" })
    await h.sql`UPDATE jurisdictions SET contact_emails = ARRAY['311@lacity.gov'] WHERE geoid = ${GEOID}`
    expect((await repo.getRouting(id))?.contact).toBe("311@lacity.gov")
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES (${GEOID}, NULL, 'default@lacity.gov')`
    expect((await repo.getRouting(id))?.contact).toBe("default@lacity.gov")
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES (${GEOID}, 'hazard', 'hazard@lacity.gov')`
    const routing = await repo.getRouting(id)
    expect(routing?.contact).toBe("hazard@lacity.gov")
    expect(routing?.geoid).toBe(GEOID)
    expect(routing?.routed).toBe(true)
  })

  it("setStatus writes report_timeline + an audit row", async () => {
    const id = await insertReport(h, { status: "submitted" })
    const ok = await repo.setStatus(id, { status: "in_progress", note: "moving", actorId: null })
    expect(ok).toBe(true)
    const status = await h.sql<{ status: string }[]>`SELECT status FROM reports WHERE id = ${id}`
    expect(status[0]?.status).toBe("in_progress")
    const tl = await h.sql<
      { status: string }[]
    >`SELECT status FROM report_timeline WHERE report_id = ${id} ORDER BY created_at DESC LIMIT 1`
    expect(tl[0]?.status).toBe("in_progress")
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'report.status_changed'`
    expect(audit).toHaveLength(1)
  })

  it("toggleFlag opens then resolves an abuse_flag (+ timeline + audit)", async () => {
    const id = await insertReport(h, {})
    const on = await repo.toggleFlag(id, { reason: "spam", actorId: null })
    expect(on).toBe(true)
    const openFlags = await h.sql<{ id: string }[]>`
      SELECT id FROM abuse_flags WHERE subject_type = 'report' AND subject_id = ${id} AND resolved_at IS NULL
    `
    expect(openFlags).toHaveLength(1)
    const off = await repo.toggleFlag(id, { reason: null, actorId: null })
    expect(off).toBe(false)
    const stillOpen = await h.sql<{ id: string }[]>`
      SELECT id FROM abuse_flags WHERE subject_type = 'report' AND subject_id = ${id} AND resolved_at IS NULL
    `
    expect(stillOpen).toHaveLength(0)
  })

  it("remove soft-deletes -> rejected + timeline + audit", async () => {
    const id = await insertReport(h, { status: "submitted" })
    const ok = await repo.remove(id, { note: "spam", actorId: null })
    expect(ok).toBe(true)
    const row = await h.sql<{ status: string; deleted_at: Date | null }[]>`
      SELECT status, deleted_at FROM reports WHERE id = ${id}
    `
    expect(row[0]?.status).toBe("rejected")
    expect(row[0]?.deleted_at).not.toBeNull()
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'report.removed'`
    expect(audit).toHaveLength(1)
  })

  it("appendFollowup writes a 'followup' timeline row + audit", async () => {
    const reporter = await insertUser(h, { handle: "sam" })
    const id = await insertReport(h, { reporterId: reporter })
    await repo.appendFollowup(id, {
      note: "sent",
      actorId: null,
      to: "reporter",
      destination: reporter,
    })
    const audit = await h.sql<
      { action: string }[]
    >`SELECT action FROM audit_log WHERE action = 'report.followup_sent'`
    expect(audit).toHaveLength(1)
    const rows = await h.sql<{ kind: string | null }[]>`
      SELECT kind FROM report_timeline WHERE report_id = ${id} AND note = 'sent'
    `
    expect(rows.map((r) => r.kind)).toEqual(["followup"])
  })

  it("getOutreach derives sendFailed from the mail_events trail ('failed' recorded, no 'sent')", async () => {
    const id = await insertReport(h, {})
    await h.sql`DELETE FROM mail_events`
    await h.sql`DELETE FROM mail_threads WHERE report_id = ${id}`

    expect(await repo.getOutreach(id)).toMatchObject({ status: "not_sent", sendFailed: false })

    const threads = await h.sql<{ id: string }[]>`
      INSERT INTO mail_threads (thread_token, jurisdiction_geoid, subject, status, report_id)
      VALUES (${`report-${Math.random().toString(36).slice(2, 14)}`}, ${GEOID}, 'S', 'sent', ${id})
      RETURNING id
    `
    const threadId = threads[0]!.id
    const messages = await h.sql<{ id: string }[]>`
      INSERT INTO mail_messages (thread_id, direction, from_addr, to_addr, subject, body)
      VALUES (${threadId}, 'out', 'outreach@civfix.org', '311@lacity.gov', 'S', 'b')
      RETURNING id
    `
    const messageId = messages[0]!.id

    expect(await repo.getOutreach(id)).toMatchObject({
      status: "sent",
      threadId,
      routedTo: "311@lacity.gov",
      sendFailed: false,
    })

    await h.sql`
      INSERT INTO mail_events (thread_id, message_id, type) VALUES (${threadId}, ${messageId}, 'failed')
    `
    expect(await repo.getOutreach(id)).toMatchObject({ status: "sent", sendFailed: true })

    await h.sql`
      INSERT INTO mail_events (thread_id, message_id, type) VALUES (${threadId}, ${messageId}, 'sent')
    `
    expect(await repo.getOutreach(id)).toMatchObject({ status: "sent", sendFailed: false })

    await h.sql`UPDATE mail_threads SET status = 'bounced' WHERE id = ${threadId}`
    expect(await repo.getOutreach(id)).toMatchObject({ status: "bounced", sendFailed: false })

    await h.sql`DELETE FROM mail_events`
    await h.sql`DELETE FROM mail_threads WHERE id = ${threadId}`
  })

  it("F008: facet counts stay EXACT past the old saturation cap", async () => {
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, title, status, h3_cell, jurisdiction_geoid)
      SELECT gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash',
             'Bulk ' || g, 'submitted', 'h0', ${GEOID}
      FROM generate_series(1, 1050) AS g
    `
    await h.sql`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, title, status, h3_cell, jurisdiction_geoid)
      SELECT gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash',
             'Done ' || g, 'resolved', 'h0', ${GEOID}
      FROM generate_series(1, 7) AS g
    `

    const counts = await repo.countByBucket({ q: null })
    expect(counts.submitted).toBe(1050)
    expect(counts.completed).toBe(7)
    expect(counts.all).toBe(1057)

    const searched = await repo.countByBucket({ q: "Bulk" })
    expect(searched.submitted).toBe(1050)
    expect(searched.completed).toBe(0)
  })
})
