import { PGBOSS_SCHEMA } from "../lib/queue-names.js"
import type { Sql, TransactionSql } from "./client.js"
import { runDbCli, runIfMain } from "./cli.js"

export interface QueueMoveCounts {
  name: string
  moved: number
  /** Its id or its singletonKey is already waiting in pgboss_v12; the old row is cancelled anyway. */
  skippedExisting: number
  /** pgboss_v12 has no such queue; the old row is left as it is. */
  skippedNoQueue: number
}

export interface PgBossMoveResult {
  /** Whether the pg-boss 10 job table exists at all. */
  oldSchema: boolean
  queues: QueueMoveCounts[]
}

interface QueueMoveRow {
  name: string
  moved: number
  skipped_existing: number
  skipped_no_queue: number
}

/** Thrown inside a dry run's transaction so it rolls back after it has counted. */
class DryRunRollback extends Error {
  constructor(readonly result: QueueMoveCounts[]) {
    super("dry run")
  }
}

function toCounts(rows: readonly QueueMoveRow[]): QueueMoveCounts[] {
  return rows.map((row) => ({
    name: row.name,
    moved: row.moved,
    skippedExisting: row.skipped_existing,
    skippedNoQueue: row.skipped_no_queue,
  }))
}

// Without pgboss_v12 no target queue exists, so every waiting job is skipped and left as it is; the
// script creates nothing, and the API's next boot creates the schema.
async function countWithoutTarget(tx: TransactionSql): Promise<QueueMoveCounts[]> {
  return toCounts(
    await tx<QueueMoveRow[]>`
      SELECT name, 0 AS moved, 0 AS skipped_existing, count(*)::int AS skipped_no_queue
      FROM pgboss.job
      WHERE state IN ('created', 'retry')
      GROUP BY name
      ORDER BY name
    `,
  )
}

// One statement, so the copies and the cancellations commit together. ON CONFLICT DO NOTHING covers
// both the primary key (name, id) and a short queue's unique waiting singletonKey (job_i1), and the old
// row of a job it skipped is cancelled too, so a later run cannot copy a job that has since finished.
// The old rows are locked first, in case an API still on pg-boss 10 is fetching from them.
async function moveIntoTarget(tx: TransactionSql): Promise<QueueMoveCounts[]> {
  return toCounts(
    await tx<QueueMoveRow[]>`
      WITH waiting AS (
        SELECT
          j.name, j.id, j.priority, j.data, j.state::text AS state, j.retry_limit, j.retry_count,
          j.retry_delay, j.retry_backoff, j.singleton_key, j.singleton_on, j.start_after,
          j.created_on, j.dead_letter, j.expire_in, q.policy AS target_policy,
          q.name IS NOT NULL AS has_queue
        FROM pgboss.job j
        LEFT JOIN pgboss_v12.queue q ON q.name = j.name
        WHERE j.state IN ('created', 'retry')
        FOR UPDATE OF j
      ),
      inserted AS (
        INSERT INTO pgboss_v12.job (
          name, id, priority, data, state, retry_limit, retry_count, retry_delay, retry_backoff,
          singleton_key, singleton_on, start_after, created_on, dead_letter, expire_seconds, policy
        )
        SELECT
          name, id, priority, data, state::pgboss_v12.job_state, retry_limit, retry_count,
          retry_delay, retry_backoff, singleton_key, singleton_on, start_after, created_on,
          dead_letter, extract(epoch FROM expire_in)::int, target_policy
        FROM waiting
        WHERE has_queue
        ON CONFLICT DO NOTHING
        RETURNING name, id
      ),
      -- Postgres runs a data-modifying WITH to completion whether or not the query reads it.
      cancelled AS (
        UPDATE pgboss.job o
        SET state = 'cancelled', completed_on = now()
        FROM waiting w
        WHERE o.name = w.name AND o.id = w.id AND w.has_queue
      )
      SELECT
        w.name,
        count(i.id)::int AS moved,
        (count(*) FILTER (WHERE w.has_queue) - count(i.id))::int AS skipped_existing,
        count(*) FILTER (WHERE NOT w.has_queue)::int AS skipped_no_queue
      FROM waiting w
      LEFT JOIN inserted i ON i.name = w.name AND i.id = w.id
      GROUP BY w.name
      ORDER BY w.name
    `,
  )
}

/**
 * Copies the jobs still waiting in pg-boss 10's `pgboss` schema into pg-boss 12's, for the jobs an API
 * color still on pg-boss 10 enqueued during the blue/green switch. Only created and retry jobs move;
 * every column D26 lists carries over, and every other column takes pg-boss 12's default. A dry run is
 * the same transaction rolled back, so its counts are exactly what --apply would do.
 */
export async function movePgBossJobsToV12(
  sql: Sql,
  opts: { apply: boolean },
): Promise<PgBossMoveResult> {
  const [found] = await sql<{ old: boolean; target: boolean }[]>`
    SELECT
      to_regclass('pgboss.job') IS NOT NULL AS old,
      to_regclass('pgboss_v12.queue') IS NOT NULL AS target
  `
  if (found === undefined || !found.old) return { oldSchema: false, queues: [] }
  const target = found.target
  try {
    const queues = await sql.begin<QueueMoveCounts[]>(async (tx) => {
      const counts = target ? await moveIntoTarget(tx) : await countWithoutTarget(tx)
      if (!opts.apply) throw new DryRunRollback(counts)
      return counts
    })
    return { oldSchema: true, queues }
  } catch (err) {
    if (err instanceof DryRunRollback) return { oldSchema: true, queues: err.result }
    throw err
  }
}

/** The command line: a dry run unless argv holds --apply. */
export async function runPgBossMove(
  argv: readonly string[],
  move: (opts: { apply: boolean }) => Promise<PgBossMoveResult>,
  log: (line: string) => void,
): Promise<void> {
  const apply = argv.includes("--apply")
  log(
    apply
      ? `pgboss-move-to-v12: moving waiting jobs from pgboss to ${PGBOSS_SCHEMA}`
      : "pgboss-move-to-v12: dry run, nothing is written (pass --apply to move)",
  )
  const result = await move({ apply })
  if (!result.oldSchema) {
    log("pgboss-move-to-v12: there is no old pgboss schema, so there is nothing to move")
    return
  }
  if (result.queues.length === 0) log("pgboss-move-to-v12: no job is waiting in pgboss")
  for (const q of result.queues) {
    log(
      `${q.name}: moved ${q.moved}, skipped (already in ${PGBOSS_SCHEMA}) ${q.skippedExisting}, ` +
        `skipped (no queue in ${PGBOSS_SCHEMA}) ${q.skippedNoQueue}`,
    )
  }
}

runIfMain(import.meta.url, "pgboss-move-to-v12", async () => {
  await runDbCli(async (_db, sql) => {
    await runPgBossMove(
      process.argv.slice(2),
      (opts) => movePgBossJobsToV12(sql, opts),
      (line) => console.log(line),
    )
  })
})
