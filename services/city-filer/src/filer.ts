import {
  FILING_QUEUE_OPTIONS,
  FILING_RESULT_JOB,
  FILING_RUN_JOB,
  type FilingsWorker,
} from "@civfix/api/filings-worker"
import type { Storage } from "@civfix/seams"
import { MS_PER_DAY } from "@civfix/api/time"
import type { FilerConfig, FilerLog } from "./config.js"
import { killAllFilerProcesses, type FilerRunner } from "./filer-process.js"
import type { FilerJobs } from "./jobs.js"
import { pruneRunDirs } from "./prune.js"
import { reconcileRunningFilings } from "./reconcile.js"
import { makeFilingRunHandler } from "./run-filing.js"

export interface FilerDeps {
  filings: FilingsWorker
  jobs: FilerJobs
  storage: Pick<Storage, "getObject" | "put">
  config: FilerConfig
  runner: FilerRunner
  log: FilerLog
  report: (err: unknown, context?: Record<string, unknown>) => void
}

export interface Filer {
  stop(): Promise<void>
}

/** Creates the filer's queues, settles the last process's runs, then works filing.run one at a time. */
export async function startFiler(deps: FilerDeps): Promise<Filer> {
  for (const name of [FILING_RUN_JOB, FILING_RESULT_JOB] as const) {
    await deps.jobs.createQueue(name, FILING_QUEUE_OPTIONS[name])
  }
  await reconcileRunningFilings(deps)
  const prune = () =>
    pruneRunDirs(deps.config.workspaceDir, { now: new Date(), log: deps.log }).catch(
      (err: unknown) => deps.report(err, { source: "prune" }),
    )
  await prune()
  const timer = setInterval(() => void prune(), MS_PER_DAY)
  // One run at a time (D7).
  await deps.jobs.work(FILING_RUN_JOB, makeFilingRunHandler(deps), { batchSize: 1 })
  return {
    async stop() {
      clearInterval(timer)
      killAllFilerProcesses()
      await deps.jobs.stop()
    },
  }
}
