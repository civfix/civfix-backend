/**
 * Outreach jobs seam: registers the "outreach.digest" pg-boss cron + worker. A cron tick enqueues a job
 * with NO geoid -> full sweep; a targeted "Save & route" enqueues with singletonKey=geoid -> that one
 * jurisdiction. Each jurisdiction actually sent is recorded as a SYSTEM audit row (outreach.digest_sent),
 * since the cron/job context has no operator userId.
 *
 * GOTCHA: the "outreach.digest" queue is created in PgBossJobs.start() (API_QUEUE_NAMES) BEFORE this runs,
 * so schedule/work never race a missing queue (pg-boss v10 requires the queue to exist first).
 */

import type { Container } from "../../di.js"
import { writeAudit } from "./audit.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import { makeOutboundMailService } from "./outbound-mail-service.js"
import { makeDrizzleOutreachRepository } from "./outreach-repository.drizzle.js"
import { makeOutreachService, type OutreachRunResult, type OutreachService } from "./outreach-service.js"

/** The cron job name for the daily outreach digest sweep + the targeted per-geoid runs. */
export const OUTREACH_DIGEST_JOB = "outreach.digest"

/**
 * Register the outreach jobs (cron + worker). Called from server.ts start() after the API queues are up
 * and only under real pg-boss + a real DATABASE_URL (the caller gates this).
 */
export async function registerOutreachJobs(container: Container): Promise<void> {
  const service = makeOutreachServiceFromContainer(container)

  await container.jobs.schedule(OUTREACH_DIGEST_JOB, container.env.OUTREACH_DIGEST_CRON)
  await container.jobs.work(OUTREACH_DIGEST_JOB, async (job) => {
    const geoid = extractGeoid(job.data)
    const results =
      geoid !== null ? [await service.runForGeoid(geoid)] : await service.runSweep()
    await auditSent(container, results)
  })
}

/** Build the OutreachService from the container's DB-backed seams (Drizzle outreach + mail repos, the
 *  OutboundMailService over container.mailer). Internal; the job is the only caller. */
function makeOutreachServiceFromContainer(container: Container): OutreachService {
  const sql = container.getDb().sql
  const mailRepo = makeDrizzleMailRepository(sql)
  const outboundMail = makeOutboundMailService({
    repo: mailRepo,
    mailer: container.mailer,
    env: {
      MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
      MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
    },
  })
  return makeOutreachService({
    outreachRepo: makeDrizzleOutreachRepository(sql),
    mailRepo,
    outboundMail,
    throttleDays: container.env.OUTREACH_THROTTLE_DAYS,
  })
}

/** Pull a geoid string off a job payload, or null for a cron-sweep tick (no/blank geoid). */
function extractGeoid(data: unknown): string | null {
  if (data && typeof data === "object") {
    const value = (data as { geoid?: unknown }).geoid
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

/** Record one SYSTEM audit row per jurisdiction actually sent (actorId null = system action). */
async function auditSent(container: Container, results: OutreachRunResult[]): Promise<void> {
  const sql = container.getDb().sql
  for (const result of results) {
    if (!result.sent) continue
    await writeAudit(sql, {
      actorId: null,
      action: "outreach.digest_sent",
      target: `jurisdiction:${result.geoid}`,
      meta: {
        geoid: result.geoid,
        reportCount: result.reportCount,
        ...(result.threadId !== undefined ? { threadId: result.threadId } : {}),
      },
    })
  }
}
