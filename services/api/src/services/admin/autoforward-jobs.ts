import { AppError, ErrorCode } from "@civfix/shared"
import type { Container } from "../../di.js"
import { REPORT_AUTOFORWARD_JOB, type ReportAutoForwardJob } from "../report-service.types.js"
import {
  isAlreadyRoutedConflict,
  makeAdminReportService,
  type AdminReportService,
} from "./admin-report-service.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import {
  isOutboundSendDeadlineError,
  makeContainerOutboundMailService,
} from "./outbound-mail-service.js"
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

    await service.routeToJurisdiction(reportId, {
      contactEmailOverride: null,
      note: null,
      actorId: null,
    })
  } catch (err) {
    if (isAlreadyRoutedConflict(err)) {
      logger?.info({ reportId }, "report.autoforward skip: already sent to its jurisdiction")
      return
    }
    if (isOutboundSendDeadlineError(err)) {
      logger?.warn(
        { err, reportId },
        "report.autoforward send exceeded its deadline (outcome unknown; not retried)",
      )
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
  const outboundMail = makeContainerOutboundMailService(container)
  return makeAdminReportService({
    repo: makeDrizzleAdminReportRepository(sql),
    outboundMail,
    presignMedia: makeMediaPresigner(container.storage),
    loadMediaBytes: (k) => container.storage.getObject(k),
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
