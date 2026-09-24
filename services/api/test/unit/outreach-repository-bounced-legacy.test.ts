import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleOutreachRepository } from "../../src/services/admin/outreach-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const GEOID = "0644000"
const LEGACY_BOUNCE_GUARD =
  /FROM unnest\(COALESCE\(j\.contact_emails, ARRAY\[\]::text\[\]\)\) AS e WHERE e <> '' AND NOT EXISTS .*? me\.type = 'bounced' AND lower\(me\.meta->>'failedRecipient'\) = lower\(e\)/

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ")
}

describe("outreach repository skips a bounced legacy contact_emails address", () => {
  it("loadDigest never picks a legacy address that already bounced", async () => {
    const fake = makeFakeSql()
    await makeDrizzleOutreachRepository(fake.sql as unknown as Sql).loadDigest(GEOID)
    expect(flat(fake.statements[0]?.sql ?? "")).toMatch(LEGACY_BOUNCE_GUARD)
  })

  it("listCandidateGeoids does not treat a bounced legacy address as a routable contact", async () => {
    const fake = makeFakeSql()
    await makeDrizzleOutreachRepository(fake.sql as unknown as Sql).listCandidateGeoids(10)
    expect(flat(fake.statements[0]?.sql ?? "")).toMatch(LEGACY_BOUNCE_GUARD)
  })
})
