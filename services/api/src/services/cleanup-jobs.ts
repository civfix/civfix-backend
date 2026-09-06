import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../di.js"
import { makeDrizzleCleanupRepository } from "./cleanup-repository.drizzle.js"
import { makeRouteNotificationService } from "./route-notifier.js"
import { makeCommsRuntime } from "./host/comms-wiring.js"
import { makeContainerGuestRsvpService } from "./guest-rsvp-wiring.js"
import {
  CLEANUP_CANCEL_FANOUT_JOB,
  makeCleanupService,
  type CleanupCancelFanoutJob,
} from "./cleanup-service.js"

export { CLEANUP_CANCEL_FANOUT_JOB }

export async function registerCleanupCancelFanoutJob(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  await container.jobs.work(CLEANUP_CANCEL_FANOUT_JOB, async (job) => {
    const data = parseCancelFanoutJob(job.data)
    if (data === null) {
      logger?.warn({ jobId: job.id }, "cleanup.cancel.fanout: malformed job data (skipped)")
      return
    }
    const service = makeCleanupService({
      repo: makeDrizzleCleanupRepository(container.getDb().sql),
      notifier: makeRouteNotificationService(container, logger),
      attendeeNotifier: makeCommsRuntime(container, logger).lanes,
      ...(logger !== undefined ? { logger } : {}),
    })
    await service.runCancelFanout(data)
    await makeContainerGuestRsvpService(container, undefined, logger).notifyGuestsBySms(
      data.cleanupId,
      "cancelled",
    )
  })
}

function parseCancelFanoutJob(data: unknown): CleanupCancelFanoutJob | null {
  if (typeof data !== "object" || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.cleanupId !== "string" || typeof d.actorId !== "string") return null
  const reason = typeof d.reason === "string" ? d.reason : null
  return { cleanupId: d.cleanupId, reason, actorId: d.actorId }
}
