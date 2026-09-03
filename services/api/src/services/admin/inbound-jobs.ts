
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
    } else if (
      result.processed > 0 ||
      result.errors > 0 ||
      result.parked > 0 ||
      result.effectsRedriven > 0 ||
      result.effectsErrors > 0
    ) {
      console.info(
        `inbound.sweep: scanned=${result.scanned} processed=${result.processed} errors=${result.errors} ` +
          `parked=${result.parked} effectsRedriven=${result.effectsRedriven} effectsErrors=${result.effectsErrors}`,
      )
    }
    if (result.effectsErrors > 0) {
      throw new Error(
        `inbound.sweep: ${result.effectsErrors} inbound message(s) failed their side effects; ` +
          `they stay unclaimed and are retried on the next run`,
      )
    }
  })
}
