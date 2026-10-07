import { describe, expect, it } from "vitest"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"
import { purgeDemo } from "../../src/db/seed-demo-la.js"
import type { TransactionSql } from "../../src/db/client.js"

const REAL_USER = "11111111-1111-1111-1111-111111111111"
const REAL_POST = "22222222-2222-2222-2222-222222222222"

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim()
}

async function runPurge(handlers: SqlHandler[]) {
  const fake = makeFakeSql(handlers)
  const result = await purgeDemo(fake.sql as unknown as TransactionSql).then(
    (counts) => ({ counts, error: null as Error | null }),
    (error: Error) => ({ counts: null, error }),
  )
  return { ...result, statements: fake.statements.map((s) => flat(s.sql)) }
}

describe("seed-demo-la purge", () => {
  it("refuses, before deleting anything, when real content depends on demo posts or events", async () => {
    const { error, statements } = await runPurge([
      { match: /FROM volunteer_hours vh/, rows: [{ kind: "post", id: REAL_POST }] },
    ])
    expect(error?.message).toContain(REAL_POST)
    expect(statements.some((s) => s.startsWith("DELETE"))).toBe(false)
  })

  it("recomputes the counters of real users and posts that interacted with demo accounts", async () => {
    const { error, statements } = await runPurge([
      { match: /SELECT f\.follower_id AS id FROM follows_people/, rows: [{ id: REAL_USER }] },
      { match: /FROM post_likes l WHERE l\.user_id/, rows: [{ id: REAL_POST }] },
    ])
    expect(error).toBeNull()
    const lastDelete = statements.map((s) => s.startsWith("DELETE FROM users")).lastIndexOf(true)
    const userFix = statements.findIndex((s) => s.startsWith("UPDATE users u SET follower_count"))
    const postFix = statements.findIndex((s) => s.startsWith("UPDATE posts p SET like_count"))
    expect(userFix).toBeGreaterThan(lastDelete)
    expect(postFix).toBeGreaterThan(lastDelete)
    expect(statements[userFix]).toContain(
      "following_count = (SELECT count(*) FROM follows_people f WHERE f.follower_id = u.id)",
    )
    expect(statements[postFix]).toContain(
      "repost_count = (SELECT count(*) FROM posts c WHERE c.repost_of_id = p.id AND c.kind = 'repost' AND c.deleted_at IS NULL)",
    )
  })
})
