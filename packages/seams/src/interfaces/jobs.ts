/**
 * Background job queue + scheduler behind a vendor-neutral interface (pg-boss style).
 */

export interface EnqueueOptions {
  singletonKey?: string
  /** Delay before the job becomes eligible to run, in seconds. */
  startAfter?: number
  retryLimit?: number
}

export interface JobHandlerArg {
  id: string
  data: any
  /** Retries already spent. Absent when the implementation does not track attempts. */
  retryCount?: number
  /** Set with `retryCount`; `retryCount >= retryLimit` marks the final attempt. */
  retryLimit?: number
}

export type JobHandler = (job: JobHandlerArg) => Promise<void>

export interface Jobs {
  enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string>
  schedule(name: string, cron: string, data?: unknown): Promise<void>
  work(name: string, handler: JobHandler): Promise<void>
  complete(jobId: string): Promise<void>
  fail(jobId: string, err?: unknown): Promise<void>
}
