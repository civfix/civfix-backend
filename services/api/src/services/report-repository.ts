import type {
  AddressPrecision,
  GeomSource,
  ReportAddressSource,
  ReportCategory,
  ReportDTO,
  ReportStatus,
  ReportType,
  ReportVisibility,
} from "@civfix/shared"
import type { ReportVisibilityTimelineKind } from "./report-types.js"

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
  addrSource: ReportAddressSource | null
  addrPrecision: AddressPrecision | null
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
  guestAnonSessionId?: string | undefined
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
  addrSource: ReportAddressSource | null
  addrPrecision: AddressPrecision | null
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
  findIdempotentSnapshot(
    key: string,
    scope: string,
    userOrAnon: string | null,
  ): Promise<ReportDTO | null>
  createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult>
  findReportById(id: string): Promise<ReportRecord | null>
  findReportByReferenceCode(code: string): Promise<ReportRecord | null>
  findMediaForReport(reportId: string, ownerView?: boolean): Promise<ReportMediaView[]>
  countValidatingMediaForReport(reportId: string): Promise<number>
  findMediaForReports(
    reportIds: string[],
    ownerView?: boolean,
  ): Promise<Map<string, ReportMediaView[]>>
  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]>
  findTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>>
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
  resolveByOwner(
    reportId: string,
    userId: string,
    input: { status: OwnerToggleStatus; note: string },
  ): Promise<"updated" | "unchanged" | "not_found" | "forbidden" | "invalid_state">
  setVisibilityByOwner(
    reportId: string,
    userId: string,
    input: { visibility: ReportVisibility; note: string; kind: ReportVisibilityTimelineKind },
  ): Promise<"updated" | "unchanged" | "not_found" | "forbidden">
}

export type OwnerToggleStatus = Extract<ReportStatus, "resolved" | "published">

export interface BBox {
  west: number
  south: number
  east: number
  north: number
}
