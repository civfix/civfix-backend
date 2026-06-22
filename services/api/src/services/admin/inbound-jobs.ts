/**
 * Inbound-mail sweep jobs seam: registers the "inbound.sweep" pg-boss cron + worker (both run the same
 * runInboundSweep, which is idempotent on message_id and never throws). GOTCHA: the queue is created in
 * PgBossJobs.start() (API_QUEUE_NAMES) BEFORE this runs, so schedule/work never race a missing queue
 * (pg-boss v10 requires the queue to exist first).
 */

import type { Container } from "../../di.js"
import { runInboundSweep } from "./inbound-sweep.js"

/** The cron job name for the inbound-mail reconciliation sweep. */
export const INBOUND_SWEEP_JOB = "inbound.sweep"

/**
 * Register the inbound sweep cron + worker. Called from server.ts start() after the API queues are up
 * and only under real pg-boss + a real DATABASE_URL (the caller gates this).
 */
export async function registerInboundJobs(container: Container): Promise<void> {
  await container.jobs.schedule(INBOUND_SWEEP_JOB, container.env.INBOUND_SWEEP_CRON)
  await container.jobs.work(INBOUND_SWEEP_JOB, async () => {
    const result = await runInboundSweep(container)
    if (result.listError !== undefined) {
      // The backlog could not even be listed — almost always the R2 token is not scoped to
      // R2_INBOUND_BUCKET (403). Log loudly + actionably: buffered email piles up in R2 until fixed.
      console.error(
        `inbound.sweep: R2 LIST of '${container.env.R2_INBOUND_BUCKET ?? container.env.R2_BUCKET}' failed ` +
          `(grant the R2 token Object Read & Write on that bucket): ${result.listError}`,
      )
    } else if (result.processed > 0 || result.errors > 0) {
      console.info(
        `inbound.sweep: scanned=${result.scanned} processed=${result.processed} errors=${result.errors}`,
      )
    }
  })
}
