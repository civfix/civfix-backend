/**
 * Admin keyset cursors must carry the column's full microsecond instant. postgres-js hands timestamptz back
 * as a JS Date (millisecond precision) and serializes a Date param with toISOString(), so a cursor built
 * from the Date skips every row in the anchor's millisecond on a DESC list and repeats them on an ASC one.
 * Rows written by one transaction share now(), so a burst of audit rows is exactly that case.
 */

import { describe, it, expect } from "vitest"
import { makeFakeSql, type FakeSqlControl } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleAuditRepository } from "../../src/services/admin/audit-repository.drizzle.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import { makeDrizzleAdminUserRepository } from "../../src/services/admin/admin-user-repository.drizzle.js"
import { makeDrizzleAdminEventRepository } from "../../src/services/admin/admin-event-repository.drizzle.js"
import { makeDrizzleModerationRepository } from "../../src/services/admin/moderation-repository.drizzle.js"
import { makeDrizzleActivityRepository } from "../../src/services/admin/activity-repository.drizzle.js"
import { decodeCursor } from "../../src/services/admin/pagination.js"

const AT = new Date("2026-09-01T10:00:00.123Z")
const AT_TEXT = "2026-09-01T10:00:00.123456Z"
const ID_A = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e01"
const ID_B = "0b8f3a52-7a55-4d6e-9d0c-5a8f1b7c9e02"
const CURSOR = `${AT_TEXT}|${ID_A}`

/** Two rows sharing one millisecond, so a limit-1 page has a next cursor anchored on the first. */
function twoRows(extra: Record<string, unknown>): Record<string, unknown>[] {
  return [
    { id: ID_A, cursor_at: AT_TEXT, ...extra },
    { id: ID_B, cursor_at: "2026-09-01T10:00:00.123001Z", ...extra },
  ]
}

function lastStatement(ctl: FakeSqlControl, match: RegExp): { sql: string; values: unknown[] } {
  const hit = [...ctl.statements].reverse().find((s) => match.test(s.sql))
  if (hit === undefined) throw new Error(`no statement matched ${String(match)}`)
  return hit
}

/** The page-2 statement binds the anchor as full-precision text cast to timestamptz, never a Date. */
function expectExactAnchor(ctl: FakeSqlControl, match: RegExp): void {
  const stmt = lastStatement(ctl, match)
  expect(stmt.values).toContain(AT_TEXT)
  expect(stmt.values.some((v) => v instanceof Date && v.getTime() === AT.getTime())).toBe(false)
  expect(stmt.sql).toContain("::timestamptz")
}

describe("decodeCursor keeps the cursor instant as text", () => {
  it("returns the microsecond text alongside the Date", () => {
    const anchor = decodeCursor(CURSOR, true)
    expect(anchor?.atText).toBe(AT_TEXT)
    expect(anchor?.id).toBe(ID_A)
  })

  it("keeps a legacy millisecond cursor and a timestamp-only cursor parseable", () => {
    expect(decodeCursor(`2026-09-01T10:00:00.123Z|${ID_A}`, true)?.atText).toBe(
      "2026-09-01T10:00:00.123Z",
    )
    expect(decodeCursor("2026-09-01T10:00:00.123Z", true)?.atText).toBe("2026-09-01T10:00:00.123Z")
  })
})

describe("admin keyset lists carry microsecond cursors", () => {
  it("audit log", async () => {
    const ctl = makeFakeSql([{ match: /FROM audit_log a/, rows: twoRows({ created_at: AT }) }])
    const repo = makeDrizzleAuditRepository(ctl.sql as unknown as Sql)
    const base = { actor: null, action: null, target: null, limit: 1 }
    const page1 = await repo.list({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.list({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, /FROM audit_log a/)
  })

  it("reports", async () => {
    const ctl = makeFakeSql([{ match: /FROM reports r/, rows: twoRows({ created_at: AT }) }])
    const repo = makeDrizzleAdminReportRepository(ctl.sql as unknown as Sql)
    const base = {
      q: null,
      statuses: null,
      flaggedOnly: false,
      needsVerificationOnly: false,
      limit: 1,
    }
    const page1 = await repo.listReports({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listReports({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, /FROM reports r/)
  })

  it("users", async () => {
    const ctl = makeFakeSql([{ match: /FROM users u/, rows: twoRows({ created_at: AT }) }])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    const base = { q: null, status: null, flaggedOnly: false, deletedOnly: false, limit: 1 }
    const page1 = await repo.listUsers({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listUsers({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, /FROM users u/)
  })

  it("a user's reports", async () => {
    const ctl = makeFakeSql([
      { match: /WHERE r\.reporter_user_id/, rows: twoRows({ created_at: AT, category: "litter" }) },
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listUserReports(ID_A, null, 1)
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listUserReports(ID_A, CURSOR, 1)
    expectExactAnchor(ctl, /WHERE r\.reporter_user_id/)
  })

  it("a user's events", async () => {
    const ctl = makeFakeSql([
      { match: /FROM cleanup_members cm/, rows: twoRows({ when_at: AT, attendees: "1" }) },
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listUserEvents(ID_A, null, 1)
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listUserEvents(ID_A, CURSOR, 1)
    expectExactAnchor(ctl, /FROM cleanup_members cm/)
  })

  it("a user's messages", async () => {
    const ctl = makeFakeSql([
      { match: /FROM dm_messages dm/, rows: twoRows({ created_at: AT, source: "dm" }) },
    ])
    const repo = makeDrizzleAdminUserRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listUserMessages(ID_A, null, 1)
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listUserMessages(ID_A, CURSOR, 1)
    expectExactAnchor(ctl, /FROM dm_messages dm/)
  })

  it("events", async () => {
    const ctl = makeFakeSql([{ match: /FROM cleanups c/, rows: twoRows({ scheduled_at: AT }) }])
    const repo = makeDrizzleAdminEventRepository(ctl.sql as unknown as Sql)
    const base = { q: null, status: null, flaggedOnly: false, limit: 1 }
    const page1 = await repo.listEvents({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listEvents({ ...base, cursor: CURSOR })
    expectExactAnchor(ctl, /FROM cleanups c/)
  })

  it("moderation queue", async () => {
    const ctl = makeFakeSql([
      {
        match: /FROM moderation_items\s+WHERE status = 'open'/,
        rows: twoRows({ created_at: AT, kind: "image", subject_type: "report", meta: {} }),
      },
    ])
    const repo = makeDrizzleModerationRepository(ctl.sql as unknown as Sql)
    const page1 = await repo.listOpen({ q: null, filter: "all", limit: 1, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.listOpen({ q: null, filter: "all", limit: 1, cursor: CURSOR })
    expectExactAnchor(ctl, /FROM moderation_items\s+WHERE status = 'open'/)
  })

  it.each(["newest", "oldest"] as const)("activity feed (%s)", async (sort) => {
    const ctl = makeFakeSql([
      { match: /FROM \(/, rows: twoRows({ source: "audit", ts: AT, action: "user.suspended" }) },
    ])
    const repo = makeDrizzleActivityRepository(ctl.sql as unknown as Sql)
    const base = { q: null, filter: "all" as const, sort, limit: 1 }
    const page1 = await repo.list({ ...base, cursor: null })
    expect(page1.nextCursor).toBe(CURSOR)
    await repo.list({ ...base, cursor: CURSOR })
    const stmt = lastStatement(ctl, /FROM \(/)
    expect(stmt.sql).toContain(sort === "newest" ? ") < (" : ") > (")
    expectExactAnchor(ctl, /FROM \(/)
  })
})
