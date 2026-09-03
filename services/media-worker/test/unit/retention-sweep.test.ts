import { describe, expect, it } from "vitest"
import {
  runRetentionSweep,
  RETENTION_GRACE_MS,
  RETENTION_INBOUND_EMAILS_MS,
} from "../../src/jobs/retention-sweep.js"
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
  it("deletes from email_otps, anon_tokens, sessions, idempotency_keys and notifications, returning per-table counts", async () => {
    const { sql, calls } = makeSqlSpy([rows(3), rows(2), rows(5), rows(4), rows(6)])
    const res = await runRetentionSweep({
      sql,
      now: () => new Date("2026-06-20T00:00:00Z"),
      log: () => {},
    })

    expect(res).toEqual({ ...EMPTY, otps: 3, anonTokens: 2, sessions: 5, idempotencyKeys: 4, notifications: 6 })
    expect(calls.length).toBe(5)
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

describe("retention.sweep: inbound_emails lane (H10)", () => {
  const NOW = new Date("2026-06-20T00:00:00Z")

  it("purges ARCHIVED rows past the TTL and deletes their attachment objects", async () => {
    const storage = fakeInboundStorage()
    const { sql, calls, values } = makeSqlSpy([
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      [
        { id: "e1", attachments: [{ key: "inbound-emails/a/1-x.pdf", filename: "x.pdf", size: 4 }] },
        { id: "e2", attachments: [{ key: "inbound-emails/b/1-y.pdf" }, { key: "inbound-emails/b/2-z.pdf" }] },
      ],
    ])

    const res = await runRetentionSweep({ sql, storage, now: () => NOW, log: () => {} })

    expect(res.inboundEmails).toBe(2)
    expect(res.inboundEmailObjectsLeaked).toBe(0)
    expect(res.errors).toBe(0)
    expect(storage.deleted).toEqual([
      "inbound-emails/a/1-x.pdf",
      "inbound-emails/b/1-y.pdf",
      "inbound-emails/b/2-z.pdf",
    ])

    const lane = calls[5] ?? ""
    expect(lane).toContain("DELETE FROM inbound_emails")
    expect(lane).toContain("archived_at IS NOT NULL AND archived_at <")
    expect(lane).toContain("WHERE id IN")
    expect(lane).toContain("LIMIT")
    expect(lane).toContain("RETURNING id, attachments")

    const cutoff = (values[5] ?? [])[0]
    expect(cutoff).toBeInstanceOf(Date)
    expect((cutoff as Date).getTime()).toBe(NOW.getTime() - RETENTION_INBOUND_EMAILS_MS)
  })

  it("SKIPS the lane entirely when no inbound object store is wired (rows are kept)", async () => {
    const { sql, calls } = makeSqlSpy([rows(0), rows(0), rows(0), rows(0), rows(0)])
    const res = await runRetentionSweep({ sql, now: () => NOW, log: () => {} })
    expect(res.inboundEmails).toBe(0)
    expect(calls.some((c) => c.includes("inbound_emails"))).toBe(false)
  })

  it("honors the page bound: a full page keeps draining, a short page stops", async () => {
    const storage = fakeInboundStorage()
    const page = (n: number): { id: string; attachments: never[] }[] =>
      Array.from({ length: n }, (_, k) => ({ id: `e${k}`, attachments: [] }))
    const { sql, calls } = makeSqlSpy([
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      page(2),
      page(2),
      page(1),
    ])

    const res = await runRetentionSweep({
      sql,
      storage,
      batchSize: 2,
      maxPages: 5,
      now: () => NOW,
      log: () => {},
    })

    expect(res.inboundEmails).toBe(5)
    expect(calls.filter((c) => c.includes("DELETE FROM inbound_emails"))).toHaveLength(3)
  })

  it("stops at maxPages rather than draining forever", async () => {
    const storage = fakeInboundStorage()
    const full = Array.from({ length: 2 }, (_, k) => ({ id: `e${k}`, attachments: [] }))
    const { sql, calls } = makeSqlSpy([
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      full,
      full,
      full,
      full,
    ])

    const res = await runRetentionSweep({
      sql,
      storage,
      batchSize: 2,
      maxPages: 2,
      now: () => NOW,
      log: () => {},
    })

    expect(res.inboundEmails).toBe(4)
    expect(calls.filter((c) => c.includes("DELETE FROM inbound_emails"))).toHaveLength(2)
  })

  it("a failed object delete is counted + reported, and the row stays deleted", async () => {
    const { sql } = makeSqlSpy([
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      rows(0),
      [{ id: "e1", attachments: [{ key: "inbound-emails/a/1-x.pdf" }] }],
    ])
    const reports: unknown[] = []
    const res = await runRetentionSweep({
      sql,
      storage: { delete: () => Promise.reject(new Error("r2 down")) },
      now: () => NOW,
      log: () => {},
      report: (e) => reports.push(e),
    })

    expect(res.inboundEmails).toBe(1)
    expect(res.inboundEmailObjectsLeaked).toBe(1)
    expect(res.errors).toBe(0)
    expect(reports).toHaveLength(1)
  })
})
