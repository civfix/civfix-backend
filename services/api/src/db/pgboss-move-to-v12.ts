import type { Sql } from "./client.js"

export interface QueueMoveCounts {
  name: string
  moved: number
  skippedExisting: number
  skippedNoQueue: number
}

export interface PgBossMoveResult {
  oldSchema: boolean
  queues: QueueMoveCounts[]
}

export function movePgBossJobsToV12(
  _sql: Sql,
  _opts: { apply: boolean },
): Promise<PgBossMoveResult> {
  return Promise.reject(new Error("not implemented"))
}

export function runPgBossMove(
  _argv: readonly string[],
  _move: (opts: { apply: boolean }) => Promise<PgBossMoveResult>,
  _log: (line: string) => void,
): Promise<void> {
  return Promise.reject(new Error("not implemented"))
}
