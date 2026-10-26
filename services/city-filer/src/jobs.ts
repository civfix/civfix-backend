import type { EnqueueOptions, JobHandler } from "@civfix/seams"
import type { FilingQueueName, FilingQueueOptions } from "@civfix/api/filings-worker"

export interface FilerWorkSettings {
  batchSize: number
}

export interface FilerJobs {
  start(): Promise<void>
  stop(): Promise<void>
  createQueue(name: FilingQueueName, options: FilingQueueOptions): Promise<void>
  enqueue(name: string, data: unknown, opts?: EnqueueOptions): Promise<string>
  work(name: string, handler: JobHandler, settings: FilerWorkSettings): Promise<void>
}
