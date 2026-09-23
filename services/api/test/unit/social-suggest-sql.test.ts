import { describe, it, expect } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import {
  makeDrizzleSocialRepository,
  SUGGEST_CANDIDATE_POOL,
  SUGGEST_CANDIDATE_RADIUS_DEG,
} from "../../src/services/social-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const VIEWER = "11111111-1111-1111-1111-111111111111"

async function emittedStatement(): Promise<{ sql: string; values: unknown[] }> {
  const fake = makeFakeSql()
  const repo = makeDrizzleSocialRepository(fake.sql as unknown as Sql)
  await repo.suggestFollows({ viewerId: VIEWER, limit: 10 })
  const stmt = fake.statements[0]
  expect(stmt, "suggestFollows should emit exactly one statement").toBeDefined()
  expect(fake.statements).toHaveLength(1)
  return stmt!
}

function nearPoolLateralBody(sql: string): string {
  const open = sql.indexOf("CROSS JOIN LATERAL (")
  expect(open, "near_pool must be a CROSS JOIN LATERAL").toBeGreaterThan(-1)
  const from = open + "CROSS JOIN LATERAL (".length
  let depth = 1
  for (let i = from; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "(") depth += 1
    else if (ch === ")") {
      depth -= 1
      if (depth === 0) return sql.slice(from, i)
    }
  }
  throw new Error("unbalanced parentheses in the near_pool lateral")
}

describe("suggestFollows: the nearby pool is KNN-bounded", () => {
  it("emits ONE statement, with the whole query inlined rather than bound as a parameter", async () => {
    const stmt = await emittedStatement()
    expect(stmt.sql).toContain("WITH viewer_point AS")
    expect(stmt.sql).toContain("near_pool AS")
    expect(stmt.sql).toContain("recent_pool AS")
    expect(stmt.sql).toContain("new_pool AS")
    expect(stmt.sql.trim()).not.toBe("?")
  })

  it("puts the KNN ORDER BY and the LIMIT INSIDE the lateral, not beside a same-level CTE Var", async () => {
    const stmt = await emittedStatement()
    const body = nearPoolLateralBody(stmt.sql)

    expect(body).toContain("FROM users u")
    expect(body).toContain("ORDER BY u.last_activity_geom <-> vp.geom")
    expect(body).toContain("LIMIT ?")
    expect(body).toContain("ST_DWithin(u.last_activity_geom, vp.geom, ?)")

    expect(stmt.sql).not.toMatch(/FROM\s+users\s+u\s*,\s*viewer_point/)
    expect(stmt.sql.split("<->")).toHaveLength(2)
  })

  it("keeps the eligibility predicate inside the lateral, before its LIMIT", async () => {
    const body = nearPoolLateralBody((await emittedStatement()).sql)
    const orderBy = body.indexOf("ORDER BY")
    expect(body.indexOf("follows_people"), "follow filter inside the pool").toBeGreaterThan(-1)
    expect(body.indexOf("user_blocks"), "block filter inside the pool").toBeGreaterThan(-1)
    expect(body.indexOf("follows_people")).toBeLessThan(orderBy)
    expect(body.indexOf("user_blocks")).toBeLessThan(orderBy)
  })

  it("binds the viewer id, the radius and the pool cap as parameters", async () => {
    const stmt = await emittedStatement()
    expect(stmt.values).toContain(VIEWER)
    expect(stmt.values).toContain(SUGGEST_CANDIDATE_RADIUS_DEG)
    expect(stmt.values.filter((v) => v === SUGGEST_CANDIDATE_POOL)).toHaveLength(3)
    expect(stmt.values).toContain(10)
  })
})
