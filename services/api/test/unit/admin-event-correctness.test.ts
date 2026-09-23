import { describe, it, expect } from "vitest"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleAdminEventRepository } from "../../src/services/admin/admin-event-repository.drizzle.js"
import { InMemoryAdminEventRepository } from "../../src/services/admin/admin-event-repository.memory.js"
import { ADMIN_EVENT_MESSAGE_CAP } from "../../src/services/admin/admin-event-helpers.js"

const EVENT_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e41"
const AUDIT_ROW: SqlHandler = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }
const SEEDED_MESSAGES = 150

function message(i: number): { who: string; text: string; createdAt: Date } {
  return { who: "host", text: `message ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }
}

describe("admin event detail shows the most recent chat messages", () => {
  it("reads the newest page from the database and returns it oldest first", async () => {
    const newestFirst = [3, 2, 1].map((i) => ({
      who: "host",
      body: `message ${i}`,
      created_at: message(i).createdAt,
    }))
    const ctl = makeFakeSql([{ match: /FROM chat_messages m/, rows: newestFirst }])
    const repo = makeDrizzleAdminEventRepository(ctl.sql as unknown as Sql)
    const messages = await repo.listMessages(EVENT_ID)
    expect(messages.map((m) => m.text)).toEqual(["message 1", "message 2", "message 3"])
    expect(ctl.statements[0]?.sql).toMatch(/ORDER BY m\.created_at DESC, m\.id DESC/)
  })

  it("the offline twin keeps the newest capped window too", async () => {
    const repo = new InMemoryAdminEventRepository()
    const seeded = Array.from({ length: SEEDED_MESSAGES }, (_, i) => message(i + 1))
    repo.seedEvent({ id: EVENT_ID, messages: seeded })
    const messages = await repo.listMessages(EVENT_ID)
    expect(messages).toHaveLength(ADMIN_EVENT_MESSAGE_CAP)
    expect(messages[0]?.text).toBe(`message ${SEEDED_MESSAGES - ADMIN_EVENT_MESSAGE_CAP + 1}`)
    expect(messages.at(-1)?.text).toBe(`message ${SEEDED_MESSAGES}`)
  })
})

describe("admin event flag toggle serializes on the event row", () => {
  it("locks the cleanup row before reading the latest flag row", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT id FROM cleanups/, rows: [{ id: EVENT_ID }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminEventRepository(ctl.sql as unknown as Sql)
    await repo.toggleFlag(EVENT_ID, { reason: null, actorId: "op-1" })
    const lock = ctl.statements.find((s) => /SELECT id FROM cleanups/.test(s.sql))
    expect(lock?.sql).toMatch(/FOR UPDATE/)
  })
})

describe("admin event outcome", () => {
  it("records the outcome on the event timeline in the same transaction", async () => {
    const ctl = makeFakeSql([
      { match: /UPDATE cleanups SET bags/, rows: [{ id: EVENT_ID }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleAdminEventRepository(ctl.sql as unknown as Sql)
    await repo.setBags(EVENT_ID, { bags: 12, actorId: "op-1" })
    const timeline = ctl.statements.find((s) => /INSERT INTO cleanup_timeline/.test(s.sql))
    expect(timeline?.sql).toMatch(/'outcome'/)
    expect(timeline?.values).toContain("op-1")
  })

  it("the offline twin appends the outcome row", async () => {
    const repo = new InMemoryAdminEventRepository()
    repo.seedEvent({ id: EVENT_ID })
    await repo.setBags(EVENT_ID, { bags: 12, actorId: "op-1" })
    const timeline = await repo.listTimeline(EVENT_ID)
    expect(timeline.at(-1)).toMatchObject({ kind: "outcome", who: "operator" })
  })
})
