import type PgBoss from "pg-boss"
import type { EnqueueOptions, JobHandler } from "@civfix/seams"
import type { FilingQueueName, FilingQueueOptions } from "@civfix/api/filings-worker"

export interface FilerWorkSettings {
  batchSize: number
}

export interface FilerJobs {
  start(): Promise<void>
  stop(): Promise<void>
  /** Every field of the queue's FILING_QUEUE_OPTIONS entry: pg-boss keeps whichever creator ran last. */
  createQueue(name: FilingQueueName, options: FilingQueueOptions): Promise<void>
  enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string>
  work(name: string, handler: JobHandler, settings: FilerWorkSettings): Promise<void>
}

// Bounds the wait for an in-flight run at shutdown; its filer processes are killed first, so the run
// reports a failed attempt within seconds.
const STOP_TIMEOUT_MS = 30_000

/** The filer's pg-boss handle, as the media worker's (src/worker-jobs.ts). */
export class PgBossFilerJobs implements FilerJobs {
  private boss: PgBoss | undefined

  constructor(private readonly connectionString: string) {}

  async start(): Promise<void> {
    const { default: PgBossCtor } = await import("pg-boss")
    const boss = new PgBossCtor(this.connectionString)
    // Without a listener an internal pg-boss error would crash the process.
    boss.on("error", (err: Error) => console.error("pg-boss error:", err))
    await boss.start()
    this.boss = boss
  }

  async stop(): Promise<void> {
    await this.boss?.stop({ graceful: true, wait: true, timeout: STOP_TIMEOUT_MS })
    this.boss = undefined
  }

  private requireBoss(): PgBoss {
    if (this.boss === undefined) throw new Error("pg-boss not started")
    return this.boss
  }

  async createQueue(name: FilingQueueName, options: FilingQueueOptions): Promise<void> {
    const queue: PgBoss.Queue = { name, ...options }
    // createQueue does nothing to a queue that exists; updateQueue brings its options to these.
    await this.requireBoss().createQueue(name, queue)
    await this.requireBoss().updateQueue(name, queue)
  }

  async enqueue(name: string, data: unknown, opts: EnqueueOptions = {}): Promise<string> {
    return (await this.requireBoss().send(name, data as object, opts)) ?? ""
  }

  // pg-boss completes the job when the callback resolves and fails it when it throws; with batchSize 1
  // that verdict is this one job's.
  async work(name: string, handler: JobHandler, settings: FilerWorkSettings): Promise<void> {
    await this.requireBoss().work(name, { batchSize: settings.batchSize }, async (jobs) => {
      for (const job of jobs) await handler({ id: job.id, data: job.data })
    })
  }
}
