
import { AppError, ErrorCode } from "@civfix/shared"
import type { Container } from "../../di.js"
import { REPORT_AUTOFORWARD_JOB, type ReportAutoForwardJob } from "../report-service.types.js"
import {
  isAlreadyRoutedConflict,
  makeAdminReportService,
  type AdminReportService,
} from "./admin-report-service.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import { makeContainerOutboundMailService } from "./outbound-mail-service.js"
import { makeMediaPresigner } from "../media-presign.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"

export { REPORT_AUTOFORWARD_JOB }

export interface AutoForwardLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

export async function registerAutoForwardJobs(
  container: Container,
  logger?: AutoForwardLogger,
): Promise<void> {
  await container.jobs.work(REPORT_AUTOFORWARD_JOB, async (job) => {
    const reportId = extractReportId(job.data)
    if (reportId === null) return
    await runAutoForward(container, reportId, logger)
  })
}

export async function runAutoForward(
  container: Container,
  reportId: string,
  logger?: AutoForwardLogger,
): Promise<void> {
  await runAutoForwardWith(makeAutoForwardService(container), reportId, logger)
}

export async function runAutoForwardWith(
  service: AdminReportService,
  reportId: string,
  logger?: AutoForwardLogger,
): Promise<void> {
  try {
    const detail = await service.get(reportId)
    if (detail.geoid === null || detail.city.contact === null || detail.city.contact === "") {
      logger?.info({ reportId }, "report.autoforward skip: no routing contact")
      return
    }

    // NO outreach-status pre-check here. routeToJurisdiction owns the duplicate-send decision and is the
    // only place that can make it correctly: it sees whether the recorded send actually landed (a thread is
    // stamped 'sent' BEFORE the mailer runs, so a delivery throw looks identical from the DTO this job
    // reads). A "skip anything not not_sent" pre-check therefore made a transient mailer failure permanent —
    // pg-boss re-ran the job and the job itself refused to retry. Delegating means the retry goes through
    // and a genuinely-sent report comes back as a CONFLICT below.
    await service.routeToJurisdiction(reportId, {
      contactEmailOverride: null,
      note: null,
      actorId: null,
    })
  } catch (err) {
    // The service's idempotency gate specifically: this report already reached its jurisdiction. A completed
    // job, not a failure — log at info so it does not read as an error in the outreach trail. Matched
    // narrowly (isAlreadyRoutedConflict) because a CONFLICT can also come from the MAILER — OCI's 409 for an
    // unapproved sender — which is a genuine send failure that must stay a warn.
    if (isAlreadyRoutedConflict(err)) {
      logger?.info({ reportId }, "report.autoforward skip: already sent to its jurisdiction")
      return
    }
    if (isTransientInfraError(err)) {
      logger?.warn({ err, reportId }, "report.autoforward transient failure (retrying)")
      throw err
    }
    logger?.warn({ err, reportId }, "report.autoforward failed (completing job)")
  }
}

function isTransientInfraError(err: unknown): boolean {
  if (err instanceof AppError) {
    return err.code === ErrorCode.INTERNAL || err.code === ErrorCode.RATE_LIMITED
  }
  return true
}

function makeAutoForwardService(container: Container): AdminReportService {
  const sql = container.getDb().sql
  // Through the shared factory, not a hand-built makeOutboundMailService: the auto-forward job sends the
  // SAME report packet as the manual route, so it must read the same MAIL_* slice. Hand-building it here
  // meant every new mail knob needed a coordinated edit in each copy.
  const outboundMail = makeContainerOutboundMailService(container)
  return makeAdminReportService({
    repo: makeDrizzleAdminReportRepository(sql),
    outboundMail,
    presignMedia: makeMediaPresigner(container.storage),
    loadMediaBytes: (k) => container.storage.getObject(k),
    // D-D1: auto-routing (-> acknowledged) posts a system message into the report chat too (no-op fake).
    reportChatEmitter: makeContainerReportChatEmitter(container),
  })
}

function extractReportId(data: unknown): string | null {
  if (data && typeof data === "object") {
    const value = (data as Partial<ReportAutoForwardJob>).reportId
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}
