import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { evalSqlPredicate, type PredicateRow } from "../helpers/sql-predicate.js"
import type { Queryable } from "../../src/db/client.js"
import {
  moderationMediaFilter,
  moderationMediaKeyExpr,
  servableMediaFilter,
  servedKeyExpr,
} from "../../src/services/media-served-key.js"
import { makeDrizzleReportRepository } from "../../src/services/report-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const R2 = "reports/original.jpg"
const SERVED = "reports/original.jpg.served"

async function fragmentSql(build: (sql: Queryable) => unknown): Promise<string> {
  const fake = makeFakeSql([])
  await fake.sql`${build(fake.sql as unknown as Queryable)}`
  return fake.statements[0]?.sql ?? ""
}

function asset(status: string, servedKey: string | null): PredicateRow {
  return { status, served_key: servedKey, r2_key: R2 }
}

const CASES: { label: string; row: PredicateRow; servable: boolean; moderatable: boolean }[] = [
  { label: "validating, not yet processed", row: asset("validating", null), servable: true, moderatable: true },
  { label: "validating, processed early", row: asset("validating", SERVED), servable: true, moderatable: true },
  { label: "ready with a served copy", row: asset("ready", SERVED), servable: true, moderatable: true },
  { label: "ready without a served copy", row: asset("ready", null), servable: false, moderatable: false },
  { label: "held with a served copy", row: asset("held", SERVED), servable: false, moderatable: true },
  { label: "held without a served copy", row: asset("held", null), servable: false, moderatable: true },
  { label: "rejected", row: asset("rejected", null), servable: false, moderatable: true },
]

describe("servableMediaFilter", () => {
  it("is a whitelist, not a status <> 'ready' blacklist", async () => {
    const text = await fragmentSql((sql) => servableMediaFilter(sql, "media_assets"))
    expect(text).toBe(
      "(media_assets.status = 'validating' OR (media_assets.status = 'ready' AND media_assets.served_key IS NOT NULL))",
    )
    expect(text).not.toMatch(/status <> 'ready'/)
  })

  for (const c of CASES) {
    it(`${c.servable ? "serves" : "quarantines"} an asset that is ${c.label}`, async () => {
      const text = await fragmentSql((sql) => servableMediaFilter(sql, "media_assets"))
      expect(evalSqlPredicate(text, c.row)).toBe(c.servable)
    })
  }
})

describe("servedKeyExpr", () => {
  it("falls back to the raw upload key only while the asset is validating", async () => {
    const text = await fragmentSql((sql) => servedKeyExpr(sql, "media_assets"))
    expect(text).toBe(
      "COALESCE(media_assets.served_key, CASE WHEN media_assets.status = 'validating' THEN media_assets.r2_key END)",
    )
    expect(text).not.toMatch(/status <> 'ready'/)
  })
})

describe("moderation media fragments", () => {
  it("keep the operator surface able to view held and rejected assets", async () => {
    const text = await fragmentSql((sql) => moderationMediaFilter(sql, "media_assets"))
    for (const c of CASES) {
      expect({ label: c.label, visible: evalSqlPredicate(text, c.row) }).toEqual({
        label: c.label,
        visible: c.moderatable,
      })
    }
  })

  it("still resolve a key for a held asset that never got a served copy", async () => {
    const text = await fragmentSql((sql) => moderationMediaKeyExpr(sql, "media_assets"))
    expect(text).toBe(
      "COALESCE(media_assets.served_key, CASE WHEN media_assets.status <> 'ready' THEN media_assets.r2_key END)",
    )
  })
})

describe("report media reads", () => {
  it("select through the whitelist filter and the validating-only fallback", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])
    const repo = makeDrizzleReportRepository(fake.sql as unknown as Sql)

    await repo.findMediaForReport("33333333-3333-4333-8333-333333333333", true)

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(
      /media_assets\.status = 'validating' OR \(media_assets\.status = 'ready' AND media_assets\.served_key IS NOT NULL\)/,
    )
    expect(statement.sql).not.toMatch(/status <> 'ready'/)
    expect(statement.sql).toMatch(
      /COALESCE\(media_assets\.served_key, CASE WHEN media_assets\.status = 'validating' THEN media_assets\.r2_key END\)/,
    )
  })

  it("applies the same filter to the batched multi-report read", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])
    const repo = makeDrizzleReportRepository(fake.sql as unknown as Sql)

    await repo.findMediaForReports(["33333333-3333-4333-8333-333333333333"], true)

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(
      /media_assets\.status = 'validating' OR \(media_assets\.status = 'ready' AND media_assets\.served_key IS NOT NULL\)/,
    )
  })
})
