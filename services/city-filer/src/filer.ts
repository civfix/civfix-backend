import type { FilingsWorker } from "@civfix/api/filings-worker"
import type { Storage } from "@civfix/seams"
import type { FilerConfig, FilerLog } from "./config.js"
import type { FilerRunner } from "./filer-process.js"
import type { FilerJobs } from "./jobs.js"

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

export function startFiler(_deps: FilerDeps): Promise<Filer> {
  throw new Error("not implemented")
}
