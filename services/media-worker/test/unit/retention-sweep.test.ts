
import { describe, expect, it } from "vitest"
import {
  runRetentionSweep,
  RETENTION_GRACE_MS,
} from "../../src/jobs/retention-sweep.js"
import type { Sql } from "@civfix/api/db"

function makeSqlSpy(results: Array<unknown[] | Error>): { sql: Sql; calls: string[] } {
  const calls: string[] = []
  let i = 0
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    calls.push(strings.join("?"))
    const r = results[i++] ?? []
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
  }
  return { sql: tag as unknown as Sql, calls }
}

const rows = (n: number): { id: string }[] => Array.from({ length: n }, (_, k) => ({ id: `r${k}` }))

describe("retention.sweep", () => {
  it("deletes from email_otps, anon_tokens, sessions, idempotency_keys and notifications, returning per-table counts", async () => {
    const { sql, calls } = makeSqlSpy([rows(3), rows(2), rows(5), rows(4), rows(6)])
    const res = await runRetentionSweep({ sql, now: () => new Date("2026-06-20T00:00:00Z"), log: () => {} })

    expect(res).toEqual({
      otps: 3,
      anonTokens: 2,
      sessions: 5,
      idempotencyKeys: 4,
      notifications: 6,
      errors: 0,
    })
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
    const res = await runRetentionSweep({ sql, now: () => new Date("2026-06-20T00:00:00Z"), log: () => {} })
    expect(res).toEqual({
      otps: 0,
      anonTokens: 0,
      sessions: 0,
      idempotencyKeys: 0,
      notifications: 0,
      errors: 0,
    })
    expect(RETENTION_GRACE_MS).toBeGreaterThan(0)
  })
})
