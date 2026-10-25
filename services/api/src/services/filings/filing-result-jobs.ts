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
): JobHandler {
  return async (job) => {
    const payload = FilingResultPayloadSchema.parse(job.data)
    const key = new RegExp(`^filings/${payload.filingId}/[0-9a-f-]{36}\\.(png|jpg|mjs)$`)
    const foreign = payload.evidence.find((e) => !key.test(e.r2Key))
    if (foreign !== undefined)
      throw new Error("filing result rejected: an evidence key outside its filing")
    await applyFilingResult(payload)
  }
}

/** pg-boss's default work loop takes one job at a time, which applyFilingResult's run-id check relies on. */
export async function registerFilingResultJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await container.jobs.work(
    FILING_RESULT_JOB,
    makeFilingResultHandler((payload) =>
      makeContainerFilingService(container, logger).applyFilingResult(payload),
    ),
  )
}
