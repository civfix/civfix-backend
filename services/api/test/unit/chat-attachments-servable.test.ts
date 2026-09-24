/**
 * ISSUE #122 ("photo send in messages is bugged").
 *
 * `attach()` deliberately ACCEPTS a finalized-but-still-`validating` asset, because that is the only
 * state an asset is ever in at send time: `finalizeMedia` returns `{ status: "validating" }` and hands
 * the flip to `ready` to the media worker. The READ used to require `status = 'ready' AND served_key IS
 * NOT NULL`, so the WS ack and every history page came back with `attachments: []` and the client threw
 * its optimistic local attachment away on reconcile: a photo-only message rendered as an empty row.
 *
 * The reports path solved this long ago with `servedKeyExpr` / `servableMediaFilter`
 * (report-repository.drizzle.ts). These tests pin that chat now uses the same two fragments.
 */

import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import { evalSqlPredicate } from "../helpers/sql-predicate.js"
import type { Queryable } from "../../src/db/client.js"
import {
  loadServableAttachmentsFor,
  makeAttachmentRepo,
} from "../../src/services/message-attachments-repository.drizzle.js"

const MESSAGE = "11111111-1111-4111-8111-111111111111"
const OTHER_MESSAGE = "22222222-2222-4222-8222-222222222222"
const SENDER = "33333333-3333-4333-8333-333333333333"
const UPLOAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

const PRESIGN = (r2Key: string, thumbKey: string | null) =>
  Promise.resolve({
    url: `memory://${r2Key}`,
    ...(thumbKey !== null ? { thumbUrl: `memory://${thumbKey}` } : {}),
  })

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
      SENDER,
    )

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(/COALESCE\(media_assets\.served_key/)
    expect(statement.sql).toMatch(/media_assets\.r2_key/)
  })

  it("admits a validating asset without admitting every non-ready status", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])

    await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
      SENDER,
    )

    const statement = fake.statements.at(-1)!
    expect(statement.sql).toMatch(
      /media_assets\.status = 'validating' OR \(media_assets\.status = 'ready' AND media_assets\.served_key IS NOT NULL\)/,
    )
    expect(statement.sql).not.toMatch(/status <> 'ready'/)
  })

  it("quarantines held and rejected attachments and serves validating and ready ones", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])

    await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
      SENDER,
    )

    const predicate = /AND (\(media_assets\.status = 'validating'[^\n]*?IS NOT NULL\)\))/.exec(
      fake.statements.at(-1)!.sql,
    )?.[1]
    expect(predicate).toBeDefined()
    const servable = (status: string, servedKey: string | null): boolean =>
      evalSqlPredicate(predicate as string, {
        status,
        served_key: servedKey,
        r2_key: "chat/one.jpg",
      })

    expect(servable("validating", null)).toBe(true)
    expect(servable("ready", "chat/one.jpg.served")).toBe(true)
    expect(servable("ready", null)).toBe(false)
    expect(servable("held", "chat/one.jpg.served")).toBe(false)
    expect(servable("held", null)).toBe(false)
    expect(servable("rejected", null)).toBe(false)
  })

  it("falls back to the raw upload key only while the asset is validating", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [] }])

    await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
      SENDER,
    )

    expect(fake.statements.at(-1)!.sql).toMatch(
      /COALESCE\(media_assets\.served_key, CASE WHEN media_assets\.status = 'validating' THEN media_assets\.r2_key END\)/,
    )
  })

  it("returns the still-validating attachment with its status intact so the client can render it", async () => {
    const fake = makeFakeSql([{ match: /FROM media_assets/, rows: [row()] }])

    const byMessage = await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE],
      PRESIGN,
      SENDER,
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
          row({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            message_id: OTHER_MESSAGE,
            status: "ready",
          }),
        ],
      },
    ])

    const byMessage = await loadServableAttachmentsFor(
      fake.sql as unknown as Queryable,
      "chat_message_id",
      [MESSAGE, OTHER_MESSAGE],
      PRESIGN,
      SENDER,
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
      SENDER,
    )

    expect(byMessage.size).toBe(0)
    expect(fake.statements).toHaveLength(0)
  })
})

describe("makeAttachmentRepo().attach", () => {
  it("still claims a finalized validating asset: the read now matches what the claim accepts", async () => {
    const fake = makeFakeSql([{ match: /UPDATE media_assets/, rows: [{ upload_id: UPLOAD }] }])

    await makeAttachmentRepo("chat_message_id").attach(
      fake.sql as unknown as Queryable,
      MESSAGE,
      [UPLOAD],
      new Date("2026-09-16T00:00:00.000Z"),
      SENDER,
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
      SENDER,
    )

    expect(fake.statements).toHaveLength(0)
  })
})
