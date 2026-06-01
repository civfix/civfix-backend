/**
 * Jobs seam selection for the media worker.
 *
 * The worker is a separate process from the API, so it does its own minimal seam wiring rather than
 * importing the API's DI container (which would drag in Fastify and every adapter). It only needs
 * the Jobs seam. Real-vs-fake is chosen by USE_FAKE_JOBS, mirroring the API's rule.
 *
 * The real pg-boss adapter body lands in a later step; here it throws if actually invoked, proving
 * the seam boundary while keeping the worker bootable offline with FakeJobs.
 */

import type { Jobs, EnqueueOptions, JobHandler } from "@civfix/shared/interfaces"
import { AppError } from "@civfix/shared"
import { FakeJobs } from "@civfix/shared/fakes"

/** Parse "1"/"true"/"yes"/"on" as true; default ON outside production so the worker boots offline. */
function useFakeJobs(): boolean {
  const isProd = process.env.NODE_ENV === "production"
  const raw = process.env.USE_FAKE_JOBS
  if (raw === undefined || raw === "") return !isProd
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

const NOT_IMPL = "adapter not implemented: media-worker jobs.pgboss"

/**
 * Minimal pg-boss-backed Jobs placeholder for the worker. Mirrors the API's PgBossJobs surface
 * (start/stop + the Jobs interface) so the worker lifecycle can manage it.
 */
export class WorkerPgBossJobs implements Jobs {
  private readonly connectionString: string

  constructor(connectionString: string) {
    this.connectionString = connectionString
  }

  start(): Promise<void> {
    return Promise.reject(AppError.internal(NOT_IMPL))
  }

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

export interface JobsHandle {
  jobs: Jobs
  /** Start the underlying queue if the real impl needs it; no-op for the fake. */
  start(): Promise<void>
  /** Stop the underlying queue; no-op for the fake. */
  stop(): Promise<void>
}

/** Build the Jobs seam for the worker, selecting fake vs real per USE_FAKE_JOBS. */
export function buildJobs(): JobsHandle {
  if (useFakeJobs()) {
    const jobs = new FakeJobs()
    return { jobs, start: () => Promise.resolve(), stop: () => Promise.resolve() }
  }
  const connectionString = process.env.DATABASE_URL ?? ""
  if (!connectionString) {
    throw new Error("media-worker: DATABASE_URL is required when USE_FAKE_JOBS is off")
  }
  const real = new WorkerPgBossJobs(connectionString)
  return { jobs: real, start: () => real.start(), stop: () => real.stop() }
}
