import type { FastifyBaseLogger } from "fastify"
import type { AdminReportRepository } from "../admin/admin-report-repository.js"
import type { ReporterNotifier } from "../admin/admin-report-types.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import type { FilingIngestSql } from "./filing-ingest-sql.drizzle.js"

export interface CityUpdateDeps {
  ingest: Pick<FilingIngestSql, "applyCityUpdate">
  reports: Pick<AdminReportRepository, "getReport">
  notifications?: ReporterNotifier
  chatEmitter?: ReportChatSystemEmitter
  logger?: Pick<FastifyBaseLogger, "warn">
}

export function makeApplyCityUpdate(_deps: CityUpdateDeps): (data: unknown) => Promise<void> {
  return () => Promise.reject(new Error("not implemented"))
}
