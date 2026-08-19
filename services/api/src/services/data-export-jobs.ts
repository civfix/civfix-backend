import { AppError, ErrorCode } from "@civfix/shared"
import type { Env } from "../env.js"
import type { Container } from "../di.js"
import {
  makeDataExportService,
  type DataExportService,
} from "./data-export-service.js"

export const DATA_EXPORT_JOB = "data.export"

export interface DataExportJob {
  userId: string
}

export interface DataExportJobLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

export interface RegisterDataExportOpts {
  logger?: DataExportJobLogger
  makeService?: (container: Container) => DataExportService
}

export function dataExportSupportEmail(env: Env): string {
  return `support@${env.MAIL_REPLY_DOMAIN}`
}

export async function registerDataExportJobs(
  container: Container,
  opts?: RegisterDataExportOpts,
): Promise<void> {
  const make = opts?.makeService ?? makeContainerDataExportService
  await container.jobs.work(DATA_EXPORT_JOB, async (job) => {
    const userId = extractUserId(job.data)
    if (userId === null) return
    await runDataExport(make(container), userId, opts?.logger)
  })
}

export async function runDataExport(
  service: DataExportService,
  userId: string,
  logger?: DataExportJobLogger,
): Promise<void> {
  try {
    const result = await service.exportData(userId)
    if (result.email === null) {
      logger?.info({ userId }, "data.export skip: no delivery channel")
    }
  } catch (err) {
    if (isTransientInfraError(err)) {
      logger?.warn({ err, userId }, "data.export transient failure (retrying)")
      throw err
    }
    logger?.warn({ err, userId }, "data.export failed (completing job)")
  }
}

function makeContainerDataExportService(container: Container): DataExportService {
  return makeDataExportService({
    sql: container.getDb().sql,
    mailer: container.mailer,
    fromNoReply: container.env.MAIL_FROM_NOREPLY,
    supportEmail: dataExportSupportEmail(container.env),
  })
}

function isTransientInfraError(err: unknown): boolean {
  if (err instanceof AppError) {
    return err.code === ErrorCode.INTERNAL || err.code === ErrorCode.RATE_LIMITED
  }
  return true
}

function extractUserId(data: unknown): string | null {
  if (data && typeof data === "object") {
    const value = (data as Partial<DataExportJob>).userId
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}
