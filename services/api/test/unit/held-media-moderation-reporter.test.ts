import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/postgres-js"
import type { Db, Sql } from "../../src/db/client.js"
import { makeDrizzleMediaWorkerRepo } from "../../src/services/media-worker-repo.js"

const REPORT_ID = "22222222-2222-2222-2222-222222222222"
const REPORTER_ID = "33333333-3333-3333-3333-333333333333"

interface Call {
  query: string
  params: unknown[]
}

function stubDb(contextRow: unknown[]) {
  const calls: Call[] = []
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      calls.push({ query, params })
      const rows = /from "reports"/.test(query) ? [contextRow] : []
      return Object.assign(Promise.resolve([]), { values: () => Promise.resolve(rows) })
    },
  }
  const db = drizzle(client as never) as unknown as Db
  return { db, calls }
}

function insertedMeta(calls: Call[]): Record<string, unknown> {
  const insert = calls.find((c) => /insert into "moderation_items"/.test(c.query))
  if (!insert) throw new Error("no moderation_items insert was sent")
  const json = insert.params.find((p) => typeof p === "string" && p.includes('"reporter"'))
  return JSON.parse(json as string) as Record<string, unknown>
}

describe("held-media moderation item names its reporter", () => {
  it("shows a signed-in reporter's display name and links their account", async () => {
    const { db, calls } = stubDb(["trash", "Pile of bags", "Los Angeles", "Dana R", REPORTER_ID])
    const repo = makeDrizzleMediaWorkerRepo(db, {} as Sql)

    await repo.enqueueHeldModerationItem!({
      reportId: REPORT_ID,
      reason: "NSFW model over threshold",
    })

    expect(insertedMeta(calls)).toMatchObject({ reporter: "Dana R", reporterUserId: REPORTER_ID })
  })

  it("keeps 'Anonymous' for a report with no reporter account", async () => {
    const { db, calls } = stubDb(["trash", null, null, null, null])
    const repo = makeDrizzleMediaWorkerRepo(db, {} as Sql)

    await repo.enqueueHeldModerationItem!({
      reportId: REPORT_ID,
      reason: "NSFW model over threshold",
    })

    expect(insertedMeta(calls)).toMatchObject({ reporter: "Anonymous", reporterUserId: null })
  })
})

describe("held media folding into an open moderation item", () => {
  it("clears an owner's consent marker so removing the item still strikes the author", async () => {
    const calls: Call[] = []
    const client = {
      options: { parsers: {}, serializers: {} },
      unsafe(query: string, params: unknown[]) {
        calls.push({ query, params })
        const rows = /^update "moderation_items"/.test(query) ? [["item-1"]] : []
        return Object.assign(Promise.resolve([]), { values: () => Promise.resolve(rows) })
      },
    }
    const db = drizzle(client as never) as unknown as Db
    const repo = makeDrizzleMediaWorkerRepo(db, {} as Sql)

    await repo.enqueueHeldModerationItem!({
      reportId: REPORT_ID,
      reason: "NSFW model over threshold",
    })

    const fold = calls.find((c) => /^update "moderation_items"/.test(c.query))
    expect(fold?.query).toMatch(/- 'ownerTakedown'/)
    expect(fold?.query).toMatch(/status = 'open'|"status" = \$/)
    expect(calls.some((c) => /insert into "moderation_items"/.test(c.query))).toBe(false)
  })
})
