/**
 * ISSUE #122 ("photo send in messages is bugged").
 *
 * `attach()` deliberately ACCEPTS a finalized-but-still-`validating` asset, because that is the only
 * state an asset is ever in at send time: `finalizeMedia` returns `{ status: "validating" }` and hands
 * the flip to `ready` to the media worker. The READ used to require `status = 'ready' AND served_key IS
 * NOT NULL`, so the WS ack and every history page came back with `attachments: []` and the client threw
 * its optimistic local attachment away on reconcile — a photo-only message rendered as an empty row.
 *
 * The reports path solved this long ago with `servedKeyExpr` / `servableMediaFilter`
 * (report-repository.drizzle.ts). These tests pin that chat now uses the same two fragments.
 */

import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import type { Queryable } from "../../src/db/client.js"
import {
  loadServableAttachmentsFor,
  makeAttachmentRepo,
} from "../../src/services/message-attachments.drizzle.js"

const MESSAGE = "11111111-1111-4111-8111-111111111111"
const OTHER_MESSAGE = "22222222-2222-4222-8222-222222222222"

const PRESIGN = (r2Key: string, thumbKey: string | null) =>
  Promise.resolve({ url: `memory://${r2Key}`, ...(thumbKey !== null ? { thumbUrl: `memory://${thumbKey}` } : {}) })

function row(over: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    message_id: MESSAGE,
    kind: "photo",
    codec: null,
    r2_key: "chat/one.jpg",
    thumb_key: null,
    status: "validating",
    width: 100,
    height: 200,
    ...over,
  }
}

describe("loadServableAttachmentsFor", () => {
  it("selects the servable key expression, not the bare served_key column", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])

    await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
    )

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(/COALESCE\(media_assets\.served_key/)
    expect(statement.sql).toMatch(/media_assets\.r2_key/)
  })

  it("no longer filters on status = 'ready': a validating asset is servable", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])

    await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
    )

    const statement = fake.statements.at(-1)!
    expect(statement.sql).not.toMatch(/status = 'ready'/)
    expect(statement.sql).toMatch(/media_assets\.status <> 'ready' OR media_assets\.served_key IS NOT NULL/)
  })

  it("returns the still-validating attachment with its status intact so the client can render it", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [row()] }])

    const byMessage = await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
    )

    expect(byMessage.get(MESSAGE)).toEqual([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "photo",
        codec: null,
        url: "memory://chat/one.jpg",
        width: 100,
        height: 200,
        status: "validating",
      },
    ])
  })

  it("groups several messages' attachments by message id", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM media_assets/,
        rows: [
          row(),
          row({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", message_id: OTHER_MESSAGE, status: "ready" }),
        ],
      },
    ])

    const byMessage = await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE, OTHER_MESSAGE],
      PRESIGN,
    )

    expect(byMessage.get(MESSAGE)).toHaveLength(1)
    expect(byMessage.get(OTHER_MESSAGE)?.[0]?.status).toBe("ready")
  })

  it("short-circuits on an empty id list without touching the database", async () => {
    const fake = makeFakeSql([])

    const byMessage = await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [],
      PRESIGN,
    )

    expect(byMessage.size).toBe(0)
    expect(fake.statements).toHaveLength(0)
  })
})

describe("makeAttachmentRepo().attach", () => {
  it("still claims a finalized validating asset — the read now matches what the claim accepts", async () => {
    const fake = makeFakeSql([{ match: /UPDATE media_assets/, rows: [] }])

    await makeAttachmentRepo("chat_message_id").attach(
      fake.sql as unknown as Queryable,
      MESSAGE,
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
      new Date("2026-09-16T00:00:00.000Z"),
    )

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(
      /status = 'ready' OR \(status = 'validating' AND finalized_at IS NOT NULL\)/,
    )
  })

  it("does nothing when no upload ids were sent", async () => {
    const fake = makeFakeSql([])

    await makeAttachmentRepo("chat_message_id").attach(
      fake.sql as unknown as Queryable,
      MESSAGE,
      [],
      new Date(),
    )

    expect(fake.statements).toHaveLength(0)
  })
})
