import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeContainerGuestRsvpService } from "./guest-rsvp-wiring.js"
import {
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  GUEST_RETENTION_SWEEP_JOB,
  type GuestUpdateFanoutJob,
} from "./guest-rsvp-service.js"

export { CLEANUP_GUEST_UPDATE_FANOUT_JOB, GUEST_RETENTION_SWEEP_JOB }

export async function registerGuestJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await container.jobs.work(CLEANUP_GUEST_UPDATE_FANOUT_JOB, async (job) => {
    const data = parseUpdateFanoutJob(job.data)
    if (data === null) {
      logger?.warn(
        { jobId: job.id },
        "cleanup.guest.update.fanout: malformed job data (skipped)",
      )
      return
    }
    await makeContainerGuestRsvpService(container, undefined, logger).notifyEventUpdated(data)
  })

  await container.jobs.schedule(GUEST_RETENTION_SWEEP_JOB, container.env.GUEST_RETENTION_CRON)
  await container.jobs.work(GUEST_RETENTION_SWEEP_JOB, async () => {
    const result = await makeContainerGuestRsvpService(
      container,
      undefined,
      logger,
    ).runRetentionSweep()
    logger?.info(
      { scrubbedGuests: result.scrubbedGuests, deletedOtps: result.deletedOtps },
      "guest.retention.sweep: complete",
    )
  })
}

export function parseUpdateFanoutJob(data: unknown): GuestUpdateFanoutJob | null {
  if (typeof data !== "object" || data === null) return null
  const cleanupId = (data as { cleanupId?: unknown }).cleanupId
  if (typeof cleanupId !== "string" || cleanupId.length === 0) return null
  return { cleanupId }
}
