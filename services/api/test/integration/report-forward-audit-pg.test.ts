/**
 * Task D-C4: @city forward audit table (Docker-gated). Boots a live PostGIS container (via withPg) and
 * exercises the DB-backed report_message_forwards INSERT/UPDATE the offline suite covers only through the
 * spy-audit orchestration test (test/unit/report-forward-audit.test.ts):
 *
 *   - recordMention inserts a (message_id, geoid) row with forwarded_at NULL;
 *   - recordMention is idempotent (ON CONFLICT DO NOTHING) and never clobbers an already-stamped row;
 *   - markForwarded stamps forwarded_at = now(), and keeps the earliest time on an idempotent re-run.
 *
 * The table has no FK on message_id (chat_messages is range-partitioned), so a bare uuid suffices as the
 * message id here. When Docker is unavailable the whole block SKIPS so the local suite stays green.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeReportForwardAudit } from "../../src/services/report-forward-audit.drizzle.js"
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
    const audit = makeReportForwardAudit(h.sql)
    const msg = randomUUID()

    await audit.recordMention(msg, GEO)
    expect(await forwardedAt(msg, GEO)).toBeNull()
  })

  it("recordMention is idempotent and does not clobber an already-forwarded row", async () => {
    const audit = makeReportForwardAudit(h.sql)
    const msg = randomUUID()

    await audit.recordMention(msg, GEO)
    await audit.markForwarded(msg, GEO)
    const stamped = await forwardedAt(msg, GEO)
    expect(stamped).not.toBeNull()

    // A retry re-runs recordMention (ON CONFLICT DO NOTHING); the stamped time must survive unchanged.
    await audit.recordMention(msg, GEO)
    expect((await forwardedAt(msg, GEO))!.getTime()).toBe(stamped!.getTime())

    // Exactly one row for the pair (composite PK).
    const rows = await h.sql`
      SELECT 1 FROM report_message_forwards WHERE message_id = ${msg} AND geoid = ${GEO}
    `
    expect(rows).toHaveLength(1)
  })

  it("markForwarded stamps forwarded_at and keeps the earliest time on a re-run", async () => {
    const audit = makeReportForwardAudit(h.sql)
    const msg = randomUUID()

    await audit.recordMention(msg, GEO)
    await audit.markForwarded(msg, GEO)
    const first = await forwardedAt(msg, GEO)
    expect(first).not.toBeNull()

    // A second markForwarded (retry) must not advance the timestamp (COALESCE keeps the first).
    await audit.markForwarded(msg, GEO)
    expect((await forwardedAt(msg, GEO))!.getTime()).toBe(first!.getTime())
  })
})

/**
 * D-C4 follow-up: the report message MAPPER surfaces forwardedToCity (+ cityMention) by LEFT-joining
 * report_message_forwards and resolving the report's jurisdiction. This block drives the real SQL through
 * makeDrizzleChatRepository.reportHistory / findReportMessage against a live DB.
 */
describe.skipIf(!pg)(
  "report message mapper surfaces forwardedToCity + cityMention (integration)",
  () => {
    let h: PgHarness

    beforeAll(() => {
      h = pg as PgHarness
    })

    // Each case re-seeds a jurisdiction with the SAME @handle, so clear jurisdictions (and the reports /
    // messages that FK to them) between tests to avoid colliding on jurisdictions_handle_lower_key.
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
      const audit = makeReportForwardAudit(h.sql)
      const geoid = await seedJurisdiction()
      const reportId = await newReport(geoid)
      const userId = await newUser()

      // A report user message that @mentions the jurisdiction handle.
      const msgId = randomUUID()
      const dto = await chat.insertMessage(
        { cleanupId: reportId, roomKind: "report", userId, body: `pls fix @${HANDLE}` },
        msgId,
      )
      // At insert time the async forward has not run: pill false, but the @city tint (cityMention) is present.
      expect(dto.forwardedToCity).toBe(false)
      expect(dto.cityMention).toMatchObject({ handle: HANDLE, geoid, forwarded: false })

      // The forward audit lands (recordMention + markForwarded), as the async onReportMessage path would do.
      await audit.recordMention(msgId, geoid)
      await audit.markForwarded(msgId, geoid)

      // A fresh history read now reflects the stamped forward.
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

      // findReportMessage maps the same surfacing.
      const single = await chat.findReportMessage(reportId, msgId, userId)
      expect(single!.forwardedToCity).toBe(true)
      expect(single!.cityMention?.forwarded).toBe(true)
    })

    it("a mentioned-but-not-forwarded audit row (forwarded_at NULL) keeps forwardedToCity false", async () => {
      const chat = makeDrizzleChatRepository(h.sql)
      const audit = makeReportForwardAudit(h.sql)
      const geoid = await seedJurisdiction()
      const reportId = await newReport(geoid)
      const userId = await newUser()

      const msgId = randomUUID()
      await chat.insertMessage(
        { cleanupId: reportId, roomKind: "report", userId, body: `@${HANDLE} help` },
        msgId,
      )
      // Only the NULL-forwarded row exists (no city contact case).
      await audit.recordMention(msgId, geoid)

      const single = await chat.findReportMessage(reportId, msgId, userId)
      expect(single!.forwardedToCity).toBe(false)
      // Still tinted (@mention present), just not forwarded.
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

// Tear down the shared, memoized withPg() harness only AFTER BOTH describe blocks above have run.
// A per-block afterAll would stop the container (and close h.sql) before the second block executes,
// so its tests would fail with CONNECTION_ENDED (see schema.test.ts for the same rule).
afterAll(async () => {
  if (pg) await pg.teardown()
})
