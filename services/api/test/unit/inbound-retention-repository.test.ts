import { describe, expect, it } from "vitest"
import { makeFakeSql } from "../helpers/fake-sql.js"
import {
  INBOUND_EMAIL_RETENTION_BATCH,
  INBOUND_EMAIL_RETENTION_MS,
  makeDrizzleInboundRetentionRepository,
  toReaped,
} from "../../src/services/admin/inbound-retention-repository.drizzle.js"
import type { Sql } from "../../src/db/client.js"

const DAY_MS = 24 * 60 * 60 * 1000

describe("inbound-email retention constants", () => {
  it("keeps archived third-party correspondence for exactly 180 days", () => {
    expect(INBOUND_EMAIL_RETENTION_MS).toBe(180 * DAY_MS)
  })

  it("bounds a single sweep page at 200 rows", () => {
    expect(INBOUND_EMAIL_RETENTION_BATCH).toBe(200)
  })
})

describe("findArchivedBefore", () => {
  it("selects ONLY archived rows strictly older than the cutoff, oldest first, bounded by the limit", async () => {
    const fake = makeFakeSql([{ match: /FROM inbound_emails/, rows: [] }])
    const repo = makeDrizzleInboundRetentionRepository(fake.sql as unknown as Sql)
    const before = new Date("2026-03-08T00:00:00.000Z")

    await repo.findArchivedBefore({ before, limit: INBOUND_EMAIL_RETENTION_BATCH })

    const stmt = fake.statements[0]!
    expect(stmt.sql).toMatch(/archived_at IS NOT NULL/)
    expect(stmt.sql).toMatch(/archived_at < \?/)
    expect(stmt.sql).toMatch(/ORDER BY archived_at ASC/)
    expect(stmt.sql).toMatch(/LIMIT \?/)
    expect(stmt.values).toEqual([before, INBOUND_EMAIL_RETENTION_BATCH])
  })

  it("never widens the predicate to unarchived mail, so a live thread is out of reach of the reaper", async () => {
    const fake = makeFakeSql([{ match: /FROM inbound_emails/, rows: [] }])
    const repo = makeDrizzleInboundRetentionRepository(fake.sql as unknown as Sql)

    await repo.findArchivedBefore({ before: new Date(), limit: 10 })

    const stmt = fake.statements[0]!
    expect(stmt.sql).not.toMatch(/archived_at IS NULL/)
    expect(stmt.sql).not.toMatch(/OR\s/)
  })

  it("passes a cutoff that is 180 days behind now, so nothing younger can ever match", async () => {
    const fake = makeFakeSql([{ match: /FROM inbound_emails/, rows: [] }])
    const repo = makeDrizzleInboundRetentionRepository(fake.sql as unknown as Sql)
    const now = new Date("2026-09-04T00:00:00.000Z")
    const cutoff = new Date(now.getTime() - INBOUND_EMAIL_RETENTION_MS)

    await repo.findArchivedBefore({ before: cutoff, limit: 10 })

    const bound = fake.statements[0]!.values[0] as Date
    expect(now.getTime() - bound.getTime()).toBe(180 * DAY_MS)
  })

  it("maps each row to its attachment object keys, dropping malformed entries", async () => {
    const fake = makeFakeSql([
      {
        match: /FROM inbound_emails/,
        rows: [
          { id: "a", attachments: [{ key: "inbound/a/1.pdf" }, { key: "inbound/a/2.png" }] },
          { id: "b", attachments: null },
          { id: "c", attachments: [{ key: "" }, { key: 42 }, {}, { key: "inbound/c/ok" }] },
        ],
      },
    ])
    const repo = makeDrizzleInboundRetentionRepository(fake.sql as unknown as Sql)

    const rows = await repo.findArchivedBefore({ before: new Date(), limit: 10 })

    expect(rows).toEqual([
      { id: "a", attachmentKeys: ["inbound/a/1.pdf", "inbound/a/2.png"] },
      { id: "b", attachmentKeys: [] },
      { id: "c", attachmentKeys: ["inbound/c/ok"] },
    ])
  })
})

describe("deleteByIds", () => {
  it("issues NO statement for an empty id list", async () => {
    const fake = makeFakeSql()
    const repo = makeDrizzleInboundRetentionRepository(fake.sql as unknown as Sql)

    expect(await repo.deleteByIds([])).toBe(0)
    expect(fake.statements).toHaveLength(0)
  })

  it("deletes by an id array bound as a single uuid[] parameter and returns the deleted count", async () => {
    const fake = makeFakeSql([
      { match: /DELETE FROM inbound_emails/, rows: [{ id: "a" }, { id: "b" }] },
    ])
    const repo = makeDrizzleInboundRetentionRepository(fake.sql as unknown as Sql)

    const deleted = await repo.deleteByIds(["a", "b", "c"])

    expect(deleted).toBe(2)
    const stmt = fake.statements[0]!
    expect(stmt.sql).toMatch(/DELETE FROM inbound_emails WHERE id = ANY\(\?::uuid\[\]\) RETURNING id/)
    expect(stmt.values).toEqual([["a", "b", "c"]])
  })
})

describe("toReaped", () => {
  it("returns no keys when attachments is absent", () => {
    expect(toReaped({ id: "x", attachments: null })).toEqual({ id: "x", attachmentKeys: [] })
  })

  it("keeps only non-empty string keys", () => {
    expect(
      toReaped({ id: "x", attachments: [{ key: "k" }, { key: "" }, { key: null }, { key: 1 }] }),
    ).toEqual({ id: "x", attachmentKeys: ["k"] })
  })
})
