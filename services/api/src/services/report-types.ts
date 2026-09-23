import type {
  CreateReportRequest,
  ListMyReportsResponse,
  ListReportsSearchResponse,
  PaginationQuery,
  ReportCategory,
  ReportClusterResponse,
  ReportDTO,
  ReportType,
  ReportVisibility,
} from "@civfix/shared"
import type { Jobs } from "@civfix/shared/interfaces"
import type { LinkedEventView } from "./cleanup-service.js"
import type { ReportChatSystemEmitter } from "./report-timeline-event.js"
import type { AddressResolver } from "./address-resolver.js"
import type { BBox, ReportRepository } from "./report-repository.js"

export const REPORT_CREATE_SCOPE = "report_create"

export interface ReportAutoForwardJob {
  reportId: string
}

export const REPORT_VISIBILITY_TIMELINE_KIND = {
  hidden: "hidden",
  public: "unhidden",
} as const satisfies Record<ReportVisibility, string>

export type ReportVisibilityTimelineKind =
  (typeof REPORT_VISIBILITY_TIMELINE_KIND)[ReportVisibility]

export const REPORT_H3_RESOLUTION = 10

export const REPORTS_DEFAULT_LIMIT = 20
export const REPORTS_SEARCH_DEFAULT_LIMIT = 20

export interface ReportOwner {
  userId?: string | undefined
}

export interface SignedInReportOwner {
  userId: string
  guestAnonSessionId?: string | undefined
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

export interface ReportChatMeta {
  joined: boolean
  memberCount: number
  messageCount: number
  unread: number
}

export interface ReportServiceDeps {
  repo: ReportRepository
  resolveJurisdictionGeoid: (lat: number, lng: number) => Promise<string | null>
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  /**
   * Reverse-resolve the pin when the reporter typed no address. Structured now, so the snapshot can
   * record the ladder rung it came from and the display layer can be honest about a landmark line.
   * Still best-effort: omitted, throwing or empty, the report is filed either way.
   */
  resolveAddress?: AddressResolver
  presignMedia: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  presignPrivateMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  loadLinkedEventsForReports?: (reportIds: string[]) => Promise<Map<string, LinkedEventView[]>>
  loadDiscussionMeta?: (reportId: string) => Promise<ReportDiscussionMeta>
  loadReportChatMeta?: (reportId: string, viewerUserId: string | null) => Promise<ReportChatMeta>
  jobs?: Jobs
  autoForwardEnabled?: boolean
  isReportVerified?: (userId: string) => Promise<boolean>
  joinReportChatAsOwner?: (reportId: string, userId: string) => Promise<void>
  reportChatEmitter?: ReportChatSystemEmitter
  logger?: { warn: (obj: unknown, msg?: string) => void }
  newId?: () => string
  now?: () => Date
}

export interface ReportService {
  createReport(input: CreateReportRequest, owner: SignedInReportOwner): Promise<ReportDTO>
  getReport(id: string, viewer: ReportOwner): Promise<ReportDTO>
  listMyReports(userId: string, pagination: PaginationQuery): Promise<ListMyReportsResponse>
  listReportsInBBox(
    bbox: BBox,
    categories: ReportCategory[] | null,
    types: ReportType[] | null,
    zoom: number,
  ): Promise<ReportClusterResponse>
  searchReports(request: ReportSearchInput): Promise<ListReportsSearchResponse>
  resolveReport(userId: string, reportId: string, resolved: boolean): Promise<ReportDTO>
  unlistReport(userId: string, reportId: string, unlisted: boolean): Promise<ReportDTO>
}
