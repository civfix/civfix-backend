import type {
  CreateReportRequest,
  GeomSource,
  ListMyReportsResponse,
  ListReportsSearchResponse,
  PaginationQuery,
  ReportCategory,
  ReportClusterResponse,
  ReportDTO,
  ReportStatus,
  ReportType,
  ReportVisibility,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import type { LinkedEventView } from "./cleanup-service.js"
import type { ReportChatSystemEmitter } from "./report-timeline-event.js"

export const REPORT_CREATE_SCOPE = "report_create"

export const REPORT_AUTOFORWARD_JOB = "report.autoforward"
export interface ReportAutoForwardJob {
  reportId: string
}

export const REPORT_H3_RESOLUTION = 10

export const REPORTS_DEFAULT_LIMIT = 20
export const REPORTS_SEARCH_DEFAULT_LIMIT = 20

export interface ReportOwner {
  userId?: string | undefined
  anonSessionId?: string | undefined
}

export interface ReportMediaView {
  id: string
  kind: "image" | "video"
  codec: string | null
  r2Key: string
  thumbKey: string | null
  status: "validating" | "ready" | "rejected" | "held"
  width: number | null
  height: number | null
}

export interface ReportTimelineView {
  status: ReportStatus
  note: string | null
  kind: string | null
  body: string | null
  createdAt: Date
}

export interface ReportRecord {
  id: string
  reporterUserId: string | null
  anonSessionId: string | null
  category: ReportCategory
  type: ReportType
  title: string | null
  description: string | null
  addr: string | null
  status: ReportStatus
  visibility: ReportVisibility
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  referenceCode: string | null
  createdAt: Date
  publishedAt: Date | null
  deletedAt: Date | null
}

export interface ReportMapPoint {
  id: string
  lat: number
  lng: number
  category: ReportCategory
  type: ReportType
  status: ReportStatus
  title: string | null
  description: string | null
  addr: string | null
  referenceCode: string | null
  thumbKey: string | null
  r2Key: string | null
}

export interface CreateReportTxArgs {
  reportId: string
  reporterUserId: string
  idempotencyKey: string
  lat: number
  lng: number
  geomSource: GeomSource
  jurisdictionGeoid: string | null
  jurCode: number
  category: ReportCategory
  type: ReportType
  title: string | null
  description: string | null
  addr: string | null
  status: ReportStatus
  visibility: ReportVisibility
  h3Cell: string
  publishedAt: Date | null
  mediaUploadIds: string[]
  timelineNote: string | null
  idempotency: { key: string; scope: string; userOrAnon: string | null }
  buildSnapshot: (
    record: ReportRecord,
    media: ReportMediaView[],
    timeline: ReportTimelineView[],
  ) => Promise<ReportDTO>
}

export type CreateReportTxResult =
  | { kind: "created"; snapshot: ReportDTO }
  | { kind: "replayed"; snapshot: ReportDTO }

export interface ReportRepository {
  findIdempotentSnapshot(key: string, scope: string): Promise<ReportDTO | null>
  createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult>
  findReportById(id: string): Promise<ReportRecord | null>
  findReportByReferenceCode(code: string): Promise<ReportRecord | null>
  findMediaForReport(reportId: string, ownerView?: boolean): Promise<ReportMediaView[]>
  countValidatingMediaForReport(reportId: string): Promise<number>
  findMediaForReports(reportIds: string[], ownerView?: boolean): Promise<Map<string, ReportMediaView[]>>
  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]>
  findTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>>
  isFollowing(userId: string, reportId: string): Promise<boolean>
  findFollowedReportIds(userId: string, reportIds: string[]): Promise<Set<string>>
  listMyReports(
    userId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: ReportRecord[]; nextCursor: string | null }>
  findMapCandidates(
    bbox: BBox,
    categories: ReportCategory[] | null,
    types: ReportType[] | null,
    cap: number,
  ): Promise<ReportMapPoint[]>
  searchReports(args: {
    q: string | null
    categories: ReportCategory[] | null
    types: ReportType[] | null
    cursor: string | null
    limit: number
  }): Promise<{ points: ReportMapPoint[]; nextCursor: string | null }>
  addFollow(userId: string, reportId: string): Promise<boolean>
  removeFollow(userId: string, reportId: string): Promise<boolean>
  resolveByOwner(
    reportId: string,
    userId: string,
    input: { status: ReportStatus; note: string },
  ): Promise<"updated" | "not_found" | "forbidden">
  setVisibilityByOwner(
    reportId: string,
    userId: string,
    input: { visibility: ReportVisibility; note: string },
  ): Promise<"updated" | "not_found" | "forbidden">
}

export interface BBox {
  west: number
  south: number
  east: number
  north: number
}

export interface ReportSearchInput {
  q?: string | undefined
  categories?: ReportCategory[] | undefined
  types?: ReportType[] | undefined
  cursor?: string | undefined
  limit?: number | undefined
}

export interface ReportDiscussionMeta {
  discussionCount: number
  cityHandle: string | null
  cityName: string | null
  canForwardToCity: boolean
}

export interface ReportServiceDeps {
  repo: ReportRepository
  resolveJurisdictionGeoid: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  reverseGeocode?: (lat: number, lng: number) => Promise<string | null>
  presignMedia: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  loadLinkedEventsForReports?: (reportIds: string[]) => Promise<Map<string, LinkedEventView[]>>
  loadDiscussionMeta?: (reportId: string) => Promise<ReportDiscussionMeta>
  jobs?: Jobs
  isReportVerified?: (userId: string) => Promise<boolean>
  awardReportHours?: (userId: string, reportId: string, geoid: string | null) => Promise<void>
  // Auto-join the report's creator as an "owner" member of its chat, once the report row is committed.
  // Best-effort (see maybeJoinReportChatAsOwner): a failure here must NOT fail report creation.
  joinReportChatAsOwner?: (reportId: string, userId: string) => Promise<void>
  /**
   * D-D1: the report-chat SYSTEM-message emitter (the timeline choke point). After the owner resolve/
   * reopen or hide/re-list writes its timeline row, the service fires `emit(...)` to mirror the event into
   * the report's group chat + push the members. OPTIONAL + fully best-effort (the emitter swallows its own
   * errors), so the status/visibility change is independent of the chat reflection.
   */
  reportChatEmitter?: ReportChatSystemEmitter
  logger?: { warn: (obj: unknown, msg?: string) => void }
  newId?: () => string
  now?: () => Date
}

export interface ReportService {
  createReport(input: CreateReportRequest, owner: { userId: string }): Promise<ReportDTO>
  getReport(id: string, viewer: ReportOwner): Promise<ReportDTO>
  listMyReports(userId: string, pagination: PaginationQuery): Promise<ListMyReportsResponse>
  listReportsInBBox(
    bbox: BBox,
    categories: ReportCategory[] | null,
    types: ReportType[] | null,
    zoom: number,
  ): Promise<ReportClusterResponse>
  searchReports(request: ReportSearchInput): Promise<ListReportsSearchResponse>
  followReport(userId: string, reportId: string): Promise<{ following: boolean }>
  unfollowReport(userId: string, reportId: string): Promise<{ following: boolean }>
  resolveReport(userId: string, reportId: string, resolved: boolean): Promise<ReportDTO>
  unlistReport(userId: string, reportId: string, unlisted: boolean): Promise<ReportDTO>
}
