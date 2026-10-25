import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { NotificationTypeSchema, type NotificationType } from "@civfix/contract"
import { FEED_HIDDEN_NOTIFICATION_TYPES } from "../../src/services/notification-service.js"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import {
  explainHasUnread,
  explainMarkAllRead,
  makeDrizzleNotificationRepository,
  UNREAD_PAGE_INDEX,
} from "../../src/services/notification-repository.drizzle.js"
import type { NotificationRepository } from "../../src/services/notification-repository.js"
import type { Queryable } from "../../src/db/client.js"

/**
 * The inbox statements of the Drizzle notification repository against PostGIS: unread, read-all,
 * dismiss, mark read by id and clear-on-open, plus the plans of the two statements D4's out-of-band
 * partial index exists for. The route side is test/unit/notification-inbox-routes.test.ts.
 */

const pg = await withPg()

const R = new Date("2026-10-01T12:00:00.000Z")

describe.skipIf(!pg)("notification inbox (integration)", () => {
  let h: PgHarness
  let repo: NotificationRepository

  beforeAll(() => {
    h = pg as PgHarness
    repo = makeDrizzleNotificationRepository(h.sql)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES ('Inbox', ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  async function row(
    userId: string,
    type: NotificationType,
    opts: { readAt?: Date; link?: string } = {},
  ): Promise<string> {
    const [n] = await h.sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title, link, read_at)
      VALUES (${userId}, ${type}, ${type}, ${opts.link ?? null}, ${opts.readAt ?? null})
      RETURNING id
    `
    return n!.id
  }

  async function readAtOf(id: string): Promise<Date | null | undefined> {
    const rows = await h.sql<{ read_at: Date | null }[]>`
      SELECT read_at FROM notifications WHERE id = ${id}
    `
    return rows[0]?.read_at
  }

  async function exists(id: string): Promise<boolean> {
    const rows = await h.sql`SELECT 1 FROM notifications WHERE id = ${id}`
    return rows.length === 1
  }

  describe("plans", () => {
    beforeAll(async () => {
      await h.sql`
        CREATE INDEX IF NOT EXISTS notifications_user_unread_page_idx
          ON notifications (user_id)
          WHERE read_at IS NULL AND type <> ALL (ARRAY['dm','cleanup_chat','group_chat','report_chat'])
      `
      // Unread chat rows sit in notifications_user_unread_idx but not in the page index, so the page
      // index is the cheaper of the two for a plan to pick.
      const busy = await newUser()
      await h.sql`
        INSERT INTO notifications (user_id, type, title)
        SELECT ${busy}, 'dm', 'dm ' || g FROM generate_series(1, 500) AS g
      `
      await row(busy, "new_follower")
      await h.sql`ANALYZE notifications`
    })

    async function planOf(explain: (tx: Queryable) => Promise<string>): Promise<string> {
      return h.sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`
        await tx`SET LOCAL enable_bitmapscan = off`
        return explain(tx)
      })
    }

    it("T8: the unread statement uses the page index", async () => {
      const userId = randomUUID()
      const plan = await planOf((tx) => explainHasUnread(tx, userId))
      expect(plan, plan).toContain(UNREAD_PAGE_INDEX)
      expect(UNREAD_PAGE_INDEX).toBe("notifications_user_unread_page_idx")
    })

    it("T15: the read-all UPDATE uses the page index", async () => {
      const userId = randomUUID()
      const plan = await planOf((tx) => explainMarkAllRead(tx, userId))
      expect(plan, plan).toContain(UNREAD_PAGE_INDEX)
    })
  })

  it("T9: unread is true for an unread page row, false once it is read and for a chat row", async () => {
    const a = await newUser()
    const n = await row(a, "new_follower")
    expect(await repo.hasUnread(a)).toBe(true)
    await h.sql`UPDATE notifications SET read_at = now() WHERE id = ${n}`
    expect(await repo.hasUnread(a)).toBe(false)

    const c = await newUser()
    await row(c, "dm")
    expect(await repo.hasUnread(c)).toBe(false)
  })

  it("unread and read-all hide exactly FEED_HIDDEN_NOTIFICATION_TYPES, the page's own list", async () => {
    for (const type of NotificationTypeSchema.options) {
      const listed = !FEED_HIDDEN_NOTIFICATION_TYPES.includes(type)
      const a = await newUser()
      await row(a, type)
      expect(await repo.hasUnread(a), type).toBe(listed)
      expect(await repo.markAllRead(a), type).toBe(listed ? 1 : 0)
    }
  })

  it("T16: read-all marks only the caller's unread page rows and reports how many changed", async () => {
    const a = await newUser()
    const b = await newUser()
    const follower = await row(a, "new_follower")
    const mention = await row(a, "chat_mention")
    const group = await row(a, "group_chat")
    const others = await row(b, "new_follower")

    expect(await repo.markAllRead(a)).toBe(2)
    expect(await readAtOf(follower)).not.toBeNull()
    expect(await readAtOf(mention)).not.toBeNull()
    expect(await readAtOf(group)).toBeNull()
    expect(await readAtOf(others)).toBeNull()
    expect(await repo.markAllRead(a)).toBe(0)
  })

  it("T26: dismiss deletes only the caller's row", async () => {
    const a = await newUser()
    const b = await newUser()
    const n = await row(a, "post_like")
    const m = await row(b, "post_like")

    expect(await repo.deleteNotification(a, n)).toBe(true)
    expect(await exists(n)).toBe(false)
    expect(await repo.deleteNotification(a, m)).toBe(false)
    expect(await exists(m)).toBe(true)
    expect(await repo.deleteNotification(a, n)).toBe(false)
  })

  it("T32: markRead returns the ids it changed", async () => {
    const a = await newUser()
    const b = await newUser()
    const x = await row(a, "new_follower")
    const y = await row(a, "post_like", { readAt: R })
    const z = await row(b, "new_follower")

    expect(await repo.markRead(a, [x, y, z])).toEqual([x])
    expect(await repo.markRead(a, [x, y, z])).toEqual([])
    expect(await readAtOf(z)).toBeNull()
  })

  it("T36: clearByTypeAndLink returns the room's bell and mention ids it changed", async () => {
    const a = await newUser()
    const G = randomUUID()
    const H = randomUUID()
    const g1 = await row(a, "group_chat", { link: `/messages/group/${G}` })
    const m1 = await row(a, "chat_mention", { link: `/messages/group/${G}` })
    const m2 = await row(a, "chat_mention", { link: `/messages/group/${H}` })
    await row(a, "group_chat", { link: `/messages/group/${G}`, readAt: R })

    const first = await repo.clearByTypeAndLink(a, "group_chat", `/messages/group/${G}`)
    expect([...first].sort()).toEqual([g1, m1].sort())
    expect(await repo.clearByTypeAndLink(a, "group_chat", `/messages/group/${G}`)).toEqual([])
    expect(await readAtOf(m2)).toBeNull()
  })
})
