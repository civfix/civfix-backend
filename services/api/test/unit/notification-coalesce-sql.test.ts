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
