import type { FilingsWorker } from "@civfix/api/filings-worker"
import type { JobHandler, Jobs, Storage } from "@civfix/seams"
import type { FilerConfig, FilerLog } from "./config.js"
import type { FilerRunner } from "./filer-process.js"

export interface FilingRunDeps {
  filings: Pick<
    FilingsWorker,
    "getFilingSettings" | "claimFiling" | "isReportFileable" | "loadRunPacket"
  >
  jobs: Pick<Jobs, "enqueue">
  storage: Pick<Storage, "getObject" | "put">
  config: FilerConfig
  runner: FilerRunner
  log: FilerLog
  report: (err: unknown, context?: Record<string, unknown>) => void
}

export function makeFilingRunHandler(deps: FilingRunDeps): JobHandler {
  void deps
  return () => {
    throw new Error("not implemented")
  }
}
