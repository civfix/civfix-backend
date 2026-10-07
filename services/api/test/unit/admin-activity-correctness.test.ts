import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleActivityRepository } from "../../src/services/admin/activity-repository.drizzle.js"
import { describeAuditAction } from "../../src/services/admin/activity-service.js"

describe("activity kind filter matches audit prefixes literally", () => {
  it("escapes LIKE metacharacters in the dotted prefixes", async () => {
    const ctl = makeFakeSql()
    const repo = makeDrizzleActivityRepository(ctl.sql as unknown as Sql)
    await repo.list({ q: null, filter: "gov_onboard", sort: "newest", cursor: null, limit: 5 })
    const stmt = ctl.statements[0]
    expect(stmt?.values).toContain("gov\\_claim.%")
    expect(stmt?.values).not.toContain("gov_claim.%")
    expect(stmt?.sql).toMatch(/a\.action LIKE \? ESCAPE '\\'/)
  })
})

describe("every audit action the api writes renders a label in the activity feed", () => {
  it.each([
    "report_message.removed",
    "operator.login_denied",
    "report.takedown_requested",
    "account.deleted",
    "event.announcement_sent",
    "data_export.undeliverable",
  ])("%s", (action) => {
    expect(describeAuditAction(action)).not.toBe(action)
  })
})
