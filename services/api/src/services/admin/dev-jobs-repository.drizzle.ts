import type { Sql, TransactionSql } from "../../db/client.js"
import type { DevJobsRepository, DevJobsSnapshot, QueueRunState } from "./dev-jobs-repository.js"

interface QueueStatsRow {
  name: string
  created: number
  retry: number
  active: number
  failed: number
  failed_last_24h: number
  oldest_due_at: Date | null
  last_completed_at: Date | null
}

interface QueueRunStateRow {
  exists: boolean
  waiting: boolean
}

/**
 * Every read runs under a 2-second statement timeout, so a locked or bloated pg-boss table on
 * production costs the console an error instead of a held connection. pg-boss indexes its archive
 * only on `archived_on`, so every archive read is bounded to the last 48 hours of archive time,
 * which that index serves.
 */
function withReadTimeout<T>(sql: Sql, read: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '2s'`
    return read(tx)
  }) as Promise<T>
}

export function makeDrizzleDevJobsRepository(sql: Sql): DevJobsRepository {
  return {
    snapshot(names: readonly string[]): Promise<DevJobsSnapshot> {
      const queueNames = [...names]
      return withReadTimeout(sql, async (tx) => {
        const stats = await tx<QueueStatsRow[]>`
          WITH live AS (
            SELECT
              name,
              count(*) FILTER (WHERE state = 'created')::int AS created,
              count(*) FILTER (WHERE state = 'retry')::int AS retry,
              count(*) FILTER (WHERE state = 'active')::int AS active,
              count(*) FILTER (WHERE state = 'failed')::int AS failed,
              count(*) FILTER (
                WHERE state = 'failed' AND completed_on >= now() - interval '24 hours'
              )::int AS failed_last_24h,
              min(start_after) FILTER (
                WHERE state IN ('created', 'retry') AND start_after <= now()
              ) AS oldest_due_at,
              max(completed_on) FILTER (WHERE state = 'completed') AS last_completed_at
            FROM pgboss.job
            WHERE name = ANY(${queueNames}::text[])
            GROUP BY name
          ),
          archived AS (
            SELECT
              name,
              count(*) FILTER (
                WHERE state = 'failed' AND completed_on >= now() - interval '24 hours'
              )::int AS failed_last_24h,
              max(completed_on) FILTER (WHERE state = 'completed') AS last_completed_at
            FROM pgboss.archive
            WHERE archived_on >= now() - interval '48 hours'
              AND name = ANY(${queueNames}::text[])
            GROUP BY name
          )
          SELECT
            coalesce(l.name, a.name) AS name,
            coalesce(l.created, 0) AS created,
            coalesce(l.retry, 0) AS retry,
            coalesce(l.active, 0) AS active,
            coalesce(l.failed, 0) AS failed,
            coalesce(l.failed_last_24h, 0) + coalesce(a.failed_last_24h, 0) AS failed_last_24h,
            l.oldest_due_at,
            greatest(l.last_completed_at, a.last_completed_at) AS last_completed_at
          FROM live l
          FULL JOIN archived a ON a.name = l.name
        `
        const schedules = await tx<{ name: string; cron: string }[]>`
          SELECT name, cron FROM pgboss.schedule WHERE name = ANY(${queueNames}::text[])
        `
        return {
          stats: stats.map((row) => ({
            name: row.name,
            created: row.created,
            retry: row.retry,
            active: row.active,
            failed: row.failed,
            failedLast24h: row.failed_last_24h,
            oldestDueAt: row.oldest_due_at,
            lastCompletedAt: row.last_completed_at,
          })),
          schedules: schedules.map((row) => ({ name: row.name, cron: row.cron })),
        }
      })
    },

    runState(name: string): Promise<QueueRunState> {
      return withReadTimeout(sql, async (tx) => {
        const rows = await tx<QueueRunStateRow[]>`
          SELECT
            EXISTS (SELECT 1 FROM pgboss.queue WHERE name = ${name}) AS exists,
            EXISTS (
              SELECT 1 FROM pgboss.job WHERE name = ${name} AND state IN ('created', 'retry')
            ) AS waiting
        `
        const row = rows[0]
        if (row === undefined) throw new Error("runState: select returned no row")
        return { exists: row.exists, waiting: row.waiting }
      })
    },
  }
}
