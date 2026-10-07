import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"

const pg = await withPg()

const LINK = "/messages/group/22222222-2222-2222-2222-222222222222"
const CONCURRENT_WRITERS = 5

describe.skipIf(!pg)("notification coalescing with no unread row yet (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("concurrent first upserts converge on ONE unread row instead of one per writer", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Coalesce First', ${testHandle()}) RETURNING id
    `
    const userId = user!.id
    const since = new Date(Date.now() - 10 * 60 * 1000)

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_WRITERS }, (_, i) =>
        repo.upsertCoalescedNotification({
          userId,
          type: "group_chat",
          link: LINK,
          title: `writer ${i}`,
          body: `writer ${i}`,
          since,
        }),
      ),
    )

    const rows = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM notifications
      WHERE user_id = ${userId} AND link = ${LINK} AND read_at IS NULL
    `
    expect(rows[0]!.n).toBe("1")
    expect(results.filter((r) => !r.coalesced)).toHaveLength(1)
  })
})
