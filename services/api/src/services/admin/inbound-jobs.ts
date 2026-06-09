/**
 * Inbound-mail sweep jobs seam. Registers the "inbound.sweep" pg-boss cron + worker. Wired into the
 * server's job-start path (server.ts start()), right after the API queues + outreach jobs start and ONLY
 * when real (pg-boss) jobs back a real database, so an all-fakes offline boot never touches pg-boss.
 *
 * What it wires:
 *   1. schedule the cron: container.jobs.schedule("inbound.sweep", env.INBOUND_SWEEP_CRON). Each tick
 *      runs runInboundSweep (LIST inbound/pending/ -> processInboundObject per key).
 *   2. register the worker: container.jobs.work("inbound.sweep", handler) running the same sweep (so a
 *      boot-time enqueue and the cron share one code path).
 * The "inbound.sweep" queue is created in PgBossJobs.start() (API_QUEUE_NAMES), which runs before this,
 * so schedule/work never race a missing queue (pg-boss v10 requires the queue to exist first).
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
    if (result.processed > 0 || result.errors > 0) {
      console.info(
        `inbound.sweep: scanned=${result.scanned} processed=${result.processed} errors=${result.errors}`,
      )
    }
  })
}
