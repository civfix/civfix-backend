import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import { FILING_EMAIL_JOB, FILING_SWEEP_JOB } from "../../lib/queue-names.js"
import { makeContainerFilingEmailHandler, makeContainerFilingService } from "./filing-wiring.js"

const FILING_SWEEP_CRON = "*/10 * * * *"

/**
 * The API's filing queues that have a worker here. The other four filing queues are created at start
 * (PgBossJobs) and their jobs wait in pg-boss until the worker that owns each one starts (D17).
 */
export async function registerFilingJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await container.jobs.schedule(FILING_SWEEP_JOB, FILING_SWEEP_CRON)
  await container.jobs.work(FILING_SWEEP_JOB, async () => {
    await makeContainerFilingService(container, logger).runSweepPass()
  })
  await container.jobs.work(FILING_EMAIL_JOB, (job) =>
    makeContainerFilingEmailHandler(container, logger)(job),
  )
}
