import type { AdminFilingDTO, AdminReportFilingRoute } from "@civfix/contract"
import type { Jobs } from "@civfix/seams"
import type { FastifyBaseLogger } from "fastify"
import type { WriteAuditInput } from "../admin/audit.js"
import type {
  AdminReportRecord,
  AdminReportRepository,
  AdminReportRoutingRecord,
} from "../admin/admin-report-repository.js"
import type { ReporterNotifier } from "../admin/admin-report-types.js"
import type { ReportChatSystemEmitter } from "../report-timeline-event.js"
import type { FilingRepository } from "./filing-repository.js"
import type {
  FilingEvidenceInput,
  FilingMethod,
  FilingRecord,
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
  | { kind: "created"; filing: FilingRecord }
  | { kind: "already_filed" }
  | { kind: "not_fileable" }

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
  cancelForReport(reportId: string, actorId: string | null): Promise<void>
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

export function makeFilingService(_deps: FilingServiceDeps): FilingService {
  throw new Error("not implemented")
}
