import { describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import { requireRow } from "../../src/db/rows.js"
import { firstNonEmpty } from "../../src/lib/text.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleThreadsRepository } from "../../src/services/threads-repository.drizzle.js"
import { makeFakeSql, type SqlHandler } from "../helpers/fake-sql.js"

const ROOM = "44444444-4444-4444-8444-444444444444"
const MESSAGE = "55555555-5555-4555-8555-555555555555"
const VIEWER = "33333333-3333-4333-8333-333333333333"
const AT = new Date("2026-09-01T00:00:00.000Z")

function fakeSql(handlers: SqlHandler[]): Sql {
  return makeFakeSql(handlers).sql as unknown as Sql
}

describe("requireRow", () => {
  it("returns the first row", () => {
    expect(requireRow([{ id: "a" }, { id: "b" }], "lookup")).toEqual({ id: "a" })
  })

  it("names the query when a row that must exist is missing", () => {
    expect(() => requireRow([], "notification insert")).toThrow(
      "notification insert: expected a row, got none",
    )
  })
})

describe("firstNonEmpty", () => {
  it("skips null, undefined and empty strings, keeping whitespace-only text", () => {
    expect(firstNonEmpty(undefined, null, "", " ", "b")).toBe(" ")
    expect(firstNonEmpty(undefined, "", null)).toBeUndefined()
  })
})

describe("a cleanup chat row with no sender", () => {
  const senderlessRow = {
    id: MESSAGE,
    cleanup_id: ROOM,
    report_id: null,
    group_id: null,
    sender_id: null,
    body: "hello",
    kind: "text",
    attachments: [],
    created_at: AT,
    edited_at: null,
    deleted_at: null,
    reply_to_id: null,
    pinned_at: null,
    system_status: null,
    system_kind: null,
    system_body: null,
    sender_display_name: null,
    sender_handle: null,
    sender_bio: null,
    sender_avatar_url: null,
    sender_avatar_media_status: null,
    sender_avatar_served_key: null,
    sender_avatar_thumb_key: null,
    sender_deleted_at: null,
  }

  it("fails loudly instead of emitting a message whose author id is null", async () => {
    const repo = makeDrizzleChatRepository(
      fakeSql([{ match: /FROM chat_messages cm\s+LEFT JOIN users u/, rows: [senderlessRow] }]),
    )
    await expect(repo.findMessage(ROOM, MESSAGE, VIEWER)).rejects.toThrow(
      `chat message ${MESSAGE}: a user message needs a room and a sender`,
    )
  })

  it("leaves the thread list without a last-message preview rather than a null sender", async () => {
    const repo = makeDrizzleThreadsRepository(
      fakeSql([
        {
          match: /FROM chat_messages cm/,
          rows: [
            {
              room_id: ROOM,
              title: "Saturday cleanup",
              joined_at: AT,
              members: 3,
              unread: 0,
              last_body: "hello",
              last_created_at: AT,
              last_sender_id: null,
            },
          ],
        },
      ]),
    )
    const [thread] = await repo.listThreadsFor(VIEWER, 10)
    expect(thread).toMatchObject({ cleanupId: ROOM, last: null })
  })
})
