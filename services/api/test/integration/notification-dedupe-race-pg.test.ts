import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"

const pg = await withPg()

const CONCURRENT_WRITERS = 5
const DEDUPE_WINDOW_MS = 10 * 60 * 1000

describe.skipIf(!pg)("deduped notifications under concurrent writers (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  it("concurrent writers of one dedupe key leave ONE row", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const [user] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Dedupe Race', ${testHandle()}) RETURNING id
    `
    const userId = user!.id
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS)

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_WRITERS }, () =>
        repo.insertUnlessRecentDuplicate({
          userId,
          type: "system",
          title: "Heads up",
          body: "The meeting point moved",
          link: null,
          since,
        }),
      ),
    )

    const rows = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM notifications WHERE user_id = ${userId}
    `
    expect(rows[0]!.n).toBe("1")
    expect(results.filter((r) => !r.deduped)).toHaveLength(1)
  })
})
