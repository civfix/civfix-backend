import type { JobHandler } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import { FILING_RESULT_JOB } from "../../lib/queue-names.js"
import { makeContainerFilingService } from "./filing-wiring.js"
import { FilingResultPayloadSchema } from "./filings-worker.js"

/**
 * The `filing.result` handler. The payload comes from the filer, whose scripts run unreviewed, so it is
 * checked again here: every evidence key must be one the wrapper generated under this filing (D7).
 */
export function makeFilingResultHandler(
  applyFilingResult: (payload: unknown) => Promise<{ applied: boolean }>,
  logger?: Pick<FastifyBaseLogger, "warn">,
): JobHandler {
  return async (job) => {
    const payload = FilingResultPayloadSchema.parse(job.data)
    const key = new RegExp(`^filings/${payload.filingId}/[0-9a-f-]{36}\\.(png|jpg|mjs)$`)
    if (payload.evidence.some((e) => !key.test(e.r2Key))) {
      logger?.warn(
        { filingId: payload.filingId, runId: payload.runId },
        "filing result rejected: an evidence key outside its filing",
      )
      throw new Error("filing result rejected: an evidence key outside its filing")
    }
    await applyFilingResult(payload)
  }
}

/** pg-boss's default work loop: one job at a time per API process. */
export async function registerFilingResultJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await container.jobs.work(
    FILING_RESULT_JOB,
    makeFilingResultHandler(
      (payload) => makeContainerFilingService(container, logger).applyFilingResult(payload),
      logger,
    ),
  )
}
