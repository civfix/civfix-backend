import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { makeDrizzleBroadcastRepository } from "../../src/services/host/broadcast-repository.drizzle.js"
import { makeFakeSql } from "../helpers/fake-sql.js"

describe("operator host search", () => {
  it("matches % and _ literally instead of as wildcards", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleBroadcastRepository(fake.sql as unknown as Sql)

    await repo.listAdminHosts({
      q: "50%_off\\",
      windowStart: new Date("2026-09-01T00:00:00Z"),
      cursor: null,
      limit: 10,
    })

    const statement = fake.statements[0]
    expect(statement?.sql).toMatch(/u\.display_name ILIKE \? ESCAPE '\\'/)
    expect(statement?.sql).toMatch(/u\.handle ILIKE \? ESCAPE '\\'/)
    expect(statement?.values).toContain("%50\\%\\_off\\\\%")
    expect(statement?.values).not.toContain("%50%_off\\%")
  })
})
