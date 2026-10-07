import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { makeDrizzleNotificationRepository } from "../../src/services/notification-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const USER = "11111111-1111-1111-1111-111111111111"

describe("coalesced notifications serialize writers of the same thread", () => {
  it("locks the (user, type, link) key before looking for the unread row it would refresh", async () => {
    const fake = makeFakeSql([
      {
        match: /INSERT INTO notifications/,
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            user_id: USER,
            type: "cleanup_chat",
            title: "New messages",
            body: "3 new messages",
            link: "/cleanups/abc/chat",
            read_at: null,
            created_at: new Date("2026-09-01T00:01:00.000Z"),
          },
        ],
      },
    ])
    await makeDrizzleNotificationRepository(fake.sql as unknown as Sql).upsertCoalescedNotification(
      {
        userId: USER,
        type: "cleanup_chat",
        link: "/cleanups/abc/chat",
        title: "New messages",
        body: "3 new messages",
        since: new Date("2026-09-01T00:00:00.000Z"),
      },
    )

    const [lock, refresh, insert] = fake.statements
    expect(lock?.sql).toMatch(/pg_advisory_xact_lock\(\s*hashtext\(/)
    expect(lock?.values).toEqual([USER, "cleanup_chat", "/cleanups/abc/chat"])
    expect(refresh?.sql).toMatch(/UPDATE notifications/)
    expect(insert?.sql).toMatch(/INSERT INTO notifications/)
  })
})

describe("deduped notifications serialize writers of the same key", () => {
  const since = new Date("2026-09-01T00:00:00.000Z")
  const row = {
    id: "33333333-3333-3333-3333-333333333333",
    user_id: USER,
    type: "system",
    title: "Heads up",
    body: "The route changed",
    link: null,
    read_at: null,
    created_at: new Date("2026-09-01T00:01:00.000Z"),
  }

  it("locks the (user, type, link) key, looks for the duplicate, then inserts in one transaction", async () => {
    const fake = makeFakeSql([{ match: /INSERT INTO notifications/, rows: [row] }])
    const result = await makeDrizzleNotificationRepository(
      fake.sql as unknown as Sql,
    ).insertUnlessRecentDuplicate({
      userId: USER,
      type: "system",
      link: null,
      title: "Heads up",
      body: "The route changed",
      since,
    })

    const [lock, find, insert] = fake.statements
    expect(lock?.sql).toMatch(/pg_advisory_xact_lock\(\s*hashtext\(/)
    expect(lock?.sql).toMatch(/COALESCE\(\?::text, ''\)/)
    expect(lock?.values).toEqual([USER, "system", null])
    expect(find?.sql).toMatch(/SELECT[\s\S]*FROM notifications[\s\S]*created_at > \?/)
    expect(find?.sql).toMatch(/body IS NOT DISTINCT FROM \?/)
    expect(insert?.sql).toMatch(/INSERT INTO notifications/)
    expect(result.deduped).toBe(false)
    expect(result.record.id).toBe(row.id)
  })

  it("returns the recent duplicate without inserting a second row", async () => {
    const fake = makeFakeSql([{ match: /FROM notifications/, rows: [row] }])
    const result = await makeDrizzleNotificationRepository(
      fake.sql as unknown as Sql,
    ).insertUnlessRecentDuplicate({
      userId: USER,
      type: "system",
      link: null,
      title: "Heads up",
      body: "The route changed",
      since,
    })

    expect(result).toMatchObject({ deduped: true, record: { id: row.id } })
    expect(fake.statements.some((s) => /INSERT INTO notifications/.test(s.sql))).toBe(false)
  })
})
