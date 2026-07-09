/**
 * Task D-C1: report-chat membership repository (Docker-gated). Boots against a live PostGIS container
 * (via withPg) and exercises the DB-backed paths the offline suite covers only by the pure mapSystemRow
 * unit test (test/unit/report-system-message.test.ts):
 *
 *   - join is an idempotent upsert (re-join keeps the existing role, never demotes an owner);
 *   - leave removes the membership row; isMember is an EXISTS check;
 *   - advanceReadWatermark moves last_read_at forward monotonically and no-ops for a non-member / bad id;
 *   - insertSystemMessage writes a sender-less kind:"system" chat_messages row and round-trips it through
 *     the report history mapper (from:null, kind:"system", structured system payload);
 *   - listMemberIds / countMembers reflect the membership set.
 *
 * When Docker is unavailable the whole block SKIPS so the local suite stays green; CI runs it for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
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

  /** Insert a user and return its id. */
  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name) VALUES (${name}) RETURNING id
    `
    return u!.id
  }

  /** Insert a minimal report and return its id. */
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

    // Re-join as a plain member must NOT demote the owner.
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

    // Two report messages with distinct created_at (older, then newer).
    const older = await repo.insertSystemMessage({ reportId, status: "submitted", body: "older" })
    const newer = await repo.insertSystemMessage({ reportId, status: "acknowledged", body: "newer" })

    await repo.advanceReadWatermark(reportId, userId, newer.id)
    const [afterNewer] = await h.sql<{ last_read_at: Date | null }[]>`
      SELECT last_read_at FROM report_chat_members WHERE report_id = ${reportId} AND user_id = ${userId}
    `
    expect(afterNewer!.last_read_at).not.toBeNull()
    const highWater = afterNewer!.last_read_at!.getTime()

    // Advancing to the OLDER message must not move the watermark backward.
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
    // Non-member: nothing to update, must not throw.
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

    // The raw row is sender-less with a NULL cleanup_id (report/cleanup XOR holds).
    const [raw] = await h.sql<{ sender_id: string | null; cleanup_id: string | null; kind: string }[]>`
      SELECT sender_id, cleanup_id, kind FROM chat_messages WHERE id = ${dto.id}
    `
    expect(raw!.sender_id).toBeNull()
    expect(raw!.cleanup_id).toBeNull()
    expect(raw!.kind).toBe("system")

    // Report history (the getChatRepo() path used by the reportMessages route) includes the system row.
    const page = await chat.reportHistory(reportId, undefined, 30, null)
    const found = page.items.find((m) => m.id === dto.id)
    expect(found, "system message should appear in report history").toBeDefined()
    expect(found!.from).toBeNull()
    expect(found!.kind).toBe("system")
    expect(found!.system?.status).toBe("acknowledged")

    // findReportMessage also maps the system row without assuming an author.
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
})
