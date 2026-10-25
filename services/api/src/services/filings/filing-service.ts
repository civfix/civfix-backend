import { AppError } from "@civfix/contract"
import type {
  AdminFilingDTO,
  AdminReportFilingRoute,
  ReportCategory,
  ReportTimelineItem,
} from "@civfix/contract"
import type { Jobs } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { WriteAuditInput } from "../admin/audit.js"
import type {
  AdminReportRecord,
  AdminReportRepository,
  AdminReportRoutingRecord,
} from "../admin/admin-report-repository.js"
import type { ReporterNotifier } from "../admin/admin-report-types.js"
import { isPubliclyVisibleStatus } from "../report-visibility.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import type { FilingRepository } from "./filing-repository.js"
import { makeApplyFilingResult } from "./filing-results.js"
import { resolveFilingRoute, type ResolvedFilingRoute } from "./filing-route.js"
import { makeFilingQueue } from "./filing-sweep.js"
import { renderTicketText } from "./filing-ticket-text.js"
import type {
  FilingEvidenceInput,
  FilingMethod,
  FilingReason,
  FilingRecord,
  FilingStatus,
  RecordSuccessResult,
  SuccessGuard,
} from "./filing-types.js"

export interface FilingServiceDeps {
  filings: FilingRepository
  reports: Pick<AdminReportRepository, "getReport" | "getRouting">
  jobs: Pick<Jobs, "enqueue">
  /** FILING_AUTOMATIC_ENABLED (D10). */
  automaticFiling: boolean
  webBaseUrl: string
  reportChatEmitter?: ReportChatSystemEmitter
  notifications?: ReporterNotifier
  logger?: Pick<FastifyBaseLogger, "warn">
  now?: () => Date
}

export type CreateFilingOutcome =
  { kind: "created"; filing: FilingRecord } | { kind: "already_filed" } | { kind: "not_fileable" }

export type Fileability = "fileable" | "already_filed" | "not_fileable"

export interface ApplyFilingSuccessInput {
  filingId: string
  from: SuccessGuard
  outcome: "submitted" | "linked_existing"
  method: FilingMethod
  caseId?: string | null
  caseUrl?: string | null
  mailThreadId?: string | null
  actorId?: string | null
  audit?: WriteAuditInput
  scriptVersion?: string | null
  dryRun?: boolean
  evidence?: readonly FilingEvidenceInput[]
}

export type AdminReportFilingDTO = Omit<AdminFilingDTO, "evidence">

export interface AdminReportFilingView {
  filing: AdminReportFilingDTO | null
  filingRoute: AdminReportFilingRoute | null
}

export interface FilingService {
  create(input: {
    reportId: string
    actorId: string | null
    note?: string | null
    /** Written with the filing; a missing target becomes the new filing's. */
    audit?: WriteAuditInput
  }): Promise<CreateFilingOutcome>
  /** D1's two "already filed" conditions and D6's re-check, for a report that exists. */
  fileability(report: AdminReportRecord): Promise<Fileability>
  /** `routeReport`'s delivered packet, recorded as a submitted email filing with its route entry. */
  recordEmailRoute(input: {
    report: AdminReportRecord
    routing: AdminReportRoutingRecord | null
    mailThreadId: string
    actorId: string | null
  }): Promise<void>
  applyFilingSuccess(input: ApplyFilingSuccessInput): Promise<{ applied: boolean }>
  applyFilingResult(payload: unknown): Promise<{ applied: boolean }>
  enqueueFiling(filing: FilingRecord): Promise<boolean>
  runSweepPass(opts?: { ignoreAge?: boolean }): Promise<void>
  /** Cancels the report's queued or needs_human filing; a running one is left to finish. */
  cancelForReport(reportId: string): Promise<void>
  onVerdict(input: {
    reportId: string
    verdict: "approved" | "rejected"
    actorId: string | null
  }): Promise<void>
  adminReportView(
    report: AdminReportRecord,
    routing: AdminReportRoutingRecord | null,
  ): Promise<AdminReportFilingView>
}

const REPORT_NOT_FOUND = "Report not found"
const THE_CITY = "the city"
const ROUTE_KIND: ReportTimelineItem["kind"] = "route"

/** The fixed public note of a successful filing (D5): no text from a city or a script ever reaches it. */
function filingNote(
  outcome: "submitted" | "linked_existing",
  jurisdictionName: string | null,
  caseId: string | null,
): string {
  const j = jurisdictionName === null || jurisdictionName === "" ? THE_CITY : jurisdictionName
  if (caseId === null) return `Filed with ${j}`
  return outcome === "linked_existing"
    ? `Linked to ${j} request ${caseId}`
    : `Filed with ${j} · Request ${caseId}`
}

function isFileable(report: AdminReportRecord): boolean {
  return report.status !== "rejected" && report.verificationVerdict !== "rejected"
}

export function initialState(
  route: ResolvedFilingRoute,
  automaticFiling: boolean,
): { status: FilingStatus; reason: FilingReason | null } {
  if (route.reason !== undefined) return { status: "needs_human", reason: route.reason }
  if (route.channel === "portal" && !automaticFiling) {
    return { status: "needs_human", reason: "filing_off" }
  }
  return { status: "queued", reason: null }
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString()
}

export function toAdminFilingDTO(
  filing: FilingRecord,
  report: Pick<AdminReportRecord, "title" | "referenceCode">,
): AdminReportFilingDTO {
  return {
    id: filing.id,
    reportId: filing.reportId,
    reportTitle: report.title,
    referenceCode: report.referenceCode,
    geoid: filing.geoid,
    jurisdictionName: filing.jurisdictionName,
    category: filing.category as ReportCategory,
    channel: filing.channel,
    portalHost: filing.portalHost,
    status: filing.status,
    method: filing.method,
    reason: filing.reason,
    reasonDetail: filing.reasonDetail,
    caseId: filing.caseId,
    caseUrl: filing.caseUrl,
    cityClosedAt: iso(filing.cityClosedAt),
    attempts: filing.attempts,
    scriptVersion: filing.scriptVersion,
    dryRun: filing.dryRun,
    ticketText: filing.ticketText,
    createdAt: filing.createdAt.toISOString(),
    updatedAt: filing.updatedAt.toISOString(),
    submittedAt: iso(filing.submittedAt),
  }
}

function filingRouteTarget(route: ResolvedFilingRoute): string | null {
  if (route.channel === "portal") return route.portalHost
  if (route.channel === "email") return route.recipient ?? null
  return null
}

export function makeFilingService(deps: FilingServiceDeps): FilingService {
  const now = deps.now ?? (() => new Date())
  const queue = makeFilingQueue({
    filings: deps.filings,
    jobs: deps.jobs,
    automaticFiling: deps.automaticFiling,
    now,
  })

  function routeFor(
    report: AdminReportRecord,
    routing: AdminReportRoutingRecord | null,
  ): Promise<ResolvedFilingRoute> {
    return resolveFilingRoute(
      {
        geoid: routing?.geoid ?? null,
        category: report.category,
        contact: routing?.contact ?? null,
      },
      deps,
    )
  }

  function ticketText(report: AdminReportRecord, includeLink: boolean, note: string | null) {
    return renderTicketText({
      reportId: report.id,
      title: report.title,
      description: report.desc,
      referenceCode: report.referenceCode,
      isPublic: isPubliclyVisibleStatus(report.status) && report.visibility === "public",
      includeLink,
      note,
      webBaseUrl: deps.webBaseUrl,
    })
  }

  async function fileability(report: AdminReportRecord): Promise<Fileability> {
    if (!isFileable(report)) return "not_fileable"
    const [active, latest] = await Promise.all([
      deps.filings.getActiveForReport(report.id),
      deps.filings.getLatestSuccessfulForReport(report.id),
    ])
    if (active !== null) return "already_filed"
    if (latest !== null && latest.cityClosedAt === null && !latest.mailBounced) {
      return "already_filed"
    }
    return "fileable"
  }

  async function notifyReporter(
    reporterId: string | null,
    reportId: string,
    jurisdictionName: string | null,
  ): Promise<void> {
    if (reporterId === null || reporterId === "") return
    if (deps.notifications === undefined) {
      deps.logger?.warn(
        { reportId },
        "report filed with no notifier wired: the reporter was not told",
      )
      return
    }
    await deps.notifications.createNotification(reporterId, {
      type: "report_update",
      ...(jurisdictionName === null || jurisdictionName === ""
        ? { titleKey: "notification.report_filed.title_city" }
        : {
            titleKey: "notification.report_filed.title",
            vars: { jurisdiction: jurisdictionName },
          }),
      link: `/reports/${reportId}`,
    })
  }

  // The success is committed before these run; a failure here is logged, never thrown, since a retried
  // job or request would find the filing already successful and could not send them again.
  async function afterSuccess(result: RecordSuccessResult, note: string): Promise<void> {
    if (!result.reportChanged) return
    const reportId = result.filing.reportId
    try {
      const report = await deps.reports.getReport(reportId)
      if (deps.reportChatEmitter !== undefined) {
        await deps.reportChatEmitter.emit({
          reportId,
          status: report?.status ?? "acknowledged",
          kind: ROUTE_KIND,
          note,
        })
      }
      await notifyReporter(report?.reporter?.id ?? null, reportId, result.filing.jurisdictionName)
    } catch (err) {
      deps.logger?.warn(
        { err, reportId, filingId: result.filing.id },
        "filing success effects failed after commit (suppressed: the filing is recorded)",
      )
    }
  }

  async function applyFilingSuccess(input: ApplyFilingSuccessInput): Promise<{ applied: boolean }> {
    const filing = await deps.filings.getById(input.filingId)
    if (filing === null) return { applied: false }
    const caseId = input.caseId === undefined ? filing.caseId : input.caseId
    const note = filingNote(input.outcome, filing.jurisdictionName, caseId)
    const result = await deps.filings.recordSuccess({
      filingId: input.filingId,
      from: input.from,
      outcome: input.outcome,
      method: input.method,
      note,
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      ...(input.caseUrl !== undefined ? { caseUrl: input.caseUrl } : {}),
      ...(input.mailThreadId !== undefined ? { mailThreadId: input.mailThreadId } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.audit !== undefined ? { audit: input.audit } : {}),
      ...(input.scriptVersion !== undefined ? { scriptVersion: input.scriptVersion } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    })
    if (result === null) return { applied: false }
    await afterSuccess(result, note)
    return { applied: true }
  }

  async function cancelForReport(reportId: string): Promise<void> {
    const active = await deps.filings.getActiveForReport(reportId)
    if (active === null || active.status === "running") return
    await deps.filings.transition(active.id, {
      from: ["queued", "needs_human"],
      set: { status: "cancelled" },
    })
  }

  return {
    async create(input) {
      const [report, routing] = await Promise.all([
        deps.reports.getReport(input.reportId),
        deps.reports.getRouting(input.reportId),
      ])
      if (report === null) throw AppError.notFound(REPORT_NOT_FOUND)
      const state = await fileability(report)
      if (state !== "fileable") return { kind: state }

      const route = await routeFor(report, routing)
      const { status, reason } = initialState(route, deps.automaticFiling)
      const note = input.note?.trim() || null
      const created = await deps.filings.create(
        {
          reportId: report.id,
          geoid: routing?.geoid ?? null,
          category: report.category,
          routeCategory: route.routeCategory,
          channel: route.channel,
          portalHost: route.portalHost,
          formUrl: route.formUrl,
          status,
          reason,
          ticketText: ticketText(report, route.includeLink, note),
          note,
          createdBy: input.actorId,
        },
        input.audit,
      )
      if (created.kind === "active_exists") return { kind: "already_filed" }
      if (created.filing.status === "queued") await queue.enqueueFiling(created.filing)
      return created
    },

    fileability,

    async recordEmailRoute(input) {
      const jurisdictionName = input.routing?.place ?? null
      const note = filingNote("submitted", jurisdictionName, null)
      const result = await deps.filings.recordSuccess({
        newFiling: {
          reportId: input.report.id,
          geoid: input.routing?.geoid ?? null,
          category: input.report.category,
          routeCategory: null,
          channel: "email",
          ticketText: ticketText(input.report, true, null),
          createdBy: input.actorId,
        },
        outcome: "submitted",
        method: "email",
        mailThreadId: input.mailThreadId,
        note,
        actorId: input.actorId,
      })
      if (result !== null) await afterSuccess(result, note)
    },

    applyFilingSuccess,

    applyFilingResult: makeApplyFilingResult({
      filings: deps.filings,
      applyFilingSuccess,
      enqueueFiling: queue.enqueueFiling,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      now,
    }),

    enqueueFiling: queue.enqueueFiling,
    runSweepPass: queue.runSweepPass,
    cancelForReport,

    async onVerdict(input) {
      // Approve only records the verdict until approve-to-file lands with the email worker (D17).
      if (input.verdict === "rejected") await cancelForReport(input.reportId)
    },

    async adminReportView(report, routing) {
      const [latest, route] = await Promise.all([
        deps.filings.getLatestForReport(report.id),
        routeFor(report, routing),
      ])
      return {
        filing: latest === null ? null : toAdminFilingDTO(latest, report),
        filingRoute:
          route.channel === null
            ? null
            : { channel: route.channel, target: filingRouteTarget(route) },
      }
    },
  }
}
