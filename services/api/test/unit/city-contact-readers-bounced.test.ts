import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleDiscussionRepository } from "../../src/services/discussion-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"

const REPORT_ID = "4c1f7d2e-8b3a-4f5e-9a6b-7c8d9e0f1a2b"
const GEOID = "0644000"
const LEGACY_BOUNCE_GUARD =
  /me\.type = 'bounced' AND lower\(me\.meta->>'failedRecipient'\) = lower\([a-z_]+\.v\)/
const USABLE_ROW_GUARD =
  /jc\.email IS NOT NULL AND btrim\(jc\.email\) <> '' AND jc\.bounced_at IS NULL/g

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ")
}

describe("report chat @city forward skips bounced contacts", () => {
  it("findReportForDiscussion filters bounced per-category and legacy contacts", async () => {
    const fake = makeFakeSql()
    await makeDrizzleDiscussionRepository(fake.sql as unknown as Sql).findReportForDiscussion(
      REPORT_ID,
    )
    const text = flat(fake.statements[0]?.sql ?? "")
    expect(text).not.toMatch(/contact_emails\[1\]/)
    expect(text.match(USABLE_ROW_GUARD)).toHaveLength(2)
    expect(text).toMatch(LEGACY_BOUNCE_GUARD)
    expect(text).toMatch(/WITH ORDINALITY/)
  })

  it("findReportForDiscussion forwards to the usable legacy address the query returns", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM reports r/,
        rows: [
          {
            id: REPORT_ID,
            reporter_user_id: null,
            status: "published",
            visibility: "public",
            deleted_at: null,
            category: "trash",
            place: null,
            geoid: GEOID,
            j_name: "Los Angeles",
            j_handle: null,
            cat_email: null,
            default_email: null,
            legacy_email: "second@lacity.gov",
          },
        ],
      },
    ])
    const view = await makeDrizzleDiscussionRepository(
      fake.sql as unknown as Sql,
    ).findReportForDiscussion(REPORT_ID)
    expect(view?.jurisdiction?.contactEmail).toBe("second@lacity.gov")
  })
})

describe("cleanup jurisdiction contact skips bounced contacts", () => {
  it("resolveJurisdictionContact filters bounced default and legacy contacts", async () => {
    const fake = makeFakeSql()
    await makeDrizzleCleanupRepository(fake.sql as unknown as Sql).resolveJurisdictionContact(GEOID)
    const text = flat(fake.statements[0]?.sql ?? "")
    expect(text).not.toMatch(/contact_emails\[1\]/)
    expect(text.match(USABLE_ROW_GUARD)).toHaveLength(1)
    expect(text).toMatch(LEGACY_BOUNCE_GUARD)
    expect(text).toMatch(/WITH ORDINALITY/)
  })

  it("resolveJurisdictionContact returns null when no contact is usable", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM jurisdictions j/,
        rows: [{ name: "Los Angeles", default_email: null, legacy_email: null }],
      },
    ])
    const contact = await makeDrizzleCleanupRepository(
      fake.sql as unknown as Sql,
    ).resolveJurisdictionContact(GEOID)
    expect(contact).toBeNull()
  })

  it("resolveJurisdictionContact uses the usable legacy address the query returns", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM jurisdictions j/,
        rows: [{ name: "Los Angeles", default_email: null, legacy_email: "second@lacity.gov" }],
      },
    ])
    const contact = await makeDrizzleCleanupRepository(
      fake.sql as unknown as Sql,
    ).resolveJurisdictionContact(GEOID)
    expect(contact).toEqual({ contact: "second@lacity.gov", name: "Los Angeles" })
  })
})
