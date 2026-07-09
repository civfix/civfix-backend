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

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeReportForwardAudit } from "../../src/services/report-forward-audit.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("report_message_forwards audit writes (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
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
