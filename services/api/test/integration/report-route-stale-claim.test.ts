import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleAdminReportRepository,
  ROUTE_CLAIM_STALE_SECONDS,
  ROUTE_DEADLINE_INFLIGHT_SECONDS,
} from "../../src/services/admin/admin-report-repository.drizzle.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

describe.skipIf(!pg)("report outreach: stranded route claims are recoverable", () => {
  let h: PgHarness
  let reports: ReturnType<typeof makeDrizzleAdminReportRepository>
  let mail: ReturnType<typeof makeDrizzleMailRepository>

  beforeAll(() => {
    h = pg as PgHarness
    reports = makeDrizzleAdminReportRepository(h.sql)
    mail = makeDrizzleMailRepository(h.sql)
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads RESTART IDENTITY CASCADE`
    await h.sql`DELETE FROM reports WHERE idempotency_key LIKE 'stale-claim-%'`
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function seedReport(key: string): Promise<string> {
    const rows = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (${key}, ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'gps', 'graffiti',
              'published', '8a2a1072b59ffff', ${LA_CITY.geoid})
      RETURNING id
    `
    return rows[0]!.id
  }

  async function claimRoute(reportId: string): Promise<{ threadId: string; messageId: string }> {
    const thread = await mail.findOrCreateReportThread(reportId, {
      jurisdictionGeoid: LA_CITY.geoid,
      subject: "Pothole",
      status: "sent",
    })
    const message = await mail.insertMessage({
      threadId: thread.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "pw@lacity.gov",
      body: "packet",
    })
    return { threadId: thread.id, messageId: message!.id }
  }

  async function ageOutbound(threadId: string, seconds: number): Promise<void> {
    await h.sql`
      UPDATE mail_messages
      SET created_at = now() - make_interval(secs => ${seconds})
      WHERE thread_id = ${threadId} AND direction = 'out'
    `
  }

  it("a FRESH claim with no event yet is NOT reported as failed (a send may be in flight)", async () => {
    const reportId = await seedReport("stale-claim-fresh")
    await claimRoute(reportId)

    const outreach = await reports.getOutreach(reportId)
    expect(outreach.status).toBe("sent")
    expect(outreach.sendFailed).toBe(false)
  })

  it("a STRANDED claim (outbound row past the stale window, no event) is reported as failed", async () => {
    const reportId = await seedReport("stale-claim-stranded")
    const { threadId } = await claimRoute(reportId)
    await ageOutbound(threadId, ROUTE_CLAIM_STALE_SECONDS + 60)

    const outreach = await reports.getOutreach(reportId)
    expect(outreach.status).toBe("sent")
    expect(outreach.sendFailed).toBe(true)
    expect(outreach.routedTo).toBe("pw@lacity.gov")
  })

  it("an old but DELIVERED route is never reported as failed", async () => {
    const reportId = await seedReport("stale-claim-delivered")
    const { threadId, messageId } = await claimRoute(reportId)
    await ageOutbound(threadId, ROUTE_CLAIM_STALE_SECONDS + 60)
    await mail.recordEvent({ threadId, messageId, type: "sent" })

    expect((await reports.getOutreach(reportId)).sendFailed).toBe(false)
  })

  it("an explicit delivery failure is still reported as failed regardless of age", async () => {
    const reportId = await seedReport("stale-claim-failed")
    const { threadId, messageId } = await claimRoute(reportId)
    await mail.recordEvent({ threadId, messageId, type: "failed" })

    expect((await reports.getOutreach(reportId)).sendFailed).toBe(true)
  })

  it("a FRESH deadline failure is NOT reported as failed (the send may still be in flight)", async () => {
    const reportId = await seedReport("stale-claim-deadline-fresh")
    const { threadId, messageId } = await claimRoute(reportId)
    await mail.recordEvent({
      threadId,
      messageId,
      type: "failed",
      meta: { reason: "deadline", deadlineMs: 30000 },
    })

    const outreach = await reports.getOutreach(reportId)
    expect(outreach.sendFailed).toBe(false)
    expect(outreach.sendInFlight).toBe(true)
  })

  it("a deadline failure past the in-flight window IS reported as failed (recovery)", async () => {
    const reportId = await seedReport("stale-claim-deadline-old")
    const { threadId, messageId } = await claimRoute(reportId)
    await mail.recordEvent({ threadId, messageId, type: "failed", meta: { reason: "deadline" } })
    await h.sql`
      UPDATE mail_events
      SET created_at = now() - make_interval(secs => ${ROUTE_DEADLINE_INFLIGHT_SECONDS + 60})
      WHERE thread_id = ${threadId} AND type = 'failed'
    `

    expect((await reports.getOutreach(reportId)).sendFailed).toBe(true)
  })

  it("B1: an older hard failure does not defeat a FRESH deadline on a newer attempt", async () => {
    const reportId = await seedReport("stale-claim-composition")
    const thread = await mail.findOrCreateReportThread(reportId, {
      jurisdictionGeoid: LA_CITY.geoid,
      subject: "Pothole",
      status: "sent",
    })

    const first = await mail.insertMessage({
      threadId: thread.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "pw@lacity.gov",
      body: "attempt 1",
    })
    await mail.recordEvent({
      threadId: thread.id,
      messageId: first!.id,
      type: "failed",
      meta: { error: "connect ETIMEDOUT" },
    })

    expect((await reports.getOutreach(reportId)).sendFailed).toBe(true)

    const second = await mail.insertMessage({
      threadId: thread.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "pw@lacity.gov",
      body: "attempt 2",
    })
    await mail.recordEvent({
      threadId: thread.id,
      messageId: second!.id,
      type: "failed",
      meta: { reason: "deadline", deadlineMs: 87667 },
    })

    const outreach = await reports.getOutreach(reportId)
    expect(outreach.sendFailed).toBe(false)
    expect(outreach.sendInFlight).toBe(true)
  })

  it("B1: a hard failure on the NEWEST attempt is reported as failed even after an in-flight one", async () => {
    const reportId = await seedReport("stale-claim-newest-hard")
    const thread = await mail.findOrCreateReportThread(reportId, {
      jurisdictionGeoid: LA_CITY.geoid,
      subject: "Pothole",
      status: "sent",
    })
    const first = await mail.insertMessage({
      threadId: thread.id,
      direction: "out",
      toAddr: "pw@lacity.gov",
      body: "attempt 1",
    })
    await mail.recordEvent({
      threadId: thread.id,
      messageId: first!.id,
      type: "failed",
      meta: { reason: "deadline" },
    })
    const second = await mail.insertMessage({
      threadId: thread.id,
      direction: "out",
      toAddr: "pw@lacity.gov",
      body: "attempt 2",
    })
    await mail.recordEvent({
      threadId: thread.id,
      messageId: second!.id,
      type: "failed",
      meta: { error: "550 rejected" },
    })

    const outreach = await reports.getOutreach(reportId)
    expect(outreach.sendFailed).toBe(true)
    expect(outreach.sendInFlight).toBe(false)
  })

  it("B2: advanceStatusIfIn only moves a report still in a routable status", async () => {
    const routable = await seedReport("guarded-advance-routable")
    expect(
      await reports.advanceStatusIfIn(routable, {
        from: ["submitted", "held", "published"],
        to: "acknowledged",
        note: "Sent to jurisdiction (pw@lacity.gov)",
        actorId: null,
        kind: "route",
      }),
    ).toBe(true)
    expect((await reports.getReport(routable))?.status).toBe("acknowledged")

    const moved = await seedReport("guarded-advance-moved")
    await reports.setStatus(moved, { status: "resolved", note: "operator closed it", actorId: null })
    expect(
      await reports.advanceStatusIfIn(moved, {
        from: ["submitted", "held", "published"],
        to: "acknowledged",
        note: "Sent to jurisdiction (pw@lacity.gov)",
        actorId: null,
        kind: "route",
      }),
    ).toBe(false)
    expect((await reports.getReport(moved))?.status).toBe("resolved")
    const rows = await reports.listTimeline(moved)
    expect(rows.filter((r) => r.status === "acknowledged")).toHaveLength(0)
  })

  it("a LATE 'sent' after a deadline failure clears sendFailed immediately", async () => {
    const reportId = await seedReport("stale-claim-deadline-late")
    const { threadId, messageId } = await claimRoute(reportId)
    await mail.recordEvent({ threadId, messageId, type: "failed", meta: { reason: "deadline" } })
    await mail.recordEvent({ threadId, messageId, type: "sent", meta: { late: true } })

    expect((await reports.getOutreach(reportId)).sendFailed).toBe(false)
  })
})
