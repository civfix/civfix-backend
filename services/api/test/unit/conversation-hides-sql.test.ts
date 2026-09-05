import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import {
  makeDrizzleThreadsRepository,
  makeDrizzleReportThreadsSource,
  makeDrizzleGroupThreadsSource,
} from "../../src/services/threads-repository.drizzle.js"
import { makeDrizzleDmRepository } from "../../src/services/dm-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"

async function emitted(run: (sql: Sql) => Promise<unknown>): Promise<{
  sql: string
  values: unknown[]
}> {
  const fake = makeFakeSql()
  await run(fake.sql as unknown as Sql)
  const stmt = fake.statements[0]
  expect(stmt).toBeDefined()
  return stmt!
}

const SOURCES: Array<{ name: string; roomKind: string; run: (sql: Sql) => Promise<unknown> }> = [
  {
    name: "listThreadsFor",
    roomKind: "cleanup",
    run: (sql) => makeDrizzleThreadsRepository(sql).listThreadsFor(VIEWER, 30, null),
  },
  {
    name: "listReportThreadsFor",
    roomKind: "report",
    run: (sql) => makeDrizzleReportThreadsSource(sql).listReportThreadsFor(VIEWER, 30, null),
  },
  {
    name: "listGroupThreadsFor",
    roomKind: "group",
    run: (sql) => makeDrizzleGroupThreadsSource(sql).listGroupThreadsFor(VIEWER, 30, null),
  },
  {
    name: "listThreadsForUser",
    roomKind: "dm",
    run: (sql) => makeDrizzleDmRepository(sql).listThreadsForUser(VIEWER, 30, null),
  },
]

describe("every threads source filters hidden conversations in SQL, before its LIMIT", () => {
  for (const source of SOURCES) {
    it(`${source.name} joins conversation_hides for the viewer and its own room kind`, async () => {
      const stmt = await emitted(source.run)
      expect(stmt.sql).toContain("LEFT JOIN conversation_hides h")
      expect(stmt.sql).toMatch(/h\.user_id = \?/)
      expect(stmt.sql).toMatch(/h\.room_id = (r|t)\.id/)
      const kindInline = stmt.sql.includes(`h.room_kind = '${source.roomKind}'`)
      expect(kindInline || stmt.values.includes(source.roomKind)).toBe(true)
    })

    it(`${source.name} keeps a room only while its untruncated activity is strictly after hidden_at`, async () => {
      const stmt = await emitted(source.run)
      expect(stmt.sql).toMatch(
        /\(h\.hidden_at IS NULL OR COALESCE\(last_msg\.created_at, [a-z]+\.(joined_at|created_at)\) > h\.hidden_at\)/,
      )
      expect(stmt.sql).not.toMatch(/date_trunc\('milliseconds'[^)]*\)\) > h\.hidden_at/)
    })

    it(`${source.name} applies the hide predicate ahead of the row limit`, async () => {
      const stmt = await emitted(source.run)
      const predicateAt = stmt.sql.indexOf("h.hidden_at IS NULL")
      const limitAt = stmt.sql.indexOf("LIMIT ?", predicateAt)
      expect(predicateAt).toBeGreaterThan(-1)
      expect(limitAt).toBeGreaterThan(predicateAt)
    })
  }
})
