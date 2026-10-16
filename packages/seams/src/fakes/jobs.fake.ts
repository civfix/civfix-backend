import type { Jobs, EnqueueOptions, JobHandler } from "../interfaces/jobs.js"
import { makeIdFactory } from "./ids.js"

export interface EnqueuedJob {
  id: string
  name: string
  data: unknown
  opts?: EnqueueOptions
  state: "created" | "completed" | "failed"
  error?: unknown
}

export interface ScheduledJob {
  name: string
  cron: string
  data?: unknown
}

/**
 * In-memory Jobs queue. If a handler is registered via work() for a job name, enqueue() runs it
 * synchronously (awaited) so unit tests observe the effect immediately. schedule() records cron
 * registrations without firing them.
 */
export class FakeJobs implements Jobs {
  readonly enqueued: EnqueuedJob[] = []
  readonly scheduled: ScheduledJob[] = []
  private readonly handlers = new Map<string, JobHandler>()
  private readonly nextId = makeIdFactory(7)

  async enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string> {
    const id = this.nextId()
    const job: EnqueuedJob = {
      id,
      name,
      data,
      ...(opts !== undefined ? { opts } : {}),
      state: "created",
    }
    this.enqueued.push(job)

    const handler = this.handlers.get(name)
    if (handler) {
      try {
        await handler({ id, data })
        job.state = "completed"
      } catch (err) {
        job.state = "failed"
        job.error = err
      }
    }
    return id
  }

  schedule(name: string, cron: string, data?: unknown): Promise<void> {
    this.scheduled.push({ name, cron, ...(data !== undefined ? { data } : {}) })
    return Promise.resolve()
  }

  work(name: string, handler: JobHandler): Promise<void> {
    this.handlers.set(name, handler)
    return Promise.resolve()
  }

  complete(jobId: string): Promise<void> {
    const job = this.enqueued.find((j) => j.id === jobId)
    if (job) job.state = "completed"
    return Promise.resolve()
  }

  fail(jobId: string, err?: unknown): Promise<void> {
    const job = this.enqueued.find((j) => j.id === jobId)
    if (job) {
      job.state = "failed"
      job.error = err
    }
    return Promise.resolve()
  }

  /** Test helper: jobs enqueued under a given name. */
  jobsFor(name: string): EnqueuedJob[] {
    return this.enqueued.filter((j) => j.name === name)
  }

  reset(): void {
    this.enqueued.length = 0
    this.scheduled.length = 0
    this.handlers.clear()
  }
}
