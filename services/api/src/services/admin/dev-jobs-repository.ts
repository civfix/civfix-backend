/** One queue's rows in pg-boss's job table. A queue with no live job and no completion has no entry. */
export interface QueueJobStats {
  name: string
  created: number
  retry: number
  active: number
  failed: number
  /** Failed in the last 24 hours. */
  failedLast24h: number
  /** When the oldest created or retry job that is already due became due; null when none is. */
  oldestDueAt: Date | null
  /** The newest completion still in the job table (pg-boss keeps them 7 days); null when none. */
  lastCompletedAt: Date | null
}

export interface QueueSchedule {
  name: string
  cron: string
}

export interface DevJobsSnapshot {
  stats: QueueJobStats[]
  schedules: QueueSchedule[]
}

export interface QueueRunState {
  /** pg-boss has created the queue. */
  exists: boolean
  /** A created or retry job is already waiting on it. */
  waiting: boolean
}

/** Reads of pg-boss's own tables, which exist only when jobs are real. */
export interface DevJobsRepository {
  snapshot(names: readonly string[]): Promise<DevJobsSnapshot>
  runState(name: string): Promise<QueueRunState>
}
