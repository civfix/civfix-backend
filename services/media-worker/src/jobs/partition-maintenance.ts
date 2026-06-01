/**
 * chat.partition.maintenance cron: pre-create next month's chat_messages partition.
 *
 * chat_messages is declaratively RANGE-partitioned by created_at, one partition per calendar month
 * (see services/api/drizzle/0002_chat_partitioning.sql). A DEFAULT partition guarantees inserts never
 * fail, but rows in the default partition do not benefit from per-month pruning/retention. This monthly
 * cron creates the upcoming month's partition ahead of the rollover so new chat lands in its own
 * partition. It is the plan's section-7/12 monthly-partitioning maintenance.
 *
 * Safe/idempotent: the DDL is CREATE TABLE IF NOT EXISTS PARTITION OF ... with clock-derived bounds
 * (never user input), so running it repeatedly (or after the partition already exists) is a no-op.
 * NEVER throws: a failure is logged + reported and the worker keeps running.
 *
 * The actual DDL lives in @civfix/api (ensureNextMonthChatPartition) so partition bounds/naming have a
 * SINGLE source shared with the API's migrations.
 */

import { ensureNextMonthChatPartition } from "@civfix/api/media-repo"
import type { Sql } from "@civfix/api/db"

export interface PartitionMaintenanceDeps {
  sql: Sql
  /** Injectable clock for deterministic tests (defaults to now). */
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

/** Run the partition maintenance once. Returns the partition table name, or null on failure. */
export async function runPartitionMaintenance(
  deps: PartitionMaintenanceDeps,
): Promise<string | null> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})
  try {
    const table = await ensureNextMonthChatPartition(deps.sql, (deps.now ?? (() => new Date()))())
    log("chat.partition.maintenance: ensured", { table })
    return table
  } catch (err) {
    report(err, { job: "chat.partition.maintenance" })
    log("chat.partition.maintenance: failed", { err: String(err) })
    return null
  }
}
