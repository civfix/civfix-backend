/**
 * Consumer keyset paging over rows that share one transaction's now() (Docker-gated; CI runs it). A cursor
 * built from the driver's millisecond Date skipped the rest of that instant on a newest-first list.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"

const pg = await withPg()

const ROWS_IN_ONE_TX = 3
const PAGE_GUARD = 10

describe.skipIf(!pg)("consumer keyset cursors keep microsecond precision (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("the notification feed pages through every row of one transaction exactly once", async () => {
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Keyset Burst', ${testHandle()}) RETURNING id
    `
    const userId = user!.id
    const written = await h.sql.begin(async (tx) => {
      const ids: string[] = []
      for (let i = 0; i < ROWS_IN_ONE_TX; i++) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO notifications (user_id, type, title, body, link)
          VALUES (${userId}, 'site', ${`burst ${i}`}, ${`burst ${i}`}, null)
          RETURNING id
        `
        ids.push(row!.id)
      }
      return ids
    })
    const stamps = await h.sql<{ n: number }[]>`
      SELECT count(DISTINCT created_at)::int AS n FROM notifications WHERE user_id = ${userId}
    `
    expect(stamps[0]!.n).toBe(1)

    const repo = makeDrizzleNotificationRepository(h.sql)
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < PAGE_GUARD; page++) {
      const res = await repo.listNotifications(userId, cursor, 1)
      seen.push(...res.records.map((r) => r.id))
      cursor = res.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(seen).toHaveLength(ROWS_IN_ONE_TX)
    expect(new Set(seen)).toEqual(new Set(written))
  })
})
