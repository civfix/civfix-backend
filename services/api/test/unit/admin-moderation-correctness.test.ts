import { describe, it, expect } from "vitest"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleModerationRepository } from "../../src/services/admin/moderation-repository.drizzle.js"
import { InMemoryModerationRepository } from "../helpers/admin/moderation-repository.memory.js"

const ITEM_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e31"
const USER_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e32"
const REPORT_ID = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e33"
const AUDIT_ROW: SqlHandler = { match: /INSERT INTO audit_log/, rows: [{ id: "audit-1" }] }

function itemRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: ITEM_ID,
    kind: "user_report",
    subject_type: "user",
    subject_id: USER_ID,
    flag: null,
    reason: null,
    category: null,
    place: null,
    priority: "med",
    auto_action: null,
    status: "removed",
    signals: [],
    similar: [],
    meta: {},
    created_at: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  }
}

const strikes = (sqlText: string): boolean =>
  /INSERT INTO user_moderation \(user_id, strikes, removals/.test(sqlText)

describe("moderation remove on a user subject whose account row is gone", () => {
  it("resolves the item without writing a suspension for a user that does not exist", async () => {
    const ctl = makeFakeSql([
      { match: /UPDATE moderation_items\s+SET status/, rows: [itemRow({})] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    const record = await repo.remove(ITEM_ID, { actorId: "op-1", reason: null })
    expect(record?.id).toBe(ITEM_ID)
    expect(record?.suspendedUserId).toBeUndefined()
    expect(
      ctl.statements.some((s) =>
        /INSERT INTO user_moderation \(user_id, account_status/.test(s.sql),
      ),
    ).toBe(false)
  })
})

describe("appeal overturn on a user subject", () => {
  it("lifts only the suspension moderation imposes, never an operator ban", async () => {
    const ctl = makeFakeSql([
      {
        match: /UPDATE moderation_items\s+SET status = 'approved'/,
        rows: [itemRow({ kind: "appeal", status: "approved" })],
      },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    const record = await repo.decideAppeal(ITEM_ID, {
      decision: "overturn",
      actorId: "op-1",
      note: null,
    })
    expect(record?.restoredUserId).toBeUndefined()
    const restore = ctl.statements.find((s) => /account_status = 'active'/.test(s.sql))
    expect(restore?.sql).toMatch(/account_status = 'suspended'/)
    expect(restore?.sql).not.toMatch(/INSERT INTO user_moderation/)
  })

  it("the offline twin keeps a non-suspended account as it is", async () => {
    const repo = new InMemoryModerationRepository()
    const item = repo.seedItem({ kind: "appeal", subjectType: "user", subjectId: USER_ID })
    const record = await repo.decideAppeal(item.id, {
      decision: "overturn",
      actorId: "op-1",
      note: null,
    })
    expect(record?.restoredUserId).toBeUndefined()
    expect(repo.accountStatus.get(USER_ID)).toBeUndefined()
  })
})

describe("owner takedown requests", () => {
  const ownerRequest = {
    kind: "user_report" as const,
    subjectType: "report" as const,
    subjectId: REPORT_ID,
    flag: "Owner takedown request",
    reason: "please remove",
    reporter: "@owner",
    reporterUserId: USER_ID,
    priority: "high" as const,
    dedupeOpen: true,
  }

  it("folding into an item another party opened records the owner without the consent marker", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT id FROM moderation_items/, rows: [{ id: ITEM_ID }] },
      { match: /SELECT reporter_user_id FROM reports/, rows: [{ reporter_user_id: USER_ID }] },
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    await expect(repo.createItem(ownerRequest)).resolves.toBeNull()
    const escalate = ctl.statements.find((s) => /SET priority = 'high'/.test(s.sql))
    expect(escalate?.sql).toMatch(/'\{reporters\}'/)
    expect(escalate?.values).toContain(USER_ID)
    expect(escalate?.values).not.toContainEqual({ ownerTakedown: true })
    expect(escalate?.values).not.toContain("Owner takedown request")
    expect(escalate?.sql).not.toMatch(/- 'ownerTakedown'/)
  })

  it("a third party folding into an owner's item clears the consent marker", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT id FROM moderation_items/, rows: [{ id: ITEM_ID }] },
      {
        match: /SELECT reporter_user_id FROM reports/,
        rows: [{ reporter_user_id: "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e99" }],
      },
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    await repo.createItem({ ...ownerRequest, flag: "User report", priority: "med" })
    const escalate = ctl.statements.find((s) => /SET priority = 'high'/.test(s.sql))
    expect(escalate?.sql).toMatch(/- 'ownerTakedown'/)
  })

  it("a new item filed by the report's own author carries the marker", async () => {
    const ctl = makeFakeSql([
      { match: /SELECT id FROM moderation_items/, rows: [] },
      { match: /SELECT reporter_user_id FROM reports/, rows: [{ reporter_user_id: USER_ID }] },
      { match: /INSERT INTO moderation_items/, rows: [{ id: ITEM_ID }] },
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    await repo.createItem(ownerRequest)
    const insert = ctl.statements.find((s) => /INSERT INTO moderation_items/.test(s.sql))
    expect(insert?.values).toContainEqual(expect.objectContaining({ ownerTakedown: true }))
  })

  it("honoring an owner takedown does not strike the owner", async () => {
    const ctl = makeFakeSql([
      {
        match: /UPDATE moderation_items\s+SET status/,
        rows: [
          itemRow({ subject_type: "report", subject_id: REPORT_ID, meta: { ownerTakedown: true } }),
        ],
      },
      { match: /UPDATE reports SET status = 'rejected'/, rows: [{ id: REPORT_ID }] },
      { match: /SELECT reporter_user_id FROM reports/, rows: [{ reporter_user_id: USER_ID }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    await repo.remove(ITEM_ID, { actorId: "op-1", reason: null })
    expect(ctl.statements.some((s) => strikes(s.sql))).toBe(false)
  })

  it("a third-party report removal still strikes the author", async () => {
    const ctl = makeFakeSql([
      {
        match: /UPDATE moderation_items\s+SET status/,
        rows: [itemRow({ subject_type: "report", subject_id: REPORT_ID })],
      },
      { match: /UPDATE reports SET status = 'rejected'/, rows: [{ id: REPORT_ID }] },
      { match: /SELECT reporter_user_id FROM reports/, rows: [{ reporter_user_id: USER_ID }] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    await repo.remove(ITEM_ID, { actorId: "op-1", reason: null })
    expect(ctl.statements.some((s) => strikes(s.sql))).toBe(true)
  })
})

describe("moderation remove on an already banned user", () => {
  it("keeps the ban and does not hand the account to the suspension path", async () => {
    const ctl = makeFakeSql([
      {
        match: /UPDATE moderation_items\s+SET status/,
        rows: [itemRow({ subject_type: "user", subject_id: USER_ID })],
      },
      { match: /SELECT role FROM users/, rows: [{ role: "user" }] },
      { match: /INSERT INTO user_moderation \(user_id, account_status/, rows: [] },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    const record = await repo.remove(ITEM_ID, { actorId: "op-1", reason: null })
    const upsert = ctl.statements.find((s) =>
      /INSERT INTO user_moderation \(user_id, account_status/.test(s.sql),
    )
    expect(upsert?.sql).toMatch(/WHERE user_moderation\.account_status <> 'banned'/)
    const lock = ctl.statements.find((s) => /SELECT role FROM users/.test(s.sql))
    expect(lock?.sql).toMatch(/FOR NO KEY UPDATE/)
    expect(record?.suspendedUserId).toBeUndefined()
    expect(ctl.statements.some((s) => strikes(s.sql))).toBe(true)
  })

  it("suspends an account that is not banned", async () => {
    const ctl = makeFakeSql([
      {
        match: /UPDATE moderation_items\s+SET status/,
        rows: [itemRow({ subject_type: "user", subject_id: USER_ID })],
      },
      { match: /SELECT role FROM users/, rows: [{ role: "user" }] },
      {
        match: /INSERT INTO user_moderation \(user_id, account_status/,
        rows: [{ user_id: USER_ID }],
      },
      AUDIT_ROW,
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    const record = await repo.remove(ITEM_ID, { actorId: "op-1", reason: null })
    expect(record?.suspendedUserId).toBe(USER_ID)
  })

  it("the offline twin keeps a banned account banned", async () => {
    const repo = new InMemoryModerationRepository()
    repo.accountStatus.set(USER_ID, "banned")
    const item = repo.seedItem({ kind: "user_report", subjectType: "user", subjectId: USER_ID })
    const record = await repo.remove(item.id, { actorId: "op-1", reason: null })
    expect(record?.suspendedUserId).toBeUndefined()
    expect(repo.accountStatus.get(USER_ID)).toBe("banned")
  })
})
