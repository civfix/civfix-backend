import type {
  FILING_CHANNEL_VALUES,
  FILING_EVIDENCE_KIND_VALUES,
  FILING_METHOD_VALUES,
  FILING_REASON_VALUES,
  FILING_STATUS_VALUES,
} from "../../db/schema/types.js"
import type { WriteAuditInput } from "../admin/audit.js"

export type FilingChannel = (typeof FILING_CHANNEL_VALUES)[number]
export type FilingStatus = (typeof FILING_STATUS_VALUES)[number]
export type FilingMethod = (typeof FILING_METHOD_VALUES)[number]
export type FilingEvidenceKind = (typeof FILING_EVIDENCE_KIND_VALUES)[number]
export type FilingReason = (typeof FILING_REASON_VALUES)[number]
export type FilingGroup = "needs_human" | "in_progress" | "filed" | "cancelled"

export const FILING_GROUP_STATUSES: Record<FilingGroup, readonly FilingStatus[]> = {
  needs_human: ["needs_human"],
  in_progress: ["queued", "running"],
  filed: ["submitted", "linked_existing"],
  cancelled: ["cancelled"],
}

/** The statuses the active-filing partial unique index covers: at most one per report. */
export const ACTIVE_FILING_STATUSES: readonly FilingStatus[] = ["queued", "running", "needs_human"]

export const SUCCESSFUL_FILING_STATUSES: readonly FilingStatus[] = ["submitted", "linked_existing"]

export const FILING_LIST_DEFAULT_LIMIT = 25
export const FILING_LIST_MAX_LIMIT = 50
export const FILING_DUE_MAX_LIMIT = 100
export const FILING_RUNNING_MAX = 100
export const FILING_EVIDENCE_MAX = 50
export const FILING_ROUTES_MAX = 16
export const FILING_REPORT_IDS_MAX = 100
export const FILING_CASE_TOKENS_MAX = 500
/** `reason_detail` is admin-only plain text (D6). */
export const FILING_REASON_DETAIL_MAX = 500
export const FILING_CASE_MATCH_MAX = 50
export const FILING_CASE_WINDOW_DAYS = 180

export interface FilingRecord {
  id: string
  reportId: string
  geoid: string | null
  jurisdictionName: string | null
  category: string
  routeCategory: string | null
  channel: FilingChannel | null
  portalHost: string | null
  formUrl: string | null
  status: FilingStatus
  method: FilingMethod | null
  reason: FilingReason | null
  reasonDetail: string | null
  caseId: string | null
  caseUrl: string | null
  cityClosedAt: Date | null
  attempts: number
  runId: string | null
  nextAttemptAt: Date | null
  aiWaitSince: Date | null
  scriptVersion: string | null
  dryRun: boolean
  ticketText: string
  note: string | null
  mailThreadId: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
  submittedAt: Date | null
}

export interface LatestSuccessfulFiling extends FilingRecord {
  /** A `submitted` filing whose mail thread bounced: the city never got it, so it does not count as filed (D1). */
  mailBounced: boolean
}

export interface FilingListRecord extends FilingRecord {
  reportTitle: string | null
  referenceCode: string | null
}

/** Columns a transition may write; `updated_at` is always stamped by the write itself. */
export type FilingMutableFields = Pick<
  FilingRecord,
  | "geoid"
  | "category"
  | "routeCategory"
  | "channel"
  | "portalHost"
  | "formUrl"
  | "status"
  | "method"
  | "reason"
  | "reasonDetail"
  | "caseId"
  | "caseUrl"
  | "cityClosedAt"
  | "attempts"
  | "runId"
  | "nextAttemptAt"
  | "aiWaitSince"
  | "scriptVersion"
  | "dryRun"
  | "ticketText"
  | "note"
  | "mailThreadId"
>

export interface CreateFilingInput {
  reportId: string
  geoid: string | null
  category: string
  routeCategory?: string | null
  channel?: FilingChannel | null
  portalHost?: string | null
  formUrl?: string | null
  status: FilingStatus
  method?: FilingMethod | null
  reason?: FilingReason | null
  reasonDetail?: string | null
  caseId?: string | null
  caseUrl?: string | null
  nextAttemptAt?: Date | null
  scriptVersion?: string | null
  dryRun?: boolean
  ticketText: string
  note?: string | null
  mailThreadId?: string | null
  createdBy?: string | null
}

export type CreateFilingResult =
  { kind: "created"; filing: FilingRecord } | { kind: "active_exists" }

export interface FilingEvidenceInput {
  r2Key: string
  kind: FilingEvidenceKind
  label?: string | null
}

export interface FilingEvidenceRecord {
  id: string
  filingId: string
  r2Key: string
  kind: FilingEvidenceKind
  label: string | null
  createdAt: Date
}

export interface TransitionInput {
  from: readonly FilingStatus[]
  attempts?: number
  /** The filer run the write belongs to; a result from an earlier run of the same attempt matches nothing. */
  runId?: string
  set: Partial<FilingMutableFields>
  audit?: WriteAuditInput
  evidence?: readonly FilingEvidenceInput[]
}

export interface SuccessGuard {
  status: readonly FilingStatus[]
  attempts?: number
  runId?: string
  reason?: FilingReason
}

/** The `routeReport` path inserts the filing already successful, so status and outcome fields come from the call. */
export type NewSuccessfulFiling = Omit<
  CreateFilingInput,
  "status" | "method" | "reason" | "reasonDetail" | "caseId" | "caseUrl" | "mailThreadId"
>

interface RecordSuccessCommon {
  outcome: "submitted" | "linked_existing"
  method: FilingMethod
  /** Omitted keeps the filing's case id; given (null included) replaces it. */
  caseId?: string | null
  caseUrl?: string | null
  mailThreadId?: string | null
  /** Omitted keeps the filing's value; a filer result sets both in the success's own transaction. */
  scriptVersion?: string | null
  dryRun?: boolean
  /** The fixed public timeline note (D5). */
  note: string
  actorId?: string | null
  audit?: WriteAuditInput
  evidence?: readonly FilingEvidenceInput[]
}

export type RecordSuccessInput = RecordSuccessCommon &
  ({ filingId: string; from: SuccessGuard } | { newFiling: NewSuccessfulFiling })

export interface RecordSuccessResult {
  filing: FilingRecord
  /** Whether the report was fileable, so the `route` timeline row was written. */
  reportChanged: boolean
}

export interface ListFilingsArgs {
  group: FilingGroup
  cursor?: string | null
  limit?: number
}

export interface ListFilingsResult {
  records: FilingListRecord[]
  nextCursor: string | null
}

export interface FilingGroupCounts {
  needs_human: number
  in_progress: number
}

export interface ListDueQueuedArgs {
  now: Date
  /** Null skips the age test (Resume runs a pass without it). */
  updatedBefore: Date | null
  channels: readonly FilingChannel[]
  limit: number
}

export interface ListStaleRunningArgs {
  /** Only filings whose last write is older than this. */
  updatedBefore: Date
  limit: number
}

export interface RunningFiling {
  id: string
  attempts: number
  runId: string | null
}

export interface FilingRouteInput {
  /** Null is the jurisdiction's default route. */
  category: string | null
  channel: FilingChannel
  formUrl?: string | null
  requestTypeHint?: string | null
  includeLink?: boolean
  statusSenderDomains?: readonly string[]
  enabled?: boolean
}

export interface FilingRouteRecord {
  geoid: string
  category: string | null
  channel: FilingChannel
  formUrl: string | null
  requestTypeHint: string | null
  includeLink: boolean
  statusSenderDomains: string[]
  enabled: boolean
  updatedAt: Date
  updatedBy: string | null
}

export interface FilingRouteHealth {
  routeCategory: string | null
  lastFiledAt: Date | null
  lastFailedAt: Date | null
  scriptVersion: string | null
}

export interface FilingSettingsRecord {
  paused: boolean
  updatedAt: Date
  updatedBy: string | null
}

export type InsertFilingMessageInput = { filingId: string; trusted: boolean } & (
  | { inboundEmailId: string; mailMessageId?: undefined }
  | { mailMessageId: string; inboundEmailId?: undefined }
)

export interface FilingMessageRecord {
  id: string
  filingId: string
  inboundEmailId: string | null
  mailMessageId: string | null
  trusted: boolean
  flagged: boolean
  classification: unknown
  summary: string | null
  appliedAt: Date | null
  createdAt: Date
}
