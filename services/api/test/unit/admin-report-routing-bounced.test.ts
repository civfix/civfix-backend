import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleAdminReportRepository } from "../../src/services/admin/admin-report-repository.drizzle.js"
import { makeDrizzleHomeRepository } from "../../src/services/admin/home-repository.drizzle.js"

const REPORT_ID = "4c1f7d2e-8b3a-4f5e-9a6b-7c8d9e0f1a2b"
const LEGACY_BOUNCE_GUARD =
  /me\.type = 'bounced' AND lower\(me\.meta->>'failedRecipient'\) = lower\([a-z_]+\.v\)/

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ")
}

describe("report routing skips bounced contacts", () => {
  it("getRouting picks the first legacy address that has not bounced, not contact_emails[1]", async () => {
    const fake = makeFakeSql()
    await makeDrizzleAdminReportRepository(fake.sql as unknown as Sql).getRouting(REPORT_ID)
    const text = flat(fake.statements[0]?.sql ?? "")
    expect(text).not.toMatch(/contact_emails\[1\]/)
    expect(text).toMatch(LEGACY_BOUNCE_GUARD)
    expect(text).toMatch(/WITH ORDINALITY/)
  })

  it("getRouting routes to the usable legacy address the query returns", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM reports r/,
        rows: [
          {
            geoid: "0644000",
            place: "Los Angeles",
            category: "trash",
            cat_email: null,
            default_email: null,
            legacy_email: "second@lacity.gov",
            forward_subject_template: null,
            forward_body_template: null,
          },
        ],
      },
    ])
    const routing = await makeDrizzleAdminReportRepository(fake.sql as unknown as Sql).getRouting(
      REPORT_ID,
    )
    expect(routing).toMatchObject({ contact: "second@lacity.gov", routed: true })
  })

  it("the waiting-for-routing count treats bounced per-category and legacy contacts as unusable", async () => {
    const fake = makeFakeSql()
    await makeDrizzleHomeRepository(fake.sql as unknown as Sql).discoverySummary()
    const text = flat(fake.statements[0]?.sql ?? "")
    const routable = text.slice(text.indexOf("AND NOT"), text.indexOf("per_geoid AS"))
    expect(routable).toMatch(/bounced_at IS NULL/)
    expect(routable).toMatch(LEGACY_BOUNCE_GUARD)
  })
})
