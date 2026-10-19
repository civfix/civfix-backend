import type { WriteAuditInput } from "../admin/audit.js"
import type {
  CreateFilingInput,
  CreateFilingResult,
  FilingEvidenceRecord,
  FilingGroupCounts,
  FilingMessageRecord,
  FilingRecord,
  FilingRouteHealth,
  FilingRouteInput,
  FilingRouteRecord,
  FilingSettingsRecord,
  InsertFilingMessageInput,
  ListDueQueuedArgs,
  ListFilingsArgs,
  ListFilingsResult,
  RecordSuccessInput,
  RecordSuccessResult,
  RunningFiling,
  TransitionInput,
} from "./filing-types.js"

/**
 * Where a report was filed with its city, and everything the filer and the admin read about it (D4–D6,
 * D11). Every write that can race a redelivered job or another operator is a guarded write that
 * returns null when its guard no longer holds, so the caller applies effects only on a row.
 */
export interface FilingRepository {
  create(input: CreateFilingInput, audit?: WriteAuditInput): Promise<CreateFilingResult>
  getById(id: string): Promise<FilingRecord | null>
  getActiveForReport(reportId: string): Promise<FilingRecord | null>
  getLatestSuccessfulForReport(reportId: string): Promise<FilingRecord | null>
  /** One row per report that has a successful filing; at most 100 ids. */
  getLatestSuccessfulForReports(reportIds: readonly string[]): Promise<FilingRecord[]>
  transition(id: string, input: TransitionInput): Promise<FilingRecord | null>
  recordSuccess(input: RecordSuccessInput): Promise<RecordSuccessResult | null>
  claim(id: string, attempt: number): Promise<{ runId: string } | null>
  list(args: ListFilingsArgs): Promise<ListFilingsResult>
  countGroups(): Promise<FilingGroupCounts>
  listDueQueued(args: ListDueQueuedArgs): Promise<FilingRecord[]>
  listRunningFilings(): Promise<RunningFiling[]>
  getLatestByMailThread(threadId: string): Promise<FilingRecord | null>
  listEvidence(filingId: string): Promise<FilingEvidenceRecord[]>

  listRoutes(geoid: string): Promise<FilingRouteRecord[]>
  /** The (geoid, category) route and the (geoid, NULL) default, the specific one first. */
  findRoutes(geoid: string, category: string): Promise<FilingRouteRecord[]>
  replaceRoutes(
    geoid: string,
    routes: readonly FilingRouteInput[],
    audit?: WriteAuditInput,
  ): Promise<FilingRouteRecord[]>
  routeHealth(geoid: string): Promise<FilingRouteHealth[]>

  getSettings(): Promise<FilingSettingsRecord>
  setPaused(paused: boolean, audit?: WriteAuditInput): Promise<FilingSettingsRecord>

  /** Null when that message is already linked to a filing. */
  insertMessageIfAbsent(input: InsertFilingMessageInput): Promise<FilingMessageRecord | null>
  getMessageByInboundEmailId(inboundEmailId: string): Promise<FilingMessageRecord | null>
  getMessageByMailMessageId(mailMessageId: string): Promise<FilingMessageRecord | null>
  flagMessage(id: string): Promise<void>
  /** Successful filings submitted within the last 180 days whose case id is one of `tokens` (≤ 500). */
  findByCaseIds(tokens: readonly string[]): Promise<FilingRecord[]>
}
