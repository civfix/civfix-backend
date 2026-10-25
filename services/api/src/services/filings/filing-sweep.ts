import type { EnqueueOptions, Jobs } from "@civfix/seams"
import { FILING_EMAIL_JOB, FILING_RUN_JOB } from "../../lib/queue-names.js"
import { MS_PER_MINUTE, MS_PER_SECOND } from "../../lib/time.js"
import type { FilingRepository } from "./filing-repository.js"
import { FILING_DUE_MAX_LIMIT, type FilingChannel, type FilingRecord } from "./filing-types.js"
import type { FilingEmailJobData, FilingRunJobData } from "./filings-worker.js"

// A queued filing touched this recently may still have its job waiting in pg-boss; the sweep is only
// for the ones pg-boss lost (an expired or dropped job).
const SWEEP_MIN_AGE_MS = 10 * MS_PER_MINUTE

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

export function makeFilingQueue(deps: FilingQueueDeps): FilingQueue {
  const now = deps.now ?? (() => new Date())

  // singletonKey = filing id: the queues are policy "short", so a filing never has two jobs waiting.
  function sendOptions(filing: FilingRecord): EnqueueOptions {
    const delayMs =
      filing.nextAttemptAt === null ? 0 : filing.nextAttemptAt.getTime() - now().getTime()
    return delayMs > 0
      ? { singletonKey: filing.id, startAfter: Math.ceil(delayMs / MS_PER_SECOND) }
      : { singletonKey: filing.id }
  }

  async function enqueueFiling(filing: FilingRecord): Promise<boolean> {
    if (filing.channel === "email") {
      const data: FilingEmailJobData = { filingId: filing.id }
      await deps.jobs.enqueue(FILING_EMAIL_JOB, data, sendOptions(filing))
      return true
    }
    if (filing.channel === "portal" && deps.automaticFiling) {
      const data: FilingRunJobData = { filingId: filing.id, attempt: filing.attempts + 1 }
      await deps.jobs.enqueue(FILING_RUN_JOB, data, sendOptions(filing))
      return true
    }
    return false
  }

  async function runSweepPass(opts: { ignoreAge?: boolean } = {}): Promise<void> {
    if ((await deps.filings.getSettings()).paused) return
    const at = now()
    const channels: FilingChannel[] = deps.automaticFiling ? ["email", "portal"] : ["email"]
    const due = await deps.filings.listDueQueued({
      now: at,
      updatedBefore: opts.ignoreAge === true ? null : new Date(at.getTime() - SWEEP_MIN_AGE_MS),
      channels,
      limit: FILING_DUE_MAX_LIMIT,
    })
    for (const filing of due) await enqueueFiling(filing)
  }

  return { enqueueFiling, runSweepPass }
}
