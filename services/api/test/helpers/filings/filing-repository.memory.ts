import type { WriteAuditInput } from "../../../src/services/admin/audit.js"
import type { FilingRepository } from "../../../src/services/filings/filing-repository.js"
import type {
  FilingEvidenceRecord,
  FilingMessageRecord,
  FilingRecord,
  FilingRouteRecord,
  FilingSettingsRecord,
} from "../../../src/services/filings/filing-types.js"

export type StoredFiling = Omit<FilingRecord, "jurisdictionName">

export interface MemoryReport {
  id: string
  geoid: string | null
  status: string
  title: string | null
  referenceCode: string | null
  deletedAt: Date | null
  verificationVerdict: string | null
}

export interface MemoryTimelineRow {
  reportId: string
  status: string
  note: string | null
  kind: string | null
  actorId: string | null
  createdAt: Date
}

const notImplemented = (): never => {
  throw new Error("not implemented")
}

export class InMemoryFilingRepository implements FilingRepository {
  readonly jurisdictions = new Map<string, string>()
  readonly reports = new Map<string, MemoryReport>()
  readonly timeline: MemoryTimelineRow[] = []
  readonly audits: WriteAuditInput[] = []
  readonly filings = new Map<string, StoredFiling>()
  readonly evidence: FilingEvidenceRecord[] = []
  routes: FilingRouteRecord[] = []
  readonly messages: FilingMessageRecord[] = []
  settings: FilingSettingsRecord = { paused: false, updatedAt: new Date(), updatedBy: null }

  create = notImplemented
  getById = notImplemented
  getActiveForReport = notImplemented
  getLatestSuccessfulForReport = notImplemented
  getLatestSuccessfulForReports = notImplemented
  transition = notImplemented
  recordSuccess = notImplemented
  claim = notImplemented
  list = notImplemented
  countGroups = notImplemented
  listDueQueued = notImplemented
  listRunningFilings = notImplemented
  getLatestByMailThread = notImplemented
  listEvidence = notImplemented
  listRoutes = notImplemented
  findRoutes = notImplemented
  replaceRoutes = notImplemented
  routeHealth = notImplemented
  getSettings = notImplemented
  setPaused = notImplemented
  insertMessageIfAbsent = notImplemented
  getMessageByInboundEmailId = notImplemented
  getMessageByMailMessageId = notImplemented
  flagMessage = notImplemented
  findByCaseIds = notImplemented
}
