import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import {
  CHECKIN_NOSHOW_SWEEP_JOB,
  WAITLIST_EXPIRE_SWEEP_JOB,
  WAITLIST_PROMOTE_JOB,
} from "../../lib/queue-names.js"
import { makeContainerRegistrationServices } from "./registration-wiring.js"
import type { WaitlistPromoteJob } from "./waitlist-service.js"

function parseWaitlistPromoteJob(data: unknown): WaitlistPromoteJob | null {
  if (typeof data !== "object" || data === null) return null
  const ticketTypeId = (data as { ticketTypeId?: unknown }).ticketTypeId
  if (typeof ticketTypeId !== "string" || ticketTypeId.length === 0) return null
  return { ticketTypeId }
}

export async function registerRegistrationJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const env = container.env
  const services = () => makeContainerRegistrationServices(container, undefined, logger)

  await container.jobs.work(WAITLIST_PROMOTE_JOB, async (job) => {
    const data = parseWaitlistPromoteJob(job.data)
    if (data === null) {
      logger?.warn({ jobId: job.id }, "waitlist.promote: malformed job data (skipped)")
      return
    }
    const offered = await services().waitlist.runPromote(data)
    if (offered > 0) {
      logger?.info({ ticketTypeId: data.ticketTypeId, offered }, "waitlist.promote: offers sent")
    }
  })

  await container.jobs.schedule(WAITLIST_EXPIRE_SWEEP_JOB, env.WAITLIST_EXPIRE_CRON)
  await container.jobs.work(WAITLIST_EXPIRE_SWEEP_JOB, async () => {
    const expired = await services().waitlist.runExpireSweep()
    if (expired > 0) logger?.info({ expired }, "waitlist.expire.sweep: offers released")
  })

  await container.jobs.schedule(CHECKIN_NOSHOW_SWEEP_JOB, env.CHECKIN_NOSHOW_CRON)
  await container.jobs.work(CHECKIN_NOSHOW_SWEEP_JOB, async () => {
    const marked = await services().checkin.runNoShowSweep()
    if (marked > 0) logger?.info({ marked }, "checkin.noshow.sweep: seats marked no-show")
  })
}
