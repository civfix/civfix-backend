import type { FastifyBaseLogger } from "fastify"
import type { Container } from "../../di.js"
import {
  BROADCAST_CHUNK_JOB,
  BROADCAST_PLAN_JOB,
  BROADCAST_SCHEDULE_SWEEP_JOB,
  EVENT_METRICS_ROLLUP_JOB,
  EVENT_REMINDERS_SWEEP_JOB,
  HOST_EXPORT_JOB,
  HOST_EXPORT_REAP_JOB,
  HOST_RETENTION_SWEEP_JOB,
} from "../../lib/queue-names.js"
import {
  parseBroadcastChunkJob,
  parseBroadcastPlanJob,
  parseHostExportJob,
} from "./broadcast-queues.js"
import { makeCommsRuntime } from "./comms-wiring.js"
import { drainTable, registerRetentionLane, runRetentionLanes } from "./retention-lanes.js"
import { makeDrizzleHostExportRepository } from "./export-repository.drizzle.js"
import { makeDrizzleBroadcastRepository } from "./broadcast-repository.drizzle.js"
import { makeDrizzleHostTeamRepository } from "./host-team-repository.drizzle.js"
import { TEAM_INVITE_EMAIL_SCRUB_DELAY_MS } from "./host-team-service.js"
import { runRegistrationRetentionLanes } from "./registration-retention.js"
import { MS_PER_DAY } from "../../lib/time.js"

const DELIVERY_RETENTION_DAYS = 180
const BROADCAST_CONTENT_RETENTION_DAYS = 180
const EXPORT_ROW_RETENTION_DAYS = 90
const EXPORT_REAP_LIMIT = 200

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY)
}

export async function registerCommsJobs(
  container: Container,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const env = container.env
  const runtime = () => makeCommsRuntime(container, logger)

  async function workParsed<T>(
    jobName: string,
    parseJob: (data: unknown) => T | null,
    run: (data: T) => Promise<unknown>,
  ): Promise<void> {
    await container.jobs.work(jobName, async (job) => {
      const data = parseJob(job.data)
      if (data === null) {
        logger?.warn({ jobId: job.id }, `${jobName}: malformed job data (skipped)`)
        return
      }
      await run(data)
    })
  }

  registerHostRetentionLanes()

  await workParsed(BROADCAST_PLAN_JOB, parseBroadcastPlanJob, (data) =>
    runtime().pipeline.plan(data.broadcastId),
  )

  await workParsed(BROADCAST_CHUNK_JOB, parseBroadcastChunkJob, (data) =>
    runtime().pipeline.runChunk(data.broadcastId, data.chunkNo, data.authRetry),
  )

  await container.jobs.schedule(BROADCAST_SCHEDULE_SWEEP_JOB, env.BROADCAST_SWEEP_CRON)
  await container.jobs.work(BROADCAST_SCHEDULE_SWEEP_JOB, async () => {
    const result = await runtime().pipeline.sweep()
    logger?.info({ evt: "broadcast.sweep.done", ...result }, "broadcast schedule sweep complete")
  })

  await container.jobs.schedule(EVENT_REMINDERS_SWEEP_JOB, env.EVENT_REMINDERS_CRON)
  await container.jobs.work(EVENT_REMINDERS_SWEEP_JOB, async () => {
    await runtime().lanes.runReminderSweep()
  })

  await container.jobs.schedule(EVENT_METRICS_ROLLUP_JOB, env.METRICS_ROLLUP_CRON)
  await container.jobs.work(EVENT_METRICS_ROLLUP_JOB, async () => {
    const metrics = runtime().metrics
    const flushed = await metrics.flushCounters()
    const rolled = await metrics.rollup()
    logger?.info(
      { evt: "metrics.rollup.done", ...flushed, ...rolled },
      "event metrics rollup complete",
    )
  })

  await workParsed(HOST_EXPORT_JOB, parseHostExportJob, (data) =>
    runtime().exports.run(data.exportId),
  )

  await container.jobs.schedule(HOST_EXPORT_REAP_JOB, env.HOST_EXPORT_REAP_CRON)
  await container.jobs.work(HOST_EXPORT_REAP_JOB, async () => {
    const result = await runtime().exports.reap(EXPORT_REAP_LIMIT)
    logger?.info({ evt: "host.export.reap.done", ...result }, "host export reap complete")
  })

  await container.jobs.schedule(HOST_RETENTION_SWEEP_JOB, env.HOST_RETENTION_CRON)
  await container.jobs.work(HOST_RETENTION_SWEEP_JOB, async () => {
    await runRetentionLanes(container.getDb().sql, new Date(), logger)
  })
}

export function registerHostRetentionLanes(): void {
  registerRetentionLane("broadcast_deliveries", async (sql, now) => {
    const repo = makeDrizzleBroadcastRepository(sql)
    const cutoff = daysBefore(now, DELIVERY_RETENTION_DAYS)
    return drainTable((batchSize) => repo.deleteOldDeliveries(cutoff, batchSize))
  })

  registerRetentionLane("broadcast_content", async (sql, now) => {
    const repo = makeDrizzleBroadcastRepository(sql)
    const cutoff = daysBefore(now, BROADCAST_CONTENT_RETENTION_DAYS)
    return drainTable((batchSize) => repo.scrubBroadcastContent(cutoff, batchSize))
  })

  registerRetentionLane("host_exports", async (sql, now) => {
    const repo = makeDrizzleHostExportRepository(sql)
    const cutoff = daysBefore(now, EXPORT_ROW_RETENTION_DAYS)
    return drainTable((batchSize) => repo.deleteOlderThan(cutoff, batchSize))
  })

  registerRetentionLane("team_invite_expiry", (sql, now) => {
    const repo = makeDrizzleHostTeamRepository(sql)
    return drainTable((batchSize) => repo.expireStaleInvites(now, batchSize))
  })

  registerRetentionLane("team_invite_emails", (sql, now) => {
    const repo = makeDrizzleHostTeamRepository(sql)
    const cutoff = new Date(now.getTime() - TEAM_INVITE_EMAIL_SCRUB_DELAY_MS)
    return drainTable((batchSize) => repo.scrubInviteEmails(cutoff, batchSize))
  })

  registerRetentionLane("registrations", async (sql, now) => {
    const result = await runRegistrationRetentionLanes(sql, now)
    return (
      result.scrubbedAnswers +
      result.coarsenedCheckins +
      result.clearedAttendeeNames +
      result.clearedHostNotes
    )
  })
}
