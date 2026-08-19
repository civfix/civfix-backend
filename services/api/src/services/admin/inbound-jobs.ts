
import type { Container } from "../../di.js"
import { runInboundSweep } from "./inbound-sweep.js"

export const INBOUND_SWEEP_JOB = "inbound.sweep"

export async function registerInboundJobs(container: Container): Promise<void> {
  await container.jobs.schedule(INBOUND_SWEEP_JOB, container.env.INBOUND_SWEEP_CRON)
  await container.jobs.work(INBOUND_SWEEP_JOB, async () => {
    const result = await runInboundSweep(container)
    if (result.listError !== undefined) {
      console.error(
        `inbound.sweep: R2 LIST of '${container.env.R2_INBOUND_BUCKET ?? container.env.R2_BUCKET}' failed ` +
          `(grant the R2 token Object Read & Write on that bucket): ${result.listError}`,
      )
    } else if (result.processed > 0 || result.errors > 0 || result.parked > 0) {
      console.info(
        `inbound.sweep: scanned=${result.scanned} processed=${result.processed} errors=${result.errors} parked=${result.parked}`,
      )
    }
  })
}
