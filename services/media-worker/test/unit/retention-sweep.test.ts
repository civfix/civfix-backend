import { describe, expect, it } from "vitest"
import {
  runInboundEmailRetentionLane,
  runRetentionSweep,
  RETENTION_GEOCODE_CACHE_MS,
  RETENTION_GRACE_MS,
  RETENTION_INBOUND_EMAILS_MS,
} from "../../src/jobs/retention-sweep.js"
import { GEOCODE_CACHE_TTL_MS } from "@civfix/api/geocode-cache"
import type {
  InboundRetentionRepository,
  ReapedInboundEmail,
} from "@civfix/api/inbound-retention-repository"
import type { Sql } from "@civfix/api/db"

function makeSqlSpy(results: Array<unknown[] | Error>): {
  sql: Sql
  calls: string[]
  values: unknown[][]
} {
  const calls: string[] = []
  const values: unknown[][] = []
  let i = 0
  const tag = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(strings.join("?"))
    values.push(vals)
    const r = results[i++] ?? []
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
  }
  return { sql: tag as unknown as Sql, calls, values }
}

const rows = (n: number): { id: string }[] => Array.from({ length: n }, (_, k) => ({ id: `r${k}` }))

const EMPTY = {
  otps: 0,
  anonTokens: 0,
  sessions: 0,
  idempotencyKeys: 0,
  notifications: 0,
  geocodeCache: 0,
  inboundEmails: 0,
  inboundEmailObjectsLeaked: 0,
  errors: 0,
}

function fakeInboundStorage(): { deleted: string[]; delete: (key: string) => Promise<void> } {
  const deleted: string[] = []
  return {
    deleted,
    delete: (key: string) => {
      deleted.push(key)
      return Promise.resolve()
    },
  }
}

describe("retention.sweep", () => {
  it("deletes from email_otps, anon_tokens, sessions, idempotency_keys, notifications and geocode_cache, returning per-table counts", async () => {
    const { sql, calls } = makeSqlSpy([rows(3), rows(2), rows(5), rows(4), rows(6), rows(7)])
    const res = await runRetentionSweep({
      sql,
      now: () => new Date("2026-06-20T00:00:00Z"),
      log: () => {},
    })

    expect(res).toEqual({
      ...EMPTY,
      otps: 3,
      anonTokens: 2,
      sessions: 5,
      idempotencyKeys: 4,
      notifications: 6,
      geocodeCache: 7,
    })
    expect(calls.length).toBe(6)
    expect(calls[0]).toContain("DELETE FROM email_otps")
    expect(calls[0]).toContain("consumed_at IS NOT NULL OR expires_at <")
    expect(calls[1]).toContain("DELETE FROM anon_tokens")
    expect(calls[2]).toContain("DELETE FROM sessions")
    expect(calls[3]).toContain("DELETE FROM idempotency_keys")
    expect(calls[3]).toContain("WHERE ctid IN")
    expect(calls[3]).toContain("SELECT ctid FROM idempotency_keys")
    expect(calls[3]).not.toContain("SELECT key FROM idempotency_keys")
    expect(calls[4]).toContain("DELETE FROM notifications")
    expect(calls[4]).toContain("created_at <")
    expect(calls[5]).toContain("DELETE FROM geocode_cache")
    expect(calls[5]).toContain("SELECT point_key FROM geocode_cache")
    expect(calls[5]).toContain("resolved_at <")
  })

  it("bounds geocode_cache at the POSITIVE TTL - the table is written by an unauthenticated path", async () => {
    const { sql, values } = makeSqlSpy([rows(0), rows(0), rows(0), rows(0), rows(0), rows(1)])
    const now = new Date("2026-06-20T00:00:00Z")
    const res = await runRetentionSweep({ sql, now: () => now, log: () => {} })

    expect(res.geocodeCache).toBe(1)
    expect(RETENTION_GEOCODE_CACHE_MS).toBe(GEOCODE_CACHE_TTL_MS)
    expect(values[5]?.[0]).toEqual(new Date(now.getTime() - GEOCODE_CACHE_TTL_MS))
  })

  it("never throws: a per-table failure is counted + reported; the other tables still run", async () => {
    const { sql } = makeSqlSpy([new Error("otp delete failed"), rows(1), rows(1)])
    const reports: unknown[] = []
    const res = await runRetentionSweep({
      sql,
      now: () => new Date("2026-06-20T00:00:00Z"),
      log: () => {},
      report: (e) => reports.push(e),
    })

    expect(res.errors).toBe(1)
    expect(res.otps).toBe(0)
    expect(res.anonTokens).toBe(1)
    expect(res.sessions).toBe(1)
    expect(reports.length).toBe(1)
  })

  it("uses the default grace window when none is supplied (cutoff = now - grace)", async () => {
    const { sql } = makeSqlSpy([rows(0), rows(0), rows(0), rows(0), rows(0)])
    const res = await runRetentionSweep({
      sql,
      now: () => new Date("2026-06-20T00:00:00Z"),
      log: () => {},
    })
    expect(res).toEqual(EMPTY)
    expect(RETENTION_GRACE_MS).toBeGreaterThan(0)
  })
})

describe("inbound_emails retention lane (H10)", () => {
  const NOW = new Date("2026-06-20T00:00:00Z")
  const BEFORE = new Date(NOW.getTime() - RETENTION_INBOUND_EMAILS_MS)

  function laneResult() {
    return { inboundEmails: 0, inboundEmailObjectsLeaked: 0, errors: 0 }
  }

  function fakeRepo(pages: Array<ReapedInboundEmail[] | Error>): {
    repo: InboundRetentionRepository
    calls: { before: Date; limit: number }[]
    deleted: string[][]
  } {
    const calls: { before: Date; limit: number }[] = []
    const deleted: string[][] = []
    let i = 0
    return {
      calls,
      deleted,
      repo: {
        findArchivedBefore(input) {
          calls.push(input)
          const page = pages[i++] ?? []
          return page instanceof Error ? Promise.reject(page) : Promise.resolve(page)
        },
        deleteByIds(ids) {
          deleted.push([...ids])
          return Promise.resolve(ids.length)
        },
      },
    }
  }

  function reaped(id: string, ...keys: string[]): ReapedInboundEmail {
    return { id, attachmentKeys: keys }
  }

  const obs = { log: () => {}, report: () => {} }

  it("deletes the archived page and every attachment object on it", async () => {
    const storage = fakeInboundStorage()
    const { repo, calls } = fakeRepo([
      [
        reaped("e1", "inbound-emails/a/1-x.pdf"),
        reaped("e2", "inbound-emails/b/1-y.pdf", "inbound-emails/b/2-z.pdf"),
      ],
    ])
    const result = laneResult()

    await runInboundEmailRetentionLane({ sql: {} as never, storage }, result, {
      before: BEFORE,
      maxPages: 5,
      repo,
      ...obs,
    })

    expect(result.inboundEmails).toBe(2)
    expect(result.inboundEmailObjectsLeaked).toBe(0)
    expect(result.errors).toBe(0)
    expect(storage.deleted).toEqual([
      "inbound-emails/a/1-x.pdf",
      "inbound-emails/b/1-y.pdf",
      "inbound-emails/b/2-z.pdf",
    ])
    expect(calls[0]?.before.getTime()).toBe(NOW.getTime() - RETENTION_INBOUND_EMAILS_MS)
  })

  it("SKIPS the lane entirely when no inbound object store is wired (rows are kept)", async () => {
    const { repo, calls } = fakeRepo([[reaped("e1")]])
    const result = laneResult()

    await runInboundEmailRetentionLane({ sql: {} as never }, result, {
      before: BEFORE,
      maxPages: 5,
      repo,
      ...obs,
    })

    expect(calls).toHaveLength(0)
    expect(result.inboundEmails).toBe(0)
  })

  it("keeps draining while a page comes back FULL and stops on a short page", async () => {
    const storage = fakeInboundStorage()
    const { repo, calls } = fakeRepo([
      [reaped("a"), reaped("b")],
      [reaped("c"), reaped("d")],
      [reaped("e")],
    ])
    const result = laneResult()

    await runInboundEmailRetentionLane({ sql: {} as never, storage }, result, {
      before: BEFORE,
      maxPages: 5,
      pageSize: 2,
      repo,
      ...obs,
    })

    expect(result.inboundEmails).toBe(5)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.limit === 2)).toBe(true)
  })

  it("stops at maxPages rather than draining forever", async () => {
    const storage = fakeInboundStorage()
    const full = [reaped("a"), reaped("b")]
    const { repo, calls } = fakeRepo([full, full, full, full])
    const result = laneResult()

    await runInboundEmailRetentionLane({ sql: {} as never, storage }, result, {
      before: BEFORE,
      maxPages: 2,
      pageSize: 2,
      repo,
      ...obs,
    })

    expect(result.inboundEmails).toBe(4)
    expect(calls).toHaveLength(2)
  })

  it("deletes the OBJECTS before the rows, so a crash mid-page can never orphan them", async () => {
    const order: string[] = []
    const { repo, deleted } = fakeRepo([[reaped("e1", "inbound-emails/a/1-x.pdf")]])
    const wrapped: InboundRetentionRepository = {
      findArchivedBefore: repo.findArchivedBefore.bind(repo),
      deleteByIds: (ids) => {
        order.push("rows")
        return repo.deleteByIds(ids)
      },
    }
    const result = laneResult()

    await runInboundEmailRetentionLane(
      {
        sql: {} as never,
        storage: {
          delete: (key: string) => {
            order.push(`object:${key}`)
            return Promise.resolve()
          },
        },
      },
      result,
      { before: BEFORE, maxPages: 5, repo: wrapped, ...obs },
    )

    expect(order).toEqual(["object:inbound-emails/a/1-x.pdf", "rows"])
    expect(deleted).toEqual([["e1"]])
    expect(result.inboundEmails).toBe(1)
  })

  it("KEEPS a row whose objects could not be deleted, counting + reporting the leak", async () => {
    const { repo, deleted } = fakeRepo([
      [reaped("e1", "inbound-emails/a/1-x.pdf"), reaped("e2", "inbound-emails/b/1-y.pdf")],
    ])
    const result = laneResult()
    const reports: unknown[] = []

    await runInboundEmailRetentionLane(
      {
        sql: {} as never,
        storage: {
          delete: (key: string) =>
            key.includes("/a/") ? Promise.reject(new Error("r2 down")) : Promise.resolve(),
        },
      },
      result,
      { before: BEFORE, maxPages: 5, repo, log: () => {}, report: (e) => reports.push(e) },
    )

    expect(deleted).toEqual([["e2"]])
    expect(result.inboundEmails).toBe(1)
    expect(result.inboundEmailObjectsLeaked).toBe(1)
    expect(result.errors).toBe(0)
    expect(reports).toHaveLength(1)
  })

  it("STOPS when a whole page can be reaped by nothing (store unavailable), instead of re-selecting it", async () => {
    const full = [reaped("a", "k-a"), reaped("b", "k-b")]
    const { repo, calls, deleted } = fakeRepo([full, full, full, full])
    const result = laneResult()

    await runInboundEmailRetentionLane(
      { sql: {} as never, storage: { delete: () => Promise.reject(new Error("r2 down")) } },
      result,
      { before: BEFORE, maxPages: 5, pageSize: 2, repo, log: () => {}, report: () => {} },
    )

    expect(calls).toHaveLength(1)
    expect(deleted).toHaveLength(0)
    expect(result.inboundEmails).toBe(0)
    expect(result.inboundEmailObjectsLeaked).toBe(2)
  })

  it("never throws: a delete-page failure is counted + reported", async () => {
    const storage = fakeInboundStorage()
    const { repo } = fakeRepo([new Error("db down")])
    const result = laneResult()
    const reports: unknown[] = []

    await runInboundEmailRetentionLane({ sql: {} as never, storage }, result, {
      before: BEFORE,
      maxPages: 5,
      repo,
      log: () => {},
      report: (e) => reports.push(e),
    })

    expect(result.errors).toBe(1)
    expect(result.inboundEmails).toBe(0)
    expect(reports).toHaveLength(1)
  })

  it("is wired into runRetentionSweep and stays a no-op there without a store", async () => {
    const { sql, calls } = makeSqlSpy([rows(0), rows(0), rows(0), rows(0), rows(0)])
    const res = await runRetentionSweep({ sql, now: () => NOW, log: () => {} })
    expect(res.inboundEmails).toBe(0)
    expect(calls.some((c) => c.includes("inbound_emails"))).toBe(false)
  })

  it("runs the lane through runRetentionSweep when a store IS wired", async () => {
    const storage = fakeInboundStorage()
    const { sql, calls } = makeSqlSpy([
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      [{ id: "e1", attachments: [{ key: "inbound-emails/a/1-x.pdf" }] }],
      [{ id: "e1" }],
    ])
    const res = await runRetentionSweep({ sql, storage, now: () => NOW, log: () => {} })

    expect(res.inboundEmails).toBe(1)
    expect(storage.deleted).toEqual(["inbound-emails/a/1-x.pdf"])

    const select = calls.find((c) => c.includes("SELECT id, attachments")) ?? ""
    expect(select).toContain("FROM inbound_emails")
    expect(select).toContain("archived_at IS NOT NULL AND archived_at <")
    expect(select).toContain("ORDER BY archived_at ASC")
    expect(select).toContain("LIMIT")

    const del = calls.find((c) => c.includes("DELETE FROM inbound_emails")) ?? ""
    expect(del).toContain("WHERE id = ANY(")

    expect(calls.indexOf(select)).toBeLessThan(calls.indexOf(del))
  })
})
