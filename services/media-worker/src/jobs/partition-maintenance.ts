/**
 * chat.partition.maintenance cron: pre-create next month's chat_messages AND dm_messages partitions.
 *
 * chat_messages and dm_messages are declaratively RANGE-partitioned by created_at, one partition per
 * calendar month (see services/api/drizzle/0002_chat_partitioning.sql and 0009_dm_and_privacy.sql). A
 * DEFAULT partition guarantees inserts never fail, but rows in the default partition do not benefit from
 * per-month pruning/retention. This monthly cron creates the upcoming month's partition for BOTH tables
 * ahead of the rollover so new messages land in their own partition. It is the plan's section-7/12
 * monthly-partitioning maintenance.
 *
 * Safe/idempotent: the DDL is CREATE TABLE IF NOT EXISTS PARTITION OF ... with clock-derived bounds
 * (never user input), so running it repeatedly (or after the partition already exists) is a no-op.
 * NEVER throws: a failure is logged + reported and the worker keeps running.
 *
 * The actual DDL lives in @civfix/api (ensureNextMonthChatPartition / ensureNextMonthDmPartition) so
 * partition bounds/naming have a SINGLE source shared with the API's migrations.
 */

import { ensureNextMonthChatPartition, ensureNextMonthDmPartition } from "@civfix/api/media-repo"
import type { Sql } from "@civfix/api/db"

export interface PartitionMaintenanceDeps {
  sql: Sql
  /** Injectable clock for deterministic tests (defaults to now). */
  now?: () => Date
  log?: (line: string, extra?: Record<string, unknown>) => void
  report?: (err: unknown, context?: Record<string, unknown>) => void
}

/**
 * Run the partition maintenance once: ensure next month's chat_messages AND dm_messages partitions.
 * Returns the chat partition table name (the DM partition is ensured alongside), or null on failure.
 */
export async function runPartitionMaintenance(
  deps: PartitionMaintenanceDeps,
): Promise<string | null> {
  const log = deps.log ?? ((l: string, e?: Record<string, unknown>) => console.log(l, e ?? {}))
  const report = deps.report ?? (() => {})
  const at = (deps.now ?? (() => new Date()))()
  try {
    const table = await ensureNextMonthChatPartition(deps.sql, at)
    const dmTable = await ensureNextMonthDmPartition(deps.sql, at)
    log("chat.partition.maintenance: ensured", { table, dmTable })
    return table
  } catch (err) {
    report(err, { job: "chat.partition.maintenance" })
    log("chat.partition.maintenance: failed", { err: String(err) })
    return null
  }
}
