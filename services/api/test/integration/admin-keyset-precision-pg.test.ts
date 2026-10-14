/**
 * Admin keyset paging over rows that share one transaction's now() (Docker-gated; CI runs it). A cursor
 * built from the driver's millisecond Date skipped the rest of that instant on a DESC list and repeated the
 * previous page's last row forever on an ASC list.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { withPg, type PgHarness } from "../helpers/pg.js"
import {
  insertAuditRow,
  makeDrizzleAuditRepository,
} from "../../src/services/admin/audit-repository.drizzle.js"
import { makeDrizzleActivityRepository } from "../../src/services/admin/activity-repository.drizzle.js"

const pg = await withPg()

const ROWS_IN_ONE_TX = 3
const PAGE_GUARD = 10

async function writeBurst(h: PgHarness): Promise<void> {
  await h.sql.begin(async (tx) => {
    for (let i = 0; i < ROWS_IN_ONE_TX; i++) {
      await insertAuditRow(tx, { actorId: null, action: "user.banned", target: `user:${i}` })
    }
  })
}

describe.skipIf(!pg)("admin keyset cursors keep microsecond precision (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  beforeEach(async () => {
    await h.sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
    await writeBurst(h)
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("the audit log pages through every row of one transaction, newest first", async () => {
    const repo = makeDrizzleAuditRepository(h.sql)
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < PAGE_GUARD; page++) {
      const res = await repo.list({ actor: null, action: null, target: null, cursor, limit: 1 })
      seen.push(...res.records.map((r) => r.id))
      cursor = res.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(new Set(seen).size).toBe(ROWS_IN_ONE_TX)
    expect(seen).toHaveLength(ROWS_IN_ONE_TX)
  })

  it("the activity feed pages oldest-first without repeating a row or looping", async () => {
    const repo = makeDrizzleActivityRepository(h.sql)
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < PAGE_GUARD; page++) {
      const res = await repo.list({ q: null, filter: "all", sort: "oldest", cursor, limit: 1 })
      seen.push(...res.records.filter((r) => r.source === "audit").map((r) => r.id))
      cursor = res.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(seen).toHaveLength(ROWS_IN_ONE_TX)
    expect(new Set(seen).size).toBe(ROWS_IN_ONE_TX)
  })
})
