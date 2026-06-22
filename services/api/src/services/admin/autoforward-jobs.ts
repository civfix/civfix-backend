/**
 * Report auto-forward job (D9 / #56): registers the `report.autoforward` pg-boss worker.
 *
 * report-service.createReport enqueues `{ reportId }` (singletonKey=reportId) AFTER the create tx commits,
 * ONLY for a report_verified, non-anonymous reporter. This worker emails that report to its jurisdiction
 * using the EXISTING per-report send (AdminReportService.routeToJurisdiction) + records a timeline row.
 *
 * NEVER-THROW INVARIANT (mirrors the media-worker): a routing/SMTP failure — including the B-bugs 409
 * "sender not approved" classification or any transient SMTP error — is CAUGHT, logged, and the job
 * COMPLETES (the failed-send mail_event recording captures it; the report stays published for manual
 * routing). The handler also COMPLETES as a no-op when the report is gone, has no jurisdiction, has no
 * routing contact, or was already routed (an existing outreach thread / acknowledged) — idempotency on top
 * of the enqueue-side singletonKey.
 *
 * The queue is created in PgBossJobs.start() (API_QUEUE_NAMES) BEFORE this work() call, so work() never
 * races a missing queue.
 */

import type { Container } from "../../di.js"
import { REPORT_AUTOFORWARD_JOB, type ReportAutoForwardJob } from "../report-service.types.js"
import { makeAdminReportService, type AdminReportService } from "./admin-report-service.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import { makeOutboundMailService } from "./outbound-mail-service.js"
import { makeDrizzleMailRepository } from "./mail-repository.drizzle.js"
import { makeMediaPresigner } from "../media-presign.js"

export { REPORT_AUTOFORWARD_JOB }

/** Minimal logger seam (Fastify's app.log satisfies it); optional so the worker logs only when supplied. */
export interface AutoForwardLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

/** Register the report.autoforward worker. Gated by the caller on real pg-boss + a real DATABASE_URL. */
export async function registerAutoForwardJobs(
  container: Container,
  logger?: AutoForwardLogger,
): Promise<void> {
  await container.jobs.work(REPORT_AUTOFORWARD_JOB, async (job) => {
    const reportId = extractReportId(job.data)
    if (reportId === null) return // Malformed payload: nothing to forward.
    await runAutoForward(container, reportId, logger)
  })
}

/**
 * Auto-forward one report: load it, skip (complete) when it has no routable jurisdiction contact OR was
 * already routed, else call the existing per-report send. NEVER throws — every failure is caught + logged.
 */
export async function runAutoForward(
  container: Container,
  reportId: string,
  logger?: AutoForwardLogger,
): Promise<void> {
  await runAutoForwardWith(makeAutoForwardService(container), reportId, logger)
}

/**
 * The auto-forward branch logic over an already-built AdminReportService (the DB-free seam used by the
 * unit tests; runAutoForward wires the Drizzle-backed service). NEVER throws: every failure is caught +
 * logged and the job completes.
 */
export async function runAutoForwardWith(
  service: AdminReportService,
  reportId: string,
  logger?: AutoForwardLogger,
): Promise<void> {
  try {
    // Idempotency: a report already routed (an outreach thread exists / past not_sent) is left alone, so a
    // re-delivered job can't double-send. Mirrors the enqueue-side singletonKey with a load-time guard.
    const detail = await service.get(reportId)
    if (detail.outreach.status !== "not_sent") {
      logger?.info({ reportId }, "report.autoforward skip: already routed")
      return
    }
    // No resolved jurisdiction OR no contact on file -> not routable. Leave the report published for manual
    // routing (routeToJurisdiction would throw notRoutable; pre-check so the common case isn't an exception).
    if (detail.geoid === null || detail.city.contact === null || detail.city.contact === "") {
      logger?.info({ reportId }, "report.autoforward skip: no routing contact")
      return
    }

    // The send itself. actorId null = a system action (no operator). A routing/SMTP failure (incl. the
    // 409 sender-not-approved classification) throws here; the catch below completes the job.
    await service.routeToJurisdiction(reportId, {
      contactEmailOverride: null,
      note: null,
      actorId: null,
    })
  } catch (err) {
    // NEVER-THROW: log + complete. The failed-send mail_event row (recorded by the outbound-mail path)
    // captures the SMTP/auth failure; the report stays published so an operator can route it manually.
    logger?.warn({ err, reportId }, "report.autoforward failed (completing job)")
  }
}

/** Build the AdminReportService over the container's DB-backed seams (Drizzle report + mail repos). */
function makeAutoForwardService(container: Container): AdminReportService {
  const sql = container.getDb().sql
  const outboundMail = makeOutboundMailService({
    repo: makeDrizzleMailRepository(sql),
    mailer: container.mailer,
    env: {
      MAIL_FROM_OUTREACH: container.env.MAIL_FROM_OUTREACH,
      MAIL_REPLY_DOMAIN: container.env.MAIL_REPLY_DOMAIN,
    },
  })
  return makeAdminReportService({
    repo: makeDrizzleAdminReportRepository(sql),
    outboundMail,
    presignMedia: makeMediaPresigner(container.storage),
    // The packet's binary photo attachments load over the Storage seam (same as the operator route path).
    loadMediaBytes: (k) => container.storage.getObject(k),
  })
}

/** Pull the reportId string off a job payload, or null when malformed. */
function extractReportId(data: unknown): string | null {
  if (data && typeof data === "object") {
    const value = (data as Partial<ReportAutoForwardJob>).reportId
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}
