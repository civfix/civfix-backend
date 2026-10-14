import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  makeReportChatRepository,
  REPORT_CHAT_MEMBER_SCAN_CAP,
} from "../../src/services/report-chat-repository.drizzle.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("report chat membership + system messages (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  async function newReport(): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'submitted', 'h0')
      RETURNING id
    `
    return r!.id
  }

  it("join upserts idempotently and keeps the existing role; isMember reflects it", async () => {
    const repo = makeReportChatRepository(h.sql)
    const reportId = await newReport()
    const userId = await newUser("Member A")

    expect(await repo.isMember(reportId, userId)).toBe(false)

    await repo.join(reportId, userId, "owner")
    expect(await repo.isMember(reportId, userId)).toBe(true)

    await repo.join(reportId, userId, "member")
    const [row] = await h.sql<{ role: string }[]>`
      SELECT role FROM report_chat_members WHERE report_id = ${reportId} AND user_id = ${userId}
    `
    expect(row!.role).toBe("owner")
  })

  it("leave removes the membership row", async () => {
    const repo = makeReportChatRepository(h.sql)
    const reportId = await newReport()
    const userId = await newUser("Member B")

    await repo.join(reportId, userId)
    expect(await repo.isMember(reportId, userId)).toBe(true)
    await repo.leave(reportId, userId)
    expect(await repo.isMember(reportId, userId)).toBe(false)
  })

  it("advanceReadWatermark moves last_read_at forward monotonically", async () => {
    const repo = makeReportChatRepository(h.sql)
    const reportId = await newReport()
    const userId = await newUser("Reader")
    await repo.join(reportId, userId)

    const older = await repo.insertSystemMessage({ reportId, status: "submitted", body: "older" })
    const newer = await repo.insertSystemMessage({
      reportId,
      status: "acknowledged",
      body: "newer",
    })

    await repo.advanceReadWatermark(reportId, userId, newer.id)
    const [afterNewer] = await h.sql<{ last_read_at: Date | null }[]>`
      SELECT last_read_at FROM report_chat_members WHERE report_id = ${reportId} AND user_id = ${userId}
    `
    expect(afterNewer!.last_read_at).not.toBeNull()
    const highWater = afterNewer!.last_read_at!.getTime()

    await repo.advanceReadWatermark(reportId, userId, older.id)
    const [afterOlder] = await h.sql<{ last_read_at: Date | null }[]>`
      SELECT last_read_at FROM report_chat_members WHERE report_id = ${reportId} AND user_id = ${userId}
    `
    expect(afterOlder!.last_read_at!.getTime()).toBe(highWater)
  })

  it("advanceReadWatermark is a no-op for a non-member", async () => {
    const repo = makeReportChatRepository(h.sql)
    const reportId = await newReport()
    const stranger = await newUser("Stranger")
    const msg = await repo.insertSystemMessage({ reportId, status: "submitted", body: "hello" })
    await expect(repo.advanceReadWatermark(reportId, stranger, msg.id)).resolves.toBeUndefined()
    const rows = await h.sql`
      SELECT 1 FROM report_chat_members WHERE report_id = ${reportId} AND user_id = ${stranger}
    `
    expect(rows).toHaveLength(0)
  })

  it("insertSystemMessage writes a sender-less system row and round-trips through report history", async () => {
    const repo = makeReportChatRepository(h.sql)
    const chat = makeDrizzleChatRepository(h.sql)
    const reportId = await newReport()

    const dto = await repo.insertSystemMessage({
      reportId,
      status: "acknowledged",
      kind: "status",
      note: "Report was acknowledged.",
    })
    expect(dto.from).toBeNull()
    expect(dto.kind).toBe("system")
    expect(dto.roomKind).toBe("report")
    expect(dto.cleanupId).toBe(reportId)
    expect(dto.system?.status).toBe("acknowledged")
    expect(dto.body).toBe("Report was acknowledged.")

    // The report/cleanup XOR must hold.
    const [raw] = await h.sql<
      { sender_id: string | null; cleanup_id: string | null; kind: string }[]
    >`
      SELECT sender_id, cleanup_id, kind FROM chat_messages WHERE id = ${dto.id}
    `
    expect(raw!.sender_id).toBeNull()
    expect(raw!.cleanup_id).toBeNull()
    expect(raw!.kind).toBe("system")

    const page = await chat.reportHistory(reportId, undefined, 30, null)
    const found = page.items.find((m) => m.id === dto.id)
    expect(found, "system message should appear in report history").toBeDefined()
    expect(found!.from).toBeNull()
    expect(found!.kind).toBe("system")
    expect(found!.system?.status).toBe("acknowledged")

    const single = await chat.findReportMessage(reportId, dto.id, null)
    expect(single?.from).toBeNull()
    expect(single?.kind).toBe("system")
  })

  it("listMemberIds and countMembers reflect the membership set", async () => {
    const repo = makeReportChatRepository(h.sql)
    const reportId = await newReport()
    const a = await newUser("A")
    const b = await newUser("B")
    await repo.join(reportId, a, "owner")
    await repo.join(reportId, b)

    expect(await repo.countMembers(reportId)).toBe(2)
    const ids = await repo.listMemberIds(reportId)
    expect(ids).toContain(a)
    expect(ids).toContain(b)
    expect(ids).toHaveLength(2)
  })

  // Report chat is join-on-view and the roster drives the bell fan-out and mention resolver, so an
  // unbounded roster read on a viral report would load it all into memory and hand the notifier an
  // unbounded recipient list.
  it("F154: listMemberIds honors the caller's limit and is deterministic at the boundary", async () => {
    const repo = makeReportChatRepository(h.sql)
    const reportId = await newReport()
    const members: string[] = []
    for (let i = 0; i < 5; i++) members.push(await newUser(`Roster ${i}`))
    for (const m of members) await repo.join(reportId, m)

    expect(await repo.countMembers(reportId)).toBe(5)

    const capped = await repo.listMemberIds(reportId, 2)
    expect(capped).toHaveLength(2)
    expect(await repo.listMemberIds(reportId, 2)).toEqual(capped)
    for (const id of capped) expect(members).toContain(id)

    const all = await repo.listMemberIds(reportId)
    expect(all).toHaveLength(5)
    expect(all.slice(0, 2)).toEqual(capped)
    expect(REPORT_CHAT_MEMBER_SCAN_CAP).toBeGreaterThan(0)
  })
})
