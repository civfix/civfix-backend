
import type { Sql } from "@civfix/api/db"

export interface RetentionSweepDeps {
  sql: Sql
  graceMs?: number
  idempotencyRetentionMs?: number
  batchSize?: number
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

export interface RetentionSweepResult {
  otps: number
  anonTokens: number
  sessions: number
  idempotencyKeys: number
  errors: number
}

export const RETENTION_GRACE_MS = 60 * 60 * 1000
export const RETENTION_BATCH = 5000
export const RETENTION_IDEMPOTENCY_MS = 48 * 60 * 60 * 1000

export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<RetentionSweepResult> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})
  const now = (deps.now ?? (() => new Date()))()
  const grace = deps.graceMs ?? RETENTION_GRACE_MS
  const batch = deps.batchSize ?? RETENTION_BATCH
  const cutoff = new Date(now.getTime() - grace)
  const idempotencyCutoff = new Date(
    now.getTime() - (deps.idempotencyRetentionMs ?? RETENTION_IDEMPOTENCY_MS),
  )

  const result: RetentionSweepResult = {
    otps: 0,
    anonTokens: 0,
    sessions: 0,
    idempotencyKeys: 0,
    errors: 0,
  }


  try {
    const rows = await deps.sql<{ id: string }[]>`
      DELETE FROM email_otps
      WHERE id IN (
        SELECT id FROM email_otps
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

  try {
    const rows = await deps.sql<{ id: string }[]>`
      DELETE FROM anon_tokens
      WHERE id IN (
        SELECT id FROM anon_tokens
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

  try {
    const rows = await deps.sql<{ id: string }[]>`
      DELETE FROM sessions
      WHERE id IN (
        SELECT id FROM sessions
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

  try {
    const rows = await deps.sql<{ key: string }[]>`
      DELETE FROM idempotency_keys
      WHERE key IN (
        SELECT key FROM idempotency_keys
        WHERE created_at < ${idempotencyCutoff}
        LIMIT ${batch}
      )
      RETURNING key
    `
    result.idempotencyKeys = rows.length
  } catch (err) {
    result.errors++
    report(err, { job: "retention.sweep", table: "idempotency_keys" })
    log("retention.sweep: idempotency_keys failed", { err: String(err) })
  }

  log("retention.sweep: done", {
    otps: result.otps,
    anonTokens: result.anonTokens,
    sessions: result.sessions,
    idempotencyKeys: result.idempotencyKeys,
    errors: result.errors,
    cutoff: cutoff.toISOString(),
  })
  return result
}
