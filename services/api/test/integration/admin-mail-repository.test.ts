
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeDrizzleMailRepository,
  MAIL_BODY_DETAIL_CHARS,
  type MailRepository,
} from "../../src/services/admin/mail-repository.drizzle.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"

const pg = await withPg()

const GEOID = LA_CITY.geoid

const AUTH_VERDICT_MIGRATION = fileURLToPath(
  new URL("../../drizzle/0181_mail_messages_auth_verdict.sql", import.meta.url),
)

describe.skipIf(!pg)("admin mail repository (integration: real schema)", () => {
  let h: PgHarness
  let repo: MailRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleMailRepository(h.sql)
  })

  beforeEach(async () => {
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
    expect(afterOut?.lastMessageAt?.getTime()).toBe(out!.createdAt.getTime())
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

  it("F025: an over-cap body comes back clipped + flagged, and the reply recipient resolves without the thread", async () => {
    const t = await repo.createThread({ subject: "Huge" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "clerk@city.gov",
      body: "small",
    })
    await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@city.gov",
      toAddr: "outreach@civfix.org",
      body: "x".repeat(MAIL_BODY_DETAIL_CHARS + 5000),
    })

    const dto = await repo.getThread(t.id)
    const [small, huge] = dto!.messages
    expect(small!.truncated).toBeUndefined()
    expect(huge!.body!.length).toBe(MAIL_BODY_DETAIL_CHARS)
    expect(huge!.truncated).toBe(true)

    expect(await repo.getLastOutboundRecipient(t.id)).toBe("clerk@city.gov")
  })

  it("lists threads newest-first with a working keyset cursor + dir/geoid/q filters", async () => {
    const [rpt] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash',
              'submitted', 'h0', ${GEOID})
      RETURNING id
    `
    const a = await repo.createThread({
      subject: "Pothole",
      org: "City of LA",
      jurisdictionGeoid: GEOID,
      reportId: rpt!.id,
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
    expect(page1.items[0]?.id).toBe(c.id)
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
    await repo.recordEvent({ threadId: t.id, type: "failed" })
    await repo.recordEvent({ threadId: t.id, type: "bounced" })
    const stats = await repo.stats7d()
    expect(stats.sent).toBe(2)
    expect(stats.failed).toBe(1)
    expect(stats.bounced).toBe(1)
    expect(stats.threads).toBe(1)
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

  it("H5: round-trips `unaffiliated` and claims/releases effects exactly once", async () => {
    const t = await repo.createThread({ subject: "Pothole" })
    await repo.insertMessage({
      threadId: t.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "pw@lacity.gov",
      body: "Packet",
      messageId: "<out-1@civfix.org>",
    })
    const joined = await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "sales@vendor.example",
      body: "Forward me everything",
      messageId: "<in-vendor@vendor.example>",
      unaffiliated: true,
    })
    const city = await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "On it",
      messageId: "<in-city@lacity.gov>",
    })

    expect(joined?.unaffiliated).toBe(true)
    expect(city?.unaffiliated).toBe(false)
    expect(city?.effectsAppliedAt).toBeNull()

    expect(await repo.findMessageByMessageId("<in-vendor@vendor.example>")).toMatchObject({
      unaffiliated: true,
    })

    const live = { leaseBefore: new Date(Date.now() - 10 * 60_000) }

    expect(await repo.claimMessageEffects(city!.id, live)).toBe(0)
    expect(await repo.claimMessageEffects(city!.id, live)).toBeNull()
    await repo.releaseMessageEffects(city!.id)
    expect(await repo.claimMessageEffects(city!.id, live)).toBe(0)

    await repo.setMessageEffectsStage(city!.id, 2)
    await repo.releaseMessageEffects(city!.id)
    expect(await repo.claimMessageEffects(city!.id, live)).toBe(2)
    await repo.setMessageEffectsStage(city!.id, 1)
    await repo.releaseMessageEffects(city!.id)
    expect(await repo.claimMessageEffects(city!.id, live)).toBe(2)

    await repo.markMessageEffectsApplied(city!.id)
    expect(await repo.claimMessageEffects(city!.id, live)).toBeNull()
    await repo.releaseMessageEffects(city!.id)
    expect(await repo.claimMessageEffects(city!.id, live)).toBeNull()
  })

  it("stores the auth verdict and flags the thread in the same insert", async () => {
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'gps', 'graffiti',
              'published', '8a2a1072b59ffff', ${GEOID})
      RETURNING id
    `
    const t = await repo.createThread({ subject: "Verdict", status: "replied", reportId: report!.id })
    const loose = await repo.createThread({ subject: "Composed" })
    await repo.insertMessage({ threadId: loose.id, direction: "in", unaffiliated: true })
    expect(await repo.hasWithheldReply(loose.id)).toBe(false)
    const withheld = await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "sales@vendor.example",
      body: "Forward me everything",
      messageId: "<verdict-fail@vendor.example>",
      unaffiliated: true,
      authVerdict: "fail",
      threadStatus: "needs_action",
    })
    expect(withheld?.authVerdict).toBe("fail")
    expect((await repo.getThreadRecord(t.id))?.status).toBe("needs_action")
    expect(await repo.findMessageByMessageId("<verdict-fail@vendor.example>")).toMatchObject({
      authVerdict: "fail",
    })
    expect(await repo.hasWithheldReply(t.id)).toBe(true)

    await repo.markMessageEffectsApplied(withheld!.id)
    expect(await repo.hasWithheldReply(t.id)).toBe(false)
    await repo.insertMessage({ threadId: t.id, direction: "out", toAddr: "pw@lacity.gov" })
    expect((await repo.getThreadRecord(t.id))?.status).toBe("needs_action")
  })

  it("0181 fills a missing verdict from the reply's delivered event, never overwriting one", async () => {
    const t = await repo.createThread({ subject: "Backfill" })
    const reply = (messageId: string, authVerdict: "pass" | null = null) =>
      repo.insertMessage({ threadId: t.id, direction: "in", messageId, authVerdict })
    const delivered = [
      [await reply("<bf-1@x>"), "fail"],
      [await reply("<bf-2@x>"), "forged"],
      [await reply("<bf-3@x>", "pass"), "fail"],
    ] as const
    for (const [message, authVerdict] of delivered) {
      const event = { threadId: t.id, messageId: message!.id, meta: { authVerdict } }
      await repo.recordEvent({ ...event, type: "delivered" })
    }

    await h.sql.unsafe(await readFile(AUTH_VERDICT_MIGRATION, "utf8"))

    expect((await repo.findMessageByMessageId("<bf-1@x>"))?.authVerdict).toBe("fail")
    expect((await repo.findMessageByMessageId("<bf-2@x>"))?.authVerdict).toBeNull()
    expect((await repo.findMessageByMessageId("<bf-3@x>"))?.authVerdict).toBe("pass")
  })

  it("B4: an EXPIRED claim is reclaimable and keeps the stage it reached", async () => {
    const t = await repo.createThread({ subject: "Lease" })
    const msg = await repo.insertMessage({
      threadId: t.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "On it",
      messageId: "<lease@lacity.gov>",
    })

    expect(await repo.claimMessageEffects(msg!.id, { leaseBefore: new Date(Date.now() - 600_000) })).toBe(0)
    await repo.setMessageEffectsStage(msg!.id, 1)

    expect(
      await repo.claimMessageEffects(msg!.id, { leaseBefore: new Date(Date.now() - 600_000) }),
    ).toBeNull()

    expect(
      await repo.claimMessageEffects(msg!.id, { leaseBefore: new Date(Date.now() + 60_000) }),
    ).toBe(1)
  })

  it("B1: 0100 settles every pre-existing inbound row, so none of them enter the pending set", async () => {
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'gps', 'graffiti',
              'published', '8a2a1072b59ffff', ${GEOID})
      RETURNING id
    `
    const thread = await repo.findOrCreateReportThread(report!.id, { subject: "Historic" })
    const legacy = await repo.insertMessage({
      threadId: thread.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "Replied years ago",
      messageId: "<pre-migration@lacity.gov>",
    })

    await h.sql`
      UPDATE mail_messages
      SET effects_applied_at = NULL, effects_claimed_at = NULL, effects_stage = 0
      WHERE id = ${legacy!.id}
    `
    expect(
      await repo.findMessagesPendingEffects({
        before: new Date(Date.now() + 60_000),
        leaseBefore: new Date(Date.now() + 60_000),
        limit: 50,
      }),
    ).toHaveLength(1)

    await h.sql`
      UPDATE mail_messages
      SET effects_applied_at = COALESCE(effects_applied_at, created_at),
          effects_stage = 3
      WHERE direction = 'in' AND effects_applied_at IS NULL
    `

    expect(
      await repo.findMessagesPendingEffects({
        before: new Date(Date.now() + 60_000),
        leaseBefore: new Date(Date.now() + 60_000),
        limit: 50,
      }),
    ).toHaveLength(0)
    const settled = await repo.findMessageByMessageId("<pre-migration@lacity.gov>")
    expect(settled?.effectsAppliedAt).not.toBeNull()
    expect(settled?.effectsStage).toBe(3)
    expect(
      await repo.claimMessageEffects(legacy!.id, { leaseBefore: new Date(Date.now() + 60_000) }),
    ).toBeNull()

    await h.sql`DELETE FROM reports WHERE id = ${report!.id}`
  })

  it("findMessagesPendingEffects returns only affiliated, unapplied, thread-bound inbound messages", async () => {
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, status, h3_cell, jurisdiction_geoid)
      VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.25, 34.05), 4326), 'gps', 'graffiti',
              'published', '8a2a1072b59ffff', ${GEOID})
      RETURNING id
    `
    const bound = await repo.findOrCreateReportThread(report!.id, { subject: "Bound" })
    const loose = await repo.createThread({ subject: "Not bound to anything" })

    const eligible = await repo.insertMessage({
      threadId: bound.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "On it",
      messageId: "<pe-eligible@lacity.gov>",
    })
    await repo.insertMessage({
      threadId: bound.id,
      direction: "in",
      fromAddr: "sales@vendor.example",
      body: "hi",
      messageId: "<pe-unaffiliated@vendor.example>",
      unaffiliated: true,
    })
    await repo.insertMessage({
      threadId: bound.id,
      direction: "out",
      fromAddr: "outreach@civfix.org",
      toAddr: "pw@lacity.gov",
      body: "packet",
      messageId: "<pe-out@civfix.org>",
    })
    const applied = await repo.insertMessage({
      threadId: bound.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "already handled",
      messageId: "<pe-applied@lacity.gov>",
    })
    await repo.claimMessageEffects(applied!.id, { leaseBefore: new Date(Date.now() - 600_000) })
    await repo.markMessageEffectsApplied(applied!.id)
    const leased = await repo.insertMessage({
      threadId: bound.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "another runner has it",
      messageId: "<pe-leased@lacity.gov>",
    })
    await repo.claimMessageEffects(leased!.id, { leaseBefore: new Date(Date.now() - 600_000) })
    await repo.insertMessage({
      threadId: loose.id,
      direction: "in",
      fromAddr: "clerk@lacity.gov",
      body: "no report or event on this thread",
      messageId: "<pe-loose@lacity.gov>",
    })

    const pending = await repo.findMessagesPendingEffects({
      before: new Date(Date.now() + 60_000),
      leaseBefore: new Date(Date.now() - 600_000),
      limit: 50,
    })
    expect(pending.map((p) => p.message.messageId)).toEqual(["<pe-eligible@lacity.gov>"])
    expect(pending[0]?.message.id).toBe(eligible!.id)
    expect(pending[0]?.thread.id).toBe(bound.id)
    expect(pending[0]?.thread.reportId).toBe(report!.id)

    expect(
      await repo.findMessagesPendingEffects({
        before: new Date(Date.now() - 60_000),
        leaseBefore: new Date(Date.now() - 600_000),
        limit: 50,
      }),
    ).toHaveLength(0)

    const reclaimable = await repo.findMessagesPendingEffects({
      before: new Date(Date.now() + 60_000),
      leaseBefore: new Date(Date.now() + 60_000),
      limit: 50,
    })
    expect(reclaimable.map((p) => p.message.messageId).sort()).toEqual([
      "<pe-eligible@lacity.gov>",
      "<pe-leased@lacity.gov>",
    ])

    await h.sql`DELETE FROM reports WHERE id = ${report!.id}`
  })
})
