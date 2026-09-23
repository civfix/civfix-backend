import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeContainerGuestRsvpService } from "./guest-rsvp-wiring.js"
import { makeCommsRuntime } from "./host/comms-wiring.js"
import type { EventUpdateVerdict } from "./host/broadcast-lanes.js"
import {
  CLEANUP_GUEST_UPDATE_FANOUT_JOB,
  GUEST_RETENTION_SWEEP_JOB,
  type GuestUpdateFanoutJob,
} from "./guest-rsvp-service.js"

export { CLEANUP_GUEST_UPDATE_FANOUT_JOB, GUEST_RETENTION_SWEEP_JOB }

export interface GuestUpdateFanoutDeps {
  announce: (cleanupId: string) => Promise<EventUpdateVerdict>
  notifyBySms: (cleanupId: string) => Promise<unknown>
  deferFanout: (cleanupId: string, startAfterSec: number) => Promise<void>
  logger?: Pick<FastifyBaseLogger, "info" | "warn">
}

export async function runGuestUpdateFanout(
  deps: GuestUpdateFanoutDeps,
  job: GuestUpdateFanoutJob,
): Promise<EventUpdateVerdict> {
  const verdict = await deps.announce(job.cleanupId)
  if (verdict.status === "started") {
    await deps.notifyBySms(job.cleanupId)
    return verdict
  }
  if (verdict.status === "throttled") {
    await deps.deferFanout(job.cleanupId, verdict.retryAfterSec)
    deps.logger?.info(
      {
        evt: "cleanup.guest.update.fanout.deferred",
        cleanupId: job.cleanupId,
        retryAfterSec: verdict.retryAfterSec,
      },
      "guest update fan-out coalesced into one deferred announcement at the end of the throttle window",
    )
  }
  return verdict
}

export async function registerGuestJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await container.jobs.work(CLEANUP_GUEST_UPDATE_FANOUT_JOB, async (job) => {
    const data = parseUpdateFanoutJob(job.data)
    if (data === null) {
      logger?.warn({ jobId: job.id }, "cleanup.guest.update.fanout: malformed job data (skipped)")
      return
    }
    await runGuestUpdateFanout(
      {
        announce: (cleanupId) => makeCommsRuntime(container, logger).lanes.eventUpdated(cleanupId),
        notifyBySms: (cleanupId) =>
          makeContainerGuestRsvpService(container, undefined, logger).notifyGuestsBySms(
            cleanupId,
            "updated",
          ),
        deferFanout: async (cleanupId, startAfterSec) => {
          await container.jobs.enqueue(
            CLEANUP_GUEST_UPDATE_FANOUT_JOB,
            { cleanupId },
            { singletonKey: `guest-update:${cleanupId}`, startAfter: startAfterSec, retryLimit: 3 },
          )
        },
        ...(logger !== undefined ? { logger } : {}),
      },
      data,
    )
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
