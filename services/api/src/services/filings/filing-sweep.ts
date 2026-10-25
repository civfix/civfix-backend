import type { Jobs } from "@civfix/seams"
import type { FilingRepository } from "./filing-repository.js"
import type { FilingRecord } from "./filing-types.js"

export interface FilingQueueDeps {
  filings: Pick<FilingRepository, "getSettings" | "listDueQueued">
  jobs: Pick<Jobs, "enqueue">
  automaticFiling: boolean
  now?: () => Date
}

export interface FilingQueue {
  /** Sends the filing's job; false when nothing was sent (a portal filing with automatic filing off). */
  enqueueFiling(filing: FilingRecord): Promise<boolean>
  /** Re-enqueues due queued filings, oldest first; `ignoreAge` drops the 10-minute rule (Resume). */
  runSweepPass(opts?: { ignoreAge?: boolean }): Promise<void>
}

export function makeFilingQueue(_deps: FilingQueueDeps): FilingQueue {
  throw new Error("not implemented")
}
