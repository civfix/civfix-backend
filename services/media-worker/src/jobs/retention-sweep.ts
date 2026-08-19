
import type { Sql } from "@civfix/api/db"
import { drainPages } from "./drain.js"
import { resolveJobObs, type JobObsDeps } from "./obs.js"

export interface RetentionSweepDeps extends JobObsDeps {
  sql: Sql
  graceMs?: number
  idempotencyRetentionMs?: number
  notificationsRetentionMs?: number
  batchSize?: number
  maxPages?: number
}

export interface RetentionSweepResult {
  otps: number
  anonTokens: number
  sessions: number
  idempotencyKeys: number
  notifications: number
  errors: number
}

export const RETENTION_GRACE_MS = 60 * 60 * 1000
export const RETENTION_BATCH = 5000
export const RETENTION_IDEMPOTENCY_MS = 48 * 60 * 60 * 1000
export const RETENTION_NOTIFICATIONS_MS = 90 * 24 * 60 * 60 * 1000
export const RETENTION_MAX_PAGES = 20

export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<RetentionSweepResult> {
  const { log, report, now: clock } = resolveJobObs(deps)
  const now = clock()
  const grace = deps.graceMs ?? RETENTION_GRACE_MS
  const pageSize = deps.batchSize ?? RETENTION_BATCH
  const maxPages = deps.maxPages ?? RETENTION_MAX_PAGES
  const cutoff = new Date(now.getTime() - grace)
  const idempotencyCutoff = new Date(
    now.getTime() - (deps.idempotencyRetentionMs ?? RETENTION_IDEMPOTENCY_MS),
  )
  const notificationsCutoff = new Date(
    now.getTime() - (deps.notificationsRetentionMs ?? RETENTION_NOTIFICATIONS_MS),
  )

  const result: RetentionSweepResult = {
    otps: 0,
    anonTokens: 0,
    sessions: 0,
    idempotencyKeys: 0,
    notifications: 0,
    errors: 0,
  }

  async function drainTable(
    table: string,
    deletePage: (limit: number) => Promise<unknown[]>,
    onDeleted: (n: number) => void,
  ): Promise<void> {
    try {
      await drainPages(deletePage, (rows) => onDeleted(rows.length), { pageSize, maxPages })
    } catch (err) {
      result.errors++
      report(err, { job: "retention.sweep", table })
      log(`retention.sweep: ${table} failed`, { err: String(err) })
    }
  }

  await drainTable(
    "email_otps",
    (limit) => deps.sql<{ id: string }[]>`
      DELETE FROM email_otps
      WHERE id IN (
        SELECT id FROM email_otps
        WHERE consumed_at IS NOT NULL OR expires_at < ${cutoff}
        LIMIT ${limit}
      )
      RETURNING id
    `,
    (n) => (result.otps += n),
  )

  await drainTable(
    "anon_tokens",
    (limit) => deps.sql<{ id: string }[]>`
      DELETE FROM anon_tokens
      WHERE id IN (
        SELECT id FROM anon_tokens
        WHERE expires_at < ${cutoff}
        LIMIT ${limit}
      )
      RETURNING id
    `,
    (n) => (result.anonTokens += n),
  )

  await drainTable(
    "sessions",
    (limit) => deps.sql<{ id: string }[]>`
      DELETE FROM sessions
      WHERE id IN (
        SELECT id FROM sessions
        WHERE expires_at < ${cutoff}
        LIMIT ${limit}
      )
      RETURNING id
    `,
    (n) => (result.sessions += n),
  )

  await drainTable(
    "idempotency_keys",
    (limit) => deps.sql<{ key: string }[]>`
      DELETE FROM idempotency_keys
      WHERE ctid IN (
        SELECT ctid FROM idempotency_keys
        WHERE created_at < ${idempotencyCutoff}
        LIMIT ${limit}
      )
      RETURNING key
    `,
    (n) => (result.idempotencyKeys += n),
  )

  await drainTable(
    "notifications",
    (limit) => deps.sql<{ id: string }[]>`
      DELETE FROM notifications
      WHERE id IN (
        SELECT id FROM notifications
        WHERE created_at < ${notificationsCutoff}
        LIMIT ${limit}
      )
      RETURNING id
    `,
    (n) => (result.notifications += n),
  )

  log("retention.sweep: done", {
    otps: result.otps,
    anonTokens: result.anonTokens,
    sessions: result.sessions,
    idempotencyKeys: result.idempotencyKeys,
    notifications: result.notifications,
    errors: result.errors,
    cutoff: cutoff.toISOString(),
  })
  return result
}
