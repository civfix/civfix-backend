/**
 * Mail data-layer integration test (Docker-gated). Exercises the REAL Drizzle/raw-SQL MailRepository
 * (makeDrizzleMailRepository) against a live Postgres container via withPg, which applies the canonical
 * 0007_admin_phase2.sql migration (creating mail_threads/mail_messages/mail_events/outreach_state).
 *
 * Proven here against the real schema + constraints:
 *   - upsertThreadByToken is find-or-create on the UNIQUE thread_token;
 *   - insertMessage writes the jsonb `attachments`, bumps the thread's last_message_at, and (inbound)
 *     sets unread=true, all in one transaction;
 *   - getThread returns the thread + ordered messages mapped to the DTO;
 *   - listThreads pages newest-first with the keyset cursor and applies the dir/attn/geoid/q filters;
 *   - stats7d aggregates the mail_events window into the MailStatsResponse shape;
 *   - getOutreachState / setOutreachState upsert the per-jurisdiction throttle row (FK to jurisdictions).
 *
 * When Docker is unavailable the whole describe block SKIPS (describe.skipIf), so the local suite stays
 * green; CI runs it for real. Reuses withPg() per the harness contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleMailRepository,
  type MailRepository,
} from "../../src/services/admin/mail-repository.drizzle.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

// A seeded jurisdiction geoid is required for the outreach_state FK + the thread geoid column.
const GEOID = LA_CITY.geoid

describe.skipIf(!pg)("admin mail repository (integration: real schema)", () => {
  // Bind the harness + repo inside beforeAll (NOT the describe body), so that when Docker is unavailable
  // and the suite is skipped, we never dereference the null harness at collection time.
  let h: PgHarness
  let repo: MailRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleMailRepository(h.sql)
  })

  beforeEach(async () => {
    // Each test starts from an empty mail surface (truncate the four tables; CASCADE handles FKs).
    await h.sql`TRUNCATE mail_events, mail_messages, mail_threads, outreach_state RESTART IDENTITY CASCADE`
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("upserts a thread by token (find-or-create)", async () => {
    const first = await repo.upsertThreadByToken("geo-test-1", {
      jurisdictionGeoid: GEOID,
      org: "City of LA",
      subject: "Outreach",
    })
    const second = await repo.upsertThreadByToken("geo-test-1", { org: "ignored" })
    expect(second.id).toBe(first.id)
    expect(second.org).toBe("City of LA")
  })

  it("inserts a message with attachments, bumps last_message_at, sets inbound unread", async () => {
    const t = await repo.createThread({ subject: "S" })
    expect(t.lastMessageAt).toBeNull()
    const out = await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "clerk@city.gov",
      body: "Hello",
      attachments: [{ key: "r2/a.pdf", filename: "a.pdf", size: 123 }],
    })
    const afterOut = await repo.getThreadRecord(t.id)
    expect(afterOut?.lastMessageAt?.getTime()).toBe(out.createdAt.getTime())
    expect(afterOut?.unread).toBe(false)

    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "Re",
    })
    const afterIn = await repo.getThreadRecord(t.id)
    expect(afterIn?.unread).toBe(true)

    const dto = await repo.getThread(t.id)
    expect(dto?.messages).toHaveLength(2)
    expect(dto?.messages[0]?.attachments).toEqual([
      { key: "r2/a.pdf", filename: "a.pdf", size: 123 },
    ])
    expect(dto?.messages.map((m) => m.body)).toEqual(["Hello", "Re"])
    expect(dto?.dir).toBe("in")
  })

  it("lists threads newest-first with a working keyset cursor + dir/geoid/q filters", async () => {
    const a = await repo.createThread({
      subject: "Pothole",
      org: "City of LA",
      jurisdictionGeoid: GEOID,
    })
    await repo.insertMessage({
      threadId: a.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      body: "p",
    })
    const b = await repo.createThread({
      subject: "Graffiti",
      org: "City of LA",
      jurisdictionGeoid: GEOID,
    })
    await repo.insertMessage({
      threadId: b.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      body: "g",
    })
    const c = await repo.createThread({ subject: "Hazard" })
    await repo.insertMessage({
      threadId: c.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      body: "h",
    })

    const page1 = await repo.listThreads({ limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.id).toBe(c.id) // newest message
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await repo.listThreads({ limit: 2, cursor: page1.nextCursor })
    expect(page2.items.map((t) => t.id)).toEqual([a.id])
    expect(page2.nextCursor).toBeNull()

    const inbound = await repo.listThreads({ dir: "in", limit: 10 })
    expect(inbound.items.map((t) => t.id)).toEqual([b.id])
    const byGeo = await repo.listThreads({ jurisdictionGeoid: GEOID, limit: 10 })
    expect(new Set(byGeo.items.map((t) => t.id))).toEqual(new Set([a.id, b.id]))
    const byQ = await repo.listThreads({ q: "graffiti", limit: 10 })
    expect(byQ.items.map((t) => t.id)).toEqual([b.id])
  })

  it("marks read, sets status, and records events that feed stats7d", async () => {
    const t = await repo.createThread({ subject: "S", unread: true })
    expect(await repo.markThreadRead(t.id)).toBe(true)
    expect((await repo.getThreadRecord(t.id))?.unread).toBe(false)
    expect(await repo.setThreadStatus(t.id, "replied")).toBe(true)
    expect((await repo.getThreadRecord(t.id))?.status).toBe("replied")

    await repo.recordEvent({ threadId: t.id, type: "sent" })
    await repo.recordEvent({ threadId: t.id, type: "sent" })
    await repo.recordEvent({ threadId: t.id, type: "delivered" })
    await repo.recordEvent({ threadId: t.id, type: "bounced" })
    const stats = await repo.stats7d()
    expect(stats.delivered7d).toBe(1)
    expect(stats.bounceRate).toBeCloseTo(0.5, 6)
    expect(stats.threads).toBe(1)
    expect(stats.domainHealth).toHaveLength(3)
  })

  it("upserts outreach_state for a seeded jurisdiction", async () => {
    expect(await repo.getOutreachState(GEOID)).toBeNull()
    const at = new Date("2026-03-01T00:00:00.000Z")
    const set1 = await repo.setOutreachState(GEOID, { lastOutreachAt: at })
    expect(set1.lastOutreachAt?.getTime()).toBe(at.getTime())
    expect(set1.suppressed).toBe(false)
    const set2 = await repo.setOutreachState(GEOID, { suppressed: true })
    expect(set2.suppressed).toBe(true)
    expect(set2.lastOutreachAt?.getTime()).toBe(at.getTime())
  })
})
