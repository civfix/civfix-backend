import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import { makeDrizzleMailRepository } from "../../src/services/admin/mail-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const REPORT_ID = "11111111-1111-1111-1111-111111111111"
const THREAD_ID = "22222222-2222-2222-2222-222222222222"

async function outreachStatement(): Promise<string> {
  const fake = makeFakeSql()
  const repo = makeDrizzleAdminReportRepository(fake.sql as unknown as Sql)
  await repo.getOutreach(REPORT_ID)
  const stmt = fake.statements[0]
  expect(stmt, "getOutreach should emit a statement").toBeDefined()
  return stmt!.sql
}

async function inFlightStatement(): Promise<string> {
  const fake = makeFakeSql()
  const repo = makeDrizzleMailRepository(fake.sql as unknown as Sql)
  await repo.hasSendInFlight(THREAD_ID)
  const stmt = fake.statements[0]
  expect(stmt, "hasSendInFlight should emit a statement").toBeDefined()
  return stmt!.sql
}

function mailEventsSubqueries(sql: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = sql.indexOf("FROM mail_events e", from)
    if (at === -1) break
    let end = sql.indexOf("FROM mail_events e", at + 1)
    if (end === -1) end = sql.length
    out.push(sql.slice(at, end))
    from = at + 1
  }
  return out
}

describe("outbound send predicates are index-served", () => {
  it("getOutreach filters EVERY mail_events subquery on thread_id", async () => {
    const sql = await outreachStatement()
    const subqueries = mailEventsSubqueries(sql)
    expect(subqueries.length).toBeGreaterThanOrEqual(5)
    for (const [i, sub] of subqueries.entries()) {
      expect(sub, `mail_events subquery #${i} must filter on thread_id`).toMatch(
        /WHERE\s+e\.thread_id\s*=/,
      )
    }
  })

  it("hasSendInFlight filters EVERY mail_events subquery on thread_id", async () => {
    const sql = await inFlightStatement()
    const subqueries = mailEventsSubqueries(sql)
    expect(subqueries.length).toBeGreaterThanOrEqual(2)
    for (const [i, sub] of subqueries.entries()) {
      expect(sub, `mail_events subquery #${i} must filter on thread_id`).toMatch(
        /WHERE\s+e\.thread_id\s*=/,
      )
    }
  })

  it("scopes the latest-attempt lookup to the thread, and matches events to that attempt", async () => {
    for (const sql of [await outreachStatement(), await inFlightStatement()]) {
      expect(sql).toMatch(/FROM mail_messages m\s+WHERE m\.thread_id =/)
      expect(sql).toContain("ORDER BY m.created_at DESC, m.id DESC")
      expect(sql).toContain("e.message_id = latest.id::text")
    }
  })

  it("both repositories emit the SAME in-flight expression (one shared fragment)", async () => {
    const normalise = (s: string): string => s.replace(/\s+/g, " ").trim()
    const inFlight = normalise(await inFlightStatement())
    const outreach = normalise(await outreachStatement())
    const core = inFlight.slice(inFlight.indexOf("COALESCE("), inFlight.lastIndexOf(") AS ok"))
    expect(core.length).toBeGreaterThan(100)
    expect(outreach).toContain(core.replace(/\?::uuid/g, "t.id").trim())
  })
})
