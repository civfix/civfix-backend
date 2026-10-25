import type { FastifyBaseLogger } from "fastify"
import { z } from "zod"
import type { AdminReportRepository } from "../admin/admin-report-repository.js"
import type { ReporterNotifier } from "../admin/admin-report-types.js"
import { notifyReporterOfStatus } from "../admin/report-status-notifier.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import type {
  CityUpdateEffect,
  CityUpdateFiling,
  FilingIngestSql,
} from "./filing-ingest-sql.drizzle.js"
import { FilingClassificationSchema, type FilingClassification } from "./filings-worker.js"

export interface CityUpdateDeps {
  ingest: Pick<FilingIngestSql, "applyCityUpdate">
  reports: Pick<AdminReportRepository, "getReport">
  notifications?: ReporterNotifier
  chatEmitter?: ReportChatSystemEmitter
  logger?: Pick<FastifyBaseLogger, "warn">
}

const MIN_CONFIDENCE = 0.7

// D7's case id: anything else Claude read out of the city's text counts as no case id.
const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._#/-]{0,63}$/

const JobSchema = z.object({ filingMessageId: z.uuid(), classification: z.unknown() })

/**
 * D11/D12's effects of one classification. Only the fixed notes below reach the public timeline: the
 * city's text and Claude's summary never do.
 */
function planCityUpdate(
  c: FilingClassification | null,
  filing: CityUpdateFiling,
): CityUpdateEffect {
  if (c === null || c.confidence < MIN_CONFIDENCE) return { kind: "flag" }
  const city = filing.jurisdictionName ?? "The city"
  switch (c.status) {
    case "received": {
      const caseId = c.caseId !== null && CASE_ID_RE.test(c.caseId) ? c.caseId : null
      if (filing.caseId !== null || caseId === null) return { kind: "none" }
      return { kind: "case_id", caseId, note: `${city} received request ${caseId}` }
    }
    case "in_progress":
      if (filing.channel !== "portal") return { kind: "none" }
      return {
        kind: "report_status",
        from: ["acknowledged"],
        to: "in_progress",
        note:
          filing.caseId === null
            ? `${city} is working on this request`
            : `${city} is working on request ${filing.caseId}`,
        timelineKind: "status",
        cityClosed: false,
      }
    case "closed":
      return {
        kind: "report_status",
        from: ["acknowledged", "in_progress"],
        to: "resolved",
        note:
          filing.caseId === null
            ? `${city} closed the request`
            : `${city} closed request ${filing.caseId}`,
        timelineKind: "done",
        cityClosed: true,
      }
    case "needs_info":
      return { kind: "needs_info", reasonDetail: c.summary }
    case "other":
      return { kind: "none" }
  }
}

/** `filing.city_update`: applies a classification to its message's filing, once (D11). */
export function makeApplyCityUpdate(deps: CityUpdateDeps): (data: unknown) => Promise<void> {
  return async (data) => {
    const job = JobSchema.safeParse(data)
    // No message row to claim, and a retry carries the same payload.
    if (!job.success) {
      deps.logger?.warn({ issues: job.error.issues.length }, "filing.city_update: malformed job")
      return
    }
    const parsed = FilingClassificationSchema.safeParse(job.data.classification)
    const classification = parsed.success ? parsed.data : null
    const result = await deps.ingest.applyCityUpdate({
      messageId: job.data.filingMessageId,
      classification,
      plan: (filing) => planCityUpdate(classification, filing),
    })
    if (!result.claimed || !result.applied) return
    const { effect, filing } = result
    if (effect.kind === "case_id") {
      const report = await deps.reports.getReport(filing.reportId)
      if (report === null) return
      await deps.chatEmitter?.emit({
        reportId: filing.reportId,
        status: report.status,
        kind: "reply",
        note: effect.note,
      })
    } else if (effect.kind === "report_status") {
      const report = await deps.reports.getReport(filing.reportId)
      await notifyReporterOfStatus(deps, filing.reportId, report?.reporter?.id ?? null, effect.to)
      await deps.chatEmitter?.emit({
        reportId: filing.reportId,
        status: effect.to,
        kind: effect.timelineKind,
        note: effect.note,
      })
    }
  }
}
