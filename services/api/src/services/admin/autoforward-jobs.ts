import { AppError, ErrorCode } from "@civfix/shared"
import type { Container } from "../../di.js"
import { REPORT_AUTOFORWARD_JOB, type ReportAutoForwardJob } from "../report-service.types.js"
import {
  isAlreadyRoutedConflict,
  makeAdminReportService,
  type AdminReportService,
} from "./admin-report-service.js"
import { makeDrizzleAdminReportRepository } from "./admin-report-repository.drizzle.js"
import { makeDrizzleForwardTemplateRepository } from "./forward-template-repository.drizzle.js"
import {
  isOutboundSendDeadlineError,
  makeContainerOutboundMailService,
} from "./outbound-mail-service.js"
import { makePacketMediaPresigner, makePrivateMediaPresigner } from "../media-presign.js"
import { makeContainerReportChatEmitter } from "../report-chat-emitter.js"

export interface AutoForwardLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

export interface AutoForwardJobLogger extends AutoForwardLogger {
  error: (obj: unknown, msg?: string) => void
}

export async function registerAutoForwardJobs(
  container: Container,
  logger?: AutoForwardJobLogger,
): Promise<void> {
  await container.jobs.work(REPORT_AUTOFORWARD_JOB, async (job) => {
    const reportId = extractReportId(job.data)
    if (reportId === null) return
    await runAutoForward(container, reportId, logger)
  })
}

async function runAutoForward(
  container: Container,
  reportId: string,
  logger?: AutoForwardJobLogger,
): Promise<void> {
  await runAutoForwardWith(makeAutoForwardService(container, logger), reportId, logger)
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

    await service.routeToJurisdiction(reportId, { note: null, actorId: null })
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

// Reporter notifications and linked events are left out on purpose: the job only reads the routing
// contact and routes, and neither path uses them.
function makeAutoForwardService(
  container: Container,
  logger: AutoForwardJobLogger | undefined,
): AdminReportService {
  const sql = container.getDb().sql
  const withLogger = logger !== undefined ? { logger } : {}
  return makeAdminReportService({
    repo: makeDrizzleAdminReportRepository(sql, withLogger),
    outboundMail: makeContainerOutboundMailService(container, withLogger),
    presignMedia: makePrivateMediaPresigner(container.storage),
    presignPacketMedia: makePacketMediaPresigner(container.storage),
    loadMediaBytes: (k) => container.storage.getObject(k),
    reportChatEmitter: makeContainerReportChatEmitter(container, logger),
    forwardTemplates: makeDrizzleForwardTemplateRepository(sql),
    ...withLogger,
  })
}

function extractReportId(data: unknown): string | null {
  if (data && typeof data === "object") {
    const value = (data as Partial<ReportAutoForwardJob>).reportId
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}
