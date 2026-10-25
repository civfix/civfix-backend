import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { FilingsWorker } from "@civfix/api/filings-worker"
import type { Jobs } from "@civfix/seams"
import type { FilerConfig, FilerLog } from "./config.js"
import { sendFilingResult } from "./hand-back.js"
import { SUBMIT_MARKER } from "./script.js"

export interface ReconcileDeps {
  filings: Pick<FilingsWorker, "listRunningFilings">
  jobs: Pick<Jobs, "enqueue">
  config: Pick<FilerConfig, "workspaceDir" | "dryRun">
  log: FilerLog
}

/**
 * At boot, before the queue is worked: a filing still `running` lost its run with the last process.
 * Only its current run's directory is read; a marker there means the submit may have landed (D6).
 */
export async function reconcileRunningFilings(deps: ReconcileDeps): Promise<void> {
  for (const filing of await deps.filings.listRunningFilings()) {
    if (filing.runId === null) {
      deps.log("filer: a running filing has no run id; left as it is", { filingId: filing.id })
      continue
    }
    const runDir = join(deps.config.workspaceDir, "runs", `${filing.id}-${filing.runId}`)
    const marker = await lstat(join(runDir, "out", SUBMIT_MARKER)).then(
      () => true,
      () => false,
    )
    await sendFilingResult(deps.jobs, {
      filingId: filing.id,
      runId: filing.runId,
      attempt: filing.attempts,
      outcome: "failed",
      reason: marker ? "uncertain_submission" : "portal_error",
      dryRun: deps.config.dryRun,
      evidence: [],
    })
    deps.log("filer: an interrupted run was reported", { filingId: filing.id, marker })
  }
}
