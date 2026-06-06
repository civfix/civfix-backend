/**
 * Outreach jobs seam (Phase 2). The single extension point where the "outreach.digest" pg-boss cron +
 * worker are registered. Wired into the server's job-start path (server.ts start()), right after the API
 * queues start and ONLY when real (pg-boss) jobs back a real database, so an all-fakes offline boot never
 * touches pg-boss.
 *
 * What it wires:
 *   1. schedule the cron: container.jobs.schedule("outreach.digest", env.OUTREACH_DIGEST_CRON). A cron
 *      tick enqueues an "outreach.digest" job with NO geoid -> the worker runs the full sweep.
 *   2. register the worker: container.jobs.work("outreach.digest", handler). The handler dispatches on
 *      job.data.geoid: present (the targeted job discovery's "Save & route" enqueues with
 *      singletonKey=geoid) -> run that one jurisdiction's digest; absent (the cron sweep) -> run every
 *      due candidate.
 * The "outreach.digest" queue itself is created in PgBossJobs.start() (API_QUEUE_NAMES), which runs before
 * this, so schedule/work never race a missing queue (pg-boss v10 requires the queue to exist first).
 *
 * The OutreachService (mail-repo throttle + outreach-repo aggregation + OutboundMailService send) enforces
 * <=1 outreach / jurisdiction / OUTREACH_THROTTLE_DAYS via outreach_state, aggregates waiting reports into
 * one digest, sends via the Mailer (From MAIL_FROM_OUTREACH), records the out thread/message + a 'sent'
 * mail_events row, and stamps outreach_state.last_outreach_at. Each jurisdiction actually sent is recorded
 * as a SYSTEM audit row (outreach.digest_sent), since the cron/job context has no operator userId.
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

  // 1. Schedule the daily sweep. A cron-fired job carries the schedule's default data ({}), so its
  //    handler sees no geoid and runs the full sweep.
  await container.jobs.schedule(OUTREACH_DIGEST_JOB, container.env.OUTREACH_DIGEST_CRON)

  // 2. Register the worker for both the cron sweep AND the targeted save-and-route jobs.
  await container.jobs.work(OUTREACH_DIGEST_JOB, async (job) => {
    const geoid = extractGeoid(job.data)
    const results =
      geoid !== null ? [await service.runForGeoid(geoid)] : await service.runSweep()
    await auditSent(container, results)
  })
}

/**
 * Build the OutreachService from the container's DB-backed seams: the Drizzle outreach repo (digest
 * aggregation + candidates), the Drizzle mail repo (throttle state), and the OutboundMailService over the
 * container's Mailer. Exported-shape kept internal; the job is the only caller.
 */
export function makeOutreachServiceFromContainer(container: Container): OutreachService {
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
