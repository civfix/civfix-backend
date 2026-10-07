import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../../helpers/fake-sql.js"
import { makeDrizzleAdminEventPageRepository } from "../../../src/services/host/admin-pages-repository.drizzle.js"
import type { Sql, TransactionSql } from "../../../src/db/client.js"

const PAGE_LIMIT = 25

describe("operator event-page search", () => {
  it("matches LIKE metacharacters in the term literally", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleAdminEventPageRepository(fake.sql as unknown as Sql)

    await repo.list({ q: "50%_off\\", cursor: null, limit: PAGE_LIMIT })

    const stmt = fake.statements[0]!
    const flat = stmt.sql.replace(/\s+/g, " ")
    expect(flat).toContain("c.title ILIKE ? ESCAPE '\\'")
    expect(flat).toContain("c.page_slug::text ILIKE ? ESCAPE '\\'")
    const patterns = stmt.values.filter((v) => typeof v === "string" && v.startsWith("%"))
    expect(patterns).toEqual(["%50\\%\\_off\\\\%", "%50\\%\\_off\\\\%"])
  })

  it("adds no search predicate for an empty term", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleAdminEventPageRepository(fake.sql as unknown as Sql)

    await repo.list({ q: "", cursor: null, limit: PAGE_LIMIT })

    expect(fake.statements[0]!.sql).not.toContain("ILIKE")
  })
})

describe("operator event-page repository inside a transaction", () => {
  it("runs on the transaction handle it is given", async () => {
    const fake = makeFakeSql()

    await fake.sql.begin((tx) =>
      makeDrizzleAdminEventPageRepository(tx as unknown as TransactionSql).list({
        cursor: null,
        limit: PAGE_LIMIT,
      }),
    )

    expect(fake.statements).toHaveLength(1)
  })
})
