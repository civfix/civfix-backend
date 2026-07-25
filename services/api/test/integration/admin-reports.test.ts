/**
 * Admin reports data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL
 * AdminReportRepository (makeDrizzleAdminReportRepository) against a live Postgres/PostGIS container via
 * withPg, which applies the canonical migrations + the jurisdiction seed (so reports / report_timeline /
 * media_assets / abuse_flags / jurisdiction_contacts / notifications / audit_log all exist with their
 * real constraints).
 *
 * Proven here against the real schema:
 *   - listReports computes flagged (open abuse_flag), confirmations (deprecated, always 0 since
 *     report_follows was dropped), hasPhoto (media_assets), and the status/flagged facet;
 *   - getReport + getRouting resolve the per-category -> default -> legacy contact precedence;
 *   - setStatus writes report_timeline + an audit_log row;
 *   - toggleFlag opens/resolves an abuse_flag + a timeline row + audit;
 *   - remove sets status rejected (soft-delete) + a timeline row + audit;
 *   - notifyReporter inserts a notifications row; appendFollowup writes a timeline row + a
 *     report.followup_sent audit.
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import type { AdminReportRepository } from "../../src/services/admin/admin-report-service.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()
const GEOID = LA_CITY.geoid

/** Insert a user and return its id. */
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

/** Insert a report in the seeded jurisdiction and return its id. */
async function insertReport(
  h: PgHarness,
  opts: { category?: string; status?: string; reporterId?: string | null; title?: string },
): Promise<string> {
  const rows = await h.sql<{ id: string }[]>`
    INSERT INTO reports (reporter_user_id, idempotency_key, geom, geom_source, category, title, status, h3_cell, jurisdiction_geoid)
    VALUES (
      ${opts.reporterId ?? null},
      gen_random_uuid(),
      ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
      'manual',
      ${opts.category ?? "trash"},
      ${opts.title ?? "Test report"},
      ${opts.status ?? "submitted"},
      'h0',
      ${GEOID}
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

  it("lists a report with confirmations, hasPhoto, and the flagged facet", async () => {
    const reporter = await insertUser(h, { name: "Jane", handle: "jane", emailVerified: true })
    const id = await insertReport(h, { reporterId: reporter, title: "Overflowing bin" })
    // A photo.
    await h.sql`
      INSERT INTO media_assets (report_id, upload_id, kind, r2_key, status)
      VALUES (${id}, gen_random_uuid(), 'image', 'k/photo.jpg', 'ready')
    `
    const { records } = await repo.listReports({
      q: null,
      statuses: null,
      flaggedOnly: false,
      cursor: null,
      limit: 25,
    })
    expect(records).toHaveLength(1)
    const r = records[0]!
    // `confirmations` was the report_follows count; that table was dropped with the discussion system, so
    // the field is a deprecated always-0 value now.
    expect(r.confirmations).toBe(0)
    expect(r.hasPhoto).toBe(true)
    expect(r.flagged).toBe(false)
    expect(r.reporter?.emailVerified).toBe(true)

    // Flag it, then the flagged facet returns it.
    await repo.toggleFlag(id, { reason: "x", actorId: null })
    const flagged = await repo.listReports({
      q: null,
      statuses: null,
      flaggedOnly: true,
      cursor: null,
      limit: 25,
    })
    expect(flagged.records.map((x) => x.id)).toEqual([id])
  })

  it("getRouting resolves the per-category -> default -> legacy contact precedence", async () => {
    const id = await insertReport(h, { category: "hazard" })
    // Legacy only first.
    await h.sql`UPDATE jurisdictions SET contact_emails = ARRAY['311@lacity.gov'] WHERE geoid = ${GEOID}`
    expect((await repo.getRouting(id))?.contact).toBe("311@lacity.gov")
    // A default row beats legacy.
    await h.sql`INSERT INTO jurisdiction_contacts (geoid, category, email) VALUES (${GEOID}, NULL, 'default@lacity.gov')`
    expect((await repo.getRouting(id))?.contact).toBe("default@lacity.gov")
    // A category-specific row beats the default.
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

  it("notifyReporter inserts a notification; appendFollowup writes a timeline row + audit", async () => {
    const reporter = await insertUser(h, { handle: "sam" })
    const id = await insertReport(h, { reporterId: reporter })
    await repo.notifyReporter({
      reportId: id,
      reporterUserId: reporter,
      title: "Update",
      body: "thanks",
      link: `/reports/${id}`,
    })
    const notes = await h.sql<{ type: string; body: string | null }[]>`
      SELECT type, body FROM notifications WHERE user_id = ${reporter}
    `
    expect(notes[0]?.type).toBe("report_update")
    expect(notes[0]?.body).toBe("thanks")

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
  })

  /**
   * getOutreach's `sendFailed` is the signal the route endpoint's re-send gate needs and the ONLY thing
   * that separates "the packet went out" from "every attempt threw": the per-report thread row is created
   * with status 'sent' BEFORE the mailer is called, so the thread status alone reports a lost send as a real
   * one and the gate would 409 the operator's retry forever. It is derived here against the real schema
   * (mail_events.type 'failed' exists since 0029) because the SQL is where it can silently drift.
   */
  it("getOutreach derives sendFailed from the mail_events trail ('failed' recorded, no 'sent')", async () => {
    const id = await insertReport(h, {})
    await h.sql`DELETE FROM mail_events`
    await h.sql`DELETE FROM mail_threads WHERE report_id = ${id}`

    // No thread at all -> not_sent, and never "failed".
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

    // A thread + OUT message with NO delivery event yet: the send is in flight, not known-failed.
    expect(await repo.getOutreach(id)).toMatchObject({
      status: "sent",
      threadId,
      routedTo: "311@lacity.gov",
      sendFailed: false,
    })

    // The mailer threw: deliverAndRecord records 'failed' and never 'sent'.
    await h.sql`
      INSERT INTO mail_events (thread_id, message_id, type) VALUES (${threadId}, ${messageId}, 'failed')
    `
    expect(await repo.getOutreach(id)).toMatchObject({ status: "sent", sendFailed: true })

    // A later attempt delivered: one 'sent' event anywhere on the thread means the packet reached the city,
    // so the gate closes again even though the old 'failed' row is still there.
    await h.sql`
      INSERT INTO mail_events (thread_id, message_id, type) VALUES (${threadId}, ${messageId}, 'sent')
    `
    expect(await repo.getOutreach(id)).toMatchObject({ status: "sent", sendFailed: false })

    // A hard bounce is reported as `bounced` (the gate's other recovery arm) and is NOT a send failure.
    await h.sql`UPDATE mail_threads SET status = 'bounced' WHERE id = ${threadId}`
    expect(await repo.getOutreach(id)).toMatchObject({ status: "bounced", sendFailed: false })

    await h.sql`DELETE FROM mail_events`
    await h.sql`DELETE FROM mail_threads WHERE id = ${threadId}`
  })
})
