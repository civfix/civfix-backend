import type { Storage } from "@civfix/shared/interfaces"
import type { Sql } from "@civfix/api/db"
import {
  INBOUND_EMAIL_RETENTION_BATCH,
  INBOUND_EMAIL_RETENTION_MS,
  makeDrizzleInboundRetentionRepository,
  type InboundRetentionRepository,
} from "@civfix/api/inbound-retention-repo"
import { GEOCODE_CACHE_TTL_MS } from "@civfix/api/geocode-cache"
import { drainPages } from "./drain.js"
import { resolveJobObs, type JobObsDeps } from "./obs.js"

export interface RetentionSweepDeps extends JobObsDeps {
  sql: Sql
  graceMs?: number
  idempotencyRetentionMs?: number
  notificationsRetentionMs?: number
  geocodeCacheRetentionMs?: number
  inboundEmailsRetentionMs?: number
  batchSize?: number
  maxPages?: number
  storage?: Pick<Storage, "delete">
}

export interface RetentionSweepResult {
  otps: number
  anonTokens: number
  sessions: number
  idempotencyKeys: number
  notifications: number
  geocodeCache: number
  inboundEmails: number
  inboundEmailObjectsLeaked: number
  errors: number
}

const RETENTION_SWEEP = "retention.sweep"
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export const RETENTION_GRACE_MS = HOUR_MS
const RETENTION_BATCH = 5000
const RETENTION_IDEMPOTENCY_MS = 48 * HOUR_MS
const RETENTION_NOTIFICATIONS_MS = 90 * DAY_MS
export const RETENTION_GEOCODE_CACHE_MS = GEOCODE_CACHE_TTL_MS
export const RETENTION_INBOUND_EMAILS_MS = INBOUND_EMAIL_RETENTION_MS
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
  const geocodeCacheCutoff = new Date(
    now.getTime() - (deps.geocodeCacheRetentionMs ?? RETENTION_GEOCODE_CACHE_MS),
  )
  const inboundEmailsCutoff = new Date(
    now.getTime() - (deps.inboundEmailsRetentionMs ?? RETENTION_INBOUND_EMAILS_MS),
  )

  const result: RetentionSweepResult = {
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

  async function drainTable(
    table: string,
    deletePage: (limit: number) => Promise<unknown[]>,
    onDeleted: (n: number) => void,
  ): Promise<void> {
    try {
      await drainPages(deletePage, (rows) => onDeleted(rows.length), { pageSize, maxPages })
    } catch (err) {
      result.errors++
      report(err, { job: RETENTION_SWEEP, table })
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

  await drainTable(
    "geocode_cache",
    (limit) => deps.sql<{ point_key: string }[]>`
      DELETE FROM geocode_cache
      WHERE point_key IN (
        SELECT point_key FROM geocode_cache
        WHERE resolved_at < ${geocodeCacheCutoff}
        LIMIT ${limit}
      )
      RETURNING point_key
    `,
    (n) => (result.geocodeCache += n),
  )

  await runInboundEmailRetentionLane(deps, result, {
    before: inboundEmailsCutoff,
    maxPages,
    log,
    report,
  })

  log("retention.sweep: done", {
    otps: result.otps,
    anonTokens: result.anonTokens,
    sessions: result.sessions,
    idempotencyKeys: result.idempotencyKeys,
    notifications: result.notifications,
    geocodeCache: result.geocodeCache,
    inboundEmails: result.inboundEmails,
    inboundEmailObjectsLeaked: result.inboundEmailObjectsLeaked,
    errors: result.errors,
    cutoff: cutoff.toISOString(),
  })
  return result
}

export interface InboundEmailRetentionLaneOptions {
  before: Date
  maxPages: number
  log: (line: string, extra?: Record<string, unknown>) => void
  report: (err: unknown, context?: Record<string, unknown>) => void
  repo?: InboundRetentionRepository
  pageSize?: number
}

export async function runInboundEmailRetentionLane(
  deps: Pick<RetentionSweepDeps, "sql" | "storage">,
  result: Pick<RetentionSweepResult, "inboundEmails" | "inboundEmailObjectsLeaked" | "errors">,
  opts: InboundEmailRetentionLaneOptions,
): Promise<void> {
  const storage = deps.storage
  if (storage === undefined) return
  const repo = opts.repo ?? makeDrizzleInboundRetentionRepository(deps.sql)
  const pageSize = opts.pageSize ?? INBOUND_EMAIL_RETENTION_BATCH

  let stalled = false
  try {
    await drainPages(
      (limit) =>
        stalled ? Promise.resolve([]) : repo.findArchivedBefore({ before: opts.before, limit }),
      async (rows) => {
        const reaped: string[] = []
        for (const row of rows) {
          const objectsGone = await deleteAttachments(row.attachmentKeys, storage, result, opts)
          if (objectsGone) reaped.push(row.id)
        }
        if (reaped.length === 0) {
          stalled = true
          return
        }
        result.inboundEmails += await repo.deleteByIds(reaped)
      },
      { pageSize, maxPages: opts.maxPages },
    )
  } catch (err) {
    result.errors++
    opts.report(err, { job: RETENTION_SWEEP, table: "inbound_emails" })
    opts.log("retention.sweep: inbound_emails failed", { err: String(err) })
  }
}

async function deleteAttachments(
  keys: readonly string[],
  storage: Pick<Storage, "delete">,
  result: Pick<RetentionSweepResult, "inboundEmailObjectsLeaked">,
  opts: Pick<InboundEmailRetentionLaneOptions, "report">,
): Promise<boolean> {
  let objectsGone = true
  for (const key of keys) {
    try {
      await storage.delete(key)
    } catch (err) {
      objectsGone = false
      result.inboundEmailObjectsLeaked += 1
      opts.report(err, {
        job: RETENTION_SWEEP,
        table: "inbound_emails",
        phase: "attachment",
      })
    }
  }
  return objectsGone
}
