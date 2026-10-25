import type { FilingsWorker } from "@civfix/api/filings-worker"
import type { Jobs } from "@civfix/seams"
import type { FilerConfig, FilerLog } from "./config.js"

export interface ReconcileDeps {
  filings: Pick<FilingsWorker, "listRunningFilings">
  jobs: Pick<Jobs, "enqueue">
  config: Pick<FilerConfig, "workspaceDir" | "dryRun">
  log: FilerLog
}

export function reconcileRunningFilings(deps: ReconcileDeps): Promise<void> {
  void deps
  throw new Error("not implemented")
}
