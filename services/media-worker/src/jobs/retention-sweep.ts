/**
 * retention.sweep cron: delete TTL-able auth/session rows that would otherwise accumulate forever.
 *
 * PRIVACY (documents/21-privacy-compliance.md §7.1 retention schedule): three tables hold short-lived
 * auth artifacts that are USELESS once expired/consumed but are never cleaned up by any existing path:
 *
 *   - email_otps      one-time email sign-in codes. A row is dead once `consumed_at` is set OR
 *                     `expires_at` has passed; keeping it serves no purpose (only the code HASH is
 *                     stored, but the row still ties an email address to a sign-in time).
 *   - anon_tokens     anonymous-reporting session tokens. Dead once `expires_at` has passed (the
 *                     per-token abuse counters + claim code are then moot).
 *   - sessions        server-side session records. A row past `expires_at` is a stale login that the
 *                     auth layer already rejects; deleting it reclaims the row + trims the IP/UA we keep.
 *
 * We add a small GRACE window before deleting so a just-expired row is not raced out from under an
 * in-flight request, and a per-table BATCH cap so a large backlog drains over several runs instead of one
 * giant DELETE holding a long lock. Each DELETE is independent and `RETURNING id`, so the count is exact.
 *
 * NO NEW SCHEMA: this only deletes expired rows from existing tables.
 *
 * Mirrors the orphan-sweep / partition-maintenance job shape: pure deps, an injectable clock + logger +
 * reporter, and it NEVER throws — a per-table failure is counted, reported, and the sweep continues.
 */

import type { Sql } from "@civfix/api/db"

export interface RetentionSweepDeps {
  sql: Sql
  /** Grace window (ms) added past expiry before a row is eligible for deletion. */
  graceMs?: number
  /** Max rows deleted per table per run (bounds lock time; a backlog drains over several runs). */
  batchSize?: number
  /** Injectable clock (defaults to Date.now) for deterministic tests. */
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

export interface RetentionSweepResult {
  /** Deleted consumed/expired one-time email codes. */
  otps: number
  /** Deleted expired anonymous-reporting tokens. */
  anonTokens: number
  /** Deleted expired sessions. */
  sessions: number
  /** Tables that failed this run (each failure is isolated; the others still run). */
  errors: number
}

/** Default grace window: keep an expired row for 1h past expiry before deleting (race safety). */
export const RETENTION_GRACE_MS = 60 * 60 * 1000
/** Default per-table batch cap per run. */
export const RETENTION_BATCH = 5000

/**
 * Run one retention sweep. Returns per-table delete counts. Never throws; a per-table failure is counted,
 * logged + reported, and the remaining tables are still swept.
 */
export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<RetentionSweepResult> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})
  const now = (deps.now ?? (() => new Date()))()
  const grace = deps.graceMs ?? RETENTION_GRACE_MS
  const batch = deps.batchSize ?? RETENTION_BATCH
  const cutoff = new Date(now.getTime() - grace)

  const result: RetentionSweepResult = { otps: 0, anonTokens: 0, sessions: 0, errors: 0 }

  // 1) email_otps: consumed OR expired past the grace window. Batched via a ctid subselect.
  try {
    const rows = await deps.sql<{ id: string }[]>`
      DELETE FROM email_otps
      WHERE ctid IN (
        SELECT ctid FROM email_otps
        WHERE consumed_at IS NOT NULL OR expires_at < ${cutoff}
        LIMIT ${batch}
      )
      RETURNING id
    `
    result.otps = rows.length
  } catch (err) {
    result.errors++
    report(err, { job: "retention.sweep", table: "email_otps" })
    log("retention.sweep: email_otps failed", { err: String(err) })
  }

  // 2) anon_tokens: expired past the grace window.
  try {
    const rows = await deps.sql<{ id: string }[]>`
      DELETE FROM anon_tokens
      WHERE ctid IN (
        SELECT ctid FROM anon_tokens
        WHERE expires_at < ${cutoff}
        LIMIT ${batch}
      )
      RETURNING id
    `
    result.anonTokens = rows.length
  } catch (err) {
    result.errors++
    report(err, { job: "retention.sweep", table: "anon_tokens" })
    log("retention.sweep: anon_tokens failed", { err: String(err) })
  }

  // 3) sessions: expired past the grace window.
  try {
    const rows = await deps.sql<{ id: string }[]>`
      DELETE FROM sessions
      WHERE ctid IN (
        SELECT ctid FROM sessions
        WHERE expires_at < ${cutoff}
        LIMIT ${batch}
      )
      RETURNING id
    `
    result.sessions = rows.length
  } catch (err) {
    result.errors++
    report(err, { job: "retention.sweep", table: "sessions" })
    log("retention.sweep: sessions failed", { err: String(err) })
  }

  log("retention.sweep: done", {
    otps: result.otps,
    anonTokens: result.anonTokens,
    sessions: result.sessions,
    errors: result.errors,
    cutoff: cutoff.toISOString(),
  })
  return result
}
