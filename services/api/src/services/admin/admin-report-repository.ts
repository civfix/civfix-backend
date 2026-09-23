import type {
  AdminReportCounts,
  AdminReportStatus,
  ReportCategory,
  ReportOutreachStatus,
  ReportTimelineItem,
  ReportVisibility,
} from "@civfix/shared"
import type { AdminPersonRecord } from "./admin-person.js"

export type AdminReporterRecord = AdminPersonRecord

export interface AdminReportMediaRecord {
  id: string
  kind: "image" | "video"
  r2Key: string
  thumbKey: string | null
  contentType?: string | null
}

export interface AdminReportTimelineRecord {
  status: AdminReportStatus
  note: string | null
  kind?: ReportTimelineItem["kind"] | null
  who: string
  createdAt: Date
}

export interface AdminReportRoutingRecord {
  geoid: string | null
  dept: string
  place: string
  contact: string | null
  routed: boolean
  forwardSubjectTemplate?: string | null
  forwardBodyTemplate?: string | null
}

export interface ReportOutreachState {
  status: ReportOutreachStatus
  threadId: string | null
  routedTo: string | null
  routedAt: string | null
  packetSent: boolean
  sendFailed?: boolean
  sendInFlight?: boolean
}

export interface AdminReportRecord {
  id: string
  category: ReportCategory
  status: AdminReportStatus
  visibility: ReportVisibility
  flagged: boolean
  title: string
  place: string
  reporter: AdminReporterRecord | null
  confirmations: number
  address: string
  desc: string
  lat: number
  lng: number
  hasPhoto: boolean
  previewMedia: AdminReportMediaRecord | null
  createdAt: Date
  referenceCode: string | null
  verificationVerdict: "approved" | "rejected" | null
  verifiedAt: Date | null
  reporterReportVerified: boolean | null
}

export interface ListReportsArgs {
  q: string | null
  statuses: AdminReportStatus[] | null
  flaggedOnly: boolean
  needsVerificationOnly: boolean
  cursor: string | null
  limit: number
}

export interface AdminReportRepository {
  listReports(
    args: ListReportsArgs,
  ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }>
  countByBucket(args: { q: string | null }): Promise<AdminReportCounts>
  getReport(id: string): Promise<AdminReportRecord | null>
  listTimeline(id: string): Promise<AdminReportTimelineRecord[]>
  getRouting(id: string): Promise<AdminReportRoutingRecord | null>
  getOutreach(id: string): Promise<ReportOutreachState>
  advanceStatusIfIn(
    id: string,
    input: {
      from: readonly AdminReportStatus[]
      to: AdminReportStatus
      note: string
      actorId: string | null
      kind?: ReportTimelineItem["kind"]
    },
  ): Promise<boolean>
  appendSystemTimeline(
    id: string,
    input: { note: string; kind: ReportTimelineItem["kind"]; body?: string | null },
  ): Promise<void>
  listMedia(id: string): Promise<AdminReportMediaRecord[]>
  setStatus(
    id: string,
    input: {
      status: AdminReportStatus
      note: string
      actorId: string | null
      kind?: ReportTimelineItem["kind"]
      body?: string | null
    },
  ): Promise<boolean>
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  remove(id: string, input: { note: string; actorId: string | null }): Promise<boolean>
  appendFollowup(
    id: string,
    input: {
      note: string
      actorId: string | null
      to: "reporter" | "city"
      destination: string
    },
  ): Promise<void>
  setReportVerdict(
    id: string,
    input: { verdict: "approved" | "rejected"; actorId: string | null; note: string },
  ): Promise<boolean>
  withRouteLock<T>(id: string, fn: () => Promise<T>): Promise<T>
}
