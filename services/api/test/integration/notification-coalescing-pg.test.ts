
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"

const pg = await withPg()

describe.skipIf(!pg)("notification coalescing (integration)", () => {
  let h: PgHarness

  beforeAll(() => {
    h = pg as PgHarness
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  const LINK = "/messages/group/11111111-1111-1111-1111-111111111111"

  it("refreshes the unread bell in place and never inserts a second row inside the window", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userId = await newUser("Coalesce One")

    await repo.insertNotification({
      userId,
      type: "group_chat",
      title: "Dana",
      body: "first",
      link: LINK,
    })

    const refreshed = await repo.refreshUnreadNotification({
      userId,
      type: "group_chat",
      link: LINK,
      title: "Rae",
      body: "second",
      since: new Date(Date.now() - 10 * 60 * 1000),
    })

    expect(refreshed).not.toBeNull()
    expect(refreshed!.title).toBe("Rae")
    expect(refreshed!.body).toBe("second")
    const rows = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM notifications WHERE user_id = ${userId} AND link = ${LINK}
    `
    expect(rows[0]!.n).toBe("1")
  })

  it("does NOT refresh a bell the recipient already read: opening the room lets the next message ring", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userId = await newUser("Coalesce Read")

    await repo.insertNotification({ userId, type: "group_chat", title: "Dana", body: "a", link: LINK })
    await repo.clearByTypeAndLink(userId, "group_chat", LINK)

    const refreshed = await repo.refreshUnreadNotification({
      userId,
      type: "group_chat",
      link: LINK,
      title: "Rae",
      body: "b",
      since: new Date(Date.now() - 10 * 60 * 1000),
    })
    expect(refreshed).toBeNull()
  })

  it("does NOT refresh a bell older than the window (the window is anchored, not sliding)", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userId = await newUser("Coalesce Window")

    const created = await repo.insertNotification({
      userId,
      type: "group_chat",
      title: "Dana",
      body: "a",
      link: LINK,
    })
    await h.sql`
      UPDATE notifications SET created_at = now() - interval '20 minutes' WHERE id = ${created.id}
    `

    const refreshed = await repo.refreshUnreadNotification({
      userId,
      type: "group_chat",
      link: LINK,
      title: "Rae",
      body: "b",
      since: new Date(Date.now() - 10 * 60 * 1000),
    })
    expect(refreshed).toBeNull()
  })

  it("upsertCoalescedNotification inserts once and then refreshes IN ONE TRANSACTION", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userId = await newUser("Coalesce Upsert")
    const since = (): Date => new Date(Date.now() - 10 * 60 * 1000)

    const first = await repo.upsertCoalescedNotification({
      userId,
      type: "group_chat",
      link: LINK,
      title: "Dana",
      body: "first",
      since: since(),
    })
    expect(first.coalesced).toBe(false)

    const second = await repo.upsertCoalescedNotification({
      userId,
      type: "group_chat",
      link: LINK,
      title: "Rae",
      body: "second",
      since: since(),
    })
    expect(second.coalesced).toBe(true)
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.body).toBe("second")

    const rows = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM notifications WHERE user_id = ${userId} AND link = ${LINK}
    `
    expect(rows[0]!.n).toBe("1")
  })

  it("concurrent upserts for the same recipient converge on ONE unread row", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const userId = await newUser("Coalesce Race")
    const args = (title: string) => ({
      userId,
      type: "group_chat" as const,
      link: LINK,
      title,
      body: title,
      since: new Date(Date.now() - 10 * 60 * 1000),
    })

    await repo.upsertCoalescedNotification(args("seed"))
    await Promise.all([
      repo.upsertCoalescedNotification(args("a")),
      repo.upsertCoalescedNotification(args("b")),
      repo.upsertCoalescedNotification(args("c")),
    ])

    const rows = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM notifications
      WHERE user_id = ${userId} AND link = ${LINK} AND read_at IS NULL
    `
    expect(rows[0]!.n).toBe("1")
  })

  it("findUserLocaleMany answers the whole recipient set in one query", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const a = await newUser("Locale A")
    const b = await newUser("Locale B")
    await h.sql`UPDATE users SET locale = 'es' WHERE id = ${a}`

    const locales = await repo.findUserLocaleMany!([a, b])
    expect(locales.get(a)).toBe("es")
    expect(locales.get(b)).toBe("en")
  })

  it("is scoped to the recipient, the type and the room link", async () => {
    const repo = makeDrizzleNotificationRepository(h.sql)
    const mine = await newUser("Coalesce Mine")
    const theirs = await newUser("Coalesce Theirs")
    const since = new Date(Date.now() - 10 * 60 * 1000)

    await repo.insertNotification({ userId: mine, type: "group_chat", title: "D", body: "a", link: LINK })

    expect(
      await repo.refreshUnreadNotification({
        userId: theirs,
        type: "group_chat",
        link: LINK,
        title: "X",
        body: "x",
        since,
      }),
    ).toBeNull()
    expect(
      await repo.refreshUnreadNotification({
        userId: mine,
        type: "report_chat",
        link: LINK,
        title: "X",
        body: "x",
        since,
      }),
    ).toBeNull()
    expect(
      await repo.refreshUnreadNotification({
        userId: mine,
        type: "group_chat",
        link: "/messages/group/other",
        title: "X",
        body: "x",
        since,
      }),
    ).toBeNull()
  })
})
