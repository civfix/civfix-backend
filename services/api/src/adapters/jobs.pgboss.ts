/**
 * REAL Jobs adapter backed by pg-boss (Postgres-backed queue + cron scheduler).
 *
 * SCAFFOLD: the boss instance is held but methods throw until a later step starts pg-boss and maps
 * enqueue/schedule/work/complete/fail onto it. pg-boss is referenced via `import type` only here.
 *
 * Seam rule: pg-boss may ONLY be imported in this file (and in the media-worker's own adapter).
 */

import { AppError } from "@civfix/shared"
import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"
// import type PgBoss from "pg-boss"

export interface PgBossJobsConfig {
  /** Postgres connection string for the pg-boss schema (usually the same as DATABASE_URL). */
  connectionString: string
  /** Optional schema name for pg-boss tables (default "pgboss"). */
  schema?: string
}

const NOT_IMPL = "adapter not implemented: jobs.pgboss"

export class PgBossJobs implements Jobs {
  private readonly config: PgBossJobsConfig

  constructor(config: PgBossJobsConfig) {
    this.config = config
  }

  /** Start the underlying pg-boss instance. No-op placeholder for now. */
  start(): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  /** Stop the underlying pg-boss instance. Safe placeholder so shutdown wiring can call it. */
  stop(): Promise<void> {
    return Promise.resolve()
  }

  enqueue(_name: string, _data: unknown, _opts?: EnqueueOptions): Promise<string> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  schedule(_name: string, _cron: string, _data?: unknown): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  work(_name: string, _handler: JobHandler): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  complete(_jobId: string): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

  fail(_jobId: string, _err?: unknown): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }
}
