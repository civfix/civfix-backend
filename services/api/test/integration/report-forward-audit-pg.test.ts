// The table has no FK on message_id (chat_messages is range-partitioned), so a bare uuid suffices as the
// message id here.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeDrizzleReportForwardAuditRepository } from "../../src/services/report-forward-audit-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("report_message_forwards audit writes (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  const GEO = "0600001"

  async function forwardedAt(messageId: string, geoid: string): Promise<Date | null | undefined> {
    const rows = await h.sql<{ forwarded_at: Date | null }[]>`
      SELECT forwarded_at FROM report_message_forwards
      WHERE message_id = ${messageId} AND geoid = ${geoid}
    `
    return rows[0]?.forwarded_at
  }

  it("recordMention inserts a mentioned-but-not-forwarded row (forwarded_at NULL)", async () => {
    const audit = makeDrizzleReportForwardAuditRepository(h.sql)
    const msg = randomUUID()

    await audit.recordMention(msg, GEO)
    expect(await forwardedAt(msg, GEO)).toBeNull()
  })

  it("recordMention is idempotent and does not clobber an already-forwarded row", async () => {
    const audit = makeDrizzleReportForwardAuditRepository(h.sql)
    const msg = randomUUID()

    await audit.recordMention(msg, GEO)
    await audit.markForwarded(msg, GEO)
    const stamped = await forwardedAt(msg, GEO)
    expect(stamped).not.toBeNull()

    // A retry re-runs recordMention; the stamped time must survive unchanged.
    await audit.recordMention(msg, GEO)
    expect((await forwardedAt(msg, GEO))!.getTime()).toBe(stamped!.getTime())

    const rows = await h.sql`
      SELECT 1 FROM report_message_forwards WHERE message_id = ${msg} AND geoid = ${GEO}
    `
    expect(rows).toHaveLength(1)
  })

  it("markForwarded stamps forwarded_at and keeps the earliest time on a re-run", async () => {
    const audit = makeDrizzleReportForwardAuditRepository(h.sql)
    const msg = randomUUID()

    await audit.recordMention(msg, GEO)
    await audit.markForwarded(msg, GEO)
    const first = await forwardedAt(msg, GEO)
    expect(first).not.toBeNull()

    await audit.markForwarded(msg, GEO)
    expect((await forwardedAt(msg, GEO))!.getTime()).toBe(first!.getTime())
  })
})

describe.skipIf(!pg)(
  "report message mapper surfaces forwardedToCity + cityMention (integration)",
  () => {
    let h: PgHarness

    beforeAll(() => {
      h = pg as PgHarness
    })

    // Each case re-seeds a jurisdiction with the same @handle, so clear them (and the rows that FK to
    // them) between tests to avoid colliding on jurisdictions_handle_lower_key.
    beforeEach(async () => {
      await h.sql`TRUNCATE jurisdictions RESTART IDENTITY CASCADE`
    })

    const HANDLE = "sfaudit"

    async function seedJurisdiction(): Promise<string> {
      const geoid = `T${randomUUID().slice(0, 6)}`
      await h.sql`
      INSERT INTO jurisdictions (geoid, name, layer, priority, handle, geom)
      VALUES (${geoid}, 'City of San Francisco', 'place', 1, ${HANDLE},
              ST_SetSRID(ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)))'), 4326))
    `
      return geoid
    }

    async function newReport(geoid: string): Promise<string> {
      const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, visibility, h3_cell, jurisdiction_geoid)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(0.5, 0.5), 4326), 'manual', 'trash', 'dump', 'published', 'public', 'h0', ${geoid})
      RETURNING id
    `
      return r!.id
    }

    async function newUser(): Promise<string> {
      const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES ('Reporter') RETURNING id
    `
      return u!.id
    }

    it("reportHistory reports forwardedToCity:true + a forwarded cityMention once a matching forward is stamped", async () => {
      const chat = makeDrizzleChatRepository(h.sql)
      const audit = makeDrizzleReportForwardAuditRepository(h.sql)
      const geoid = await seedJurisdiction()
      const reportId = await newReport(geoid)
      const userId = await newUser()

      const msgId = randomUUID()
      const dto = await chat.insertMessage(
        { cleanupId: reportId, roomKind: "report", userId, body: `pls fix @${HANDLE}` },
        msgId,
      )
      // The async forward has not run yet, but the @city tint is already present.
      expect(dto.forwardedToCity).toBe(false)
      expect(dto.cityMention).toMatchObject({ handle: HANDLE, geoid, forwarded: false })

      await audit.recordMention(msgId, geoid)
      await audit.markForwarded(msgId, geoid)

      const page = await chat.reportHistory(reportId, undefined, 30, userId)
      const found = page.items.find((m) => m.id === msgId)
      expect(found, "message should appear in report history").toBeDefined()
      expect(found!.forwardedToCity).toBe(true)
      expect(found!.cityMention).toMatchObject({
        handle: HANDLE,
        geoid,
        name: "City of San Francisco",
        forwarded: true,
      })

      const single = await chat.findReportMessage(reportId, msgId, userId)
      expect(single!.forwardedToCity).toBe(true)
      expect(single!.cityMention?.forwarded).toBe(true)
    })

    it("a mentioned-but-not-forwarded audit row (forwarded_at NULL) keeps forwardedToCity false", async () => {
      const chat = makeDrizzleChatRepository(h.sql)
      const audit = makeDrizzleReportForwardAuditRepository(h.sql)
      const geoid = await seedJurisdiction()
      const reportId = await newReport(geoid)
      const userId = await newUser()

      const msgId = randomUUID()
      await chat.insertMessage(
        { cleanupId: reportId, roomKind: "report", userId, body: `@${HANDLE} help` },
        msgId,
      )
      await audit.recordMention(msgId, geoid)

      const single = await chat.findReportMessage(reportId, msgId, userId)
      expect(single!.forwardedToCity).toBe(false)
      expect(single!.cityMention).toMatchObject({ handle: HANDLE, forwarded: false })
    })

    it("a report message that does NOT @mention the city omits cityMention and is not forwarded", async () => {
      const chat = makeDrizzleChatRepository(h.sql)
      const geoid = await seedJurisdiction()
      const reportId = await newReport(geoid)
      const userId = await newUser()

      const msgId = randomUUID()
      await chat.insertMessage(
        { cleanupId: reportId, roomKind: "report", userId, body: "just a normal update" },
        msgId,
      )
      const single = await chat.findReportMessage(reportId, msgId, userId)
      expect(single!.forwardedToCity).toBe(false)
      expect(single!.cityMention).toBeNull()
    })
  },
)

// A per-block afterAll would stop the shared withPg() container before the second block runs, failing it
// with CONNECTION_ENDED.
afterAll(async () => {
  if (pg) await pg.teardown()
})
