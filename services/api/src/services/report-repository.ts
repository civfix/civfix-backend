import type {
  AddressPrecision,
  GeomSource,
  ReportAddressSource,
  ReportCategory,
  ReportDTO,
  ReportStatus,
  ReportType,
  ReportVisibility,
} from "@civfix/contract"
import type { REPORT_VOTE_KIND_VALUES } from "../db/schema/types.js"
import type { ReportVisibilityTimelineKind } from "./report-types.js"
import type { ConfirmationVerdict } from "./report-visibility.js"

/** A resident's vote on a report: "I see this too" (a confirmation) or "This is fixed". */
export type ReportVote = (typeof REPORT_VOTE_KIND_VALUES)[number]

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
  confirmCount: number
  fixedCount: number
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
  confirmCount: number
  fixedCount: number
}

/** The report's counts after the call, and the caller's vote (null for none). */
export type ReportConfirmationOutcome =
  | { kind: "applied"; confirmCount: number; fixedCount: number; vote: ReportVote | null }
  | { kind: Exclude<ConfirmationVerdict, "allowed"> }

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
  { kind: "created"; snapshot: ReportDTO } | { kind: "replayed"; snapshot: ReportDTO }

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
  countMediaStatesForReport(reportId: string): Promise<{ validating: number; rejected: number }>
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
  /**
   * Open public reports in the bbox with at least one confirmation, ranked by their last five votes
   * (DECISIONS §61): the first PRESSING_CANDIDATES by confirmations then newest, less those whose last five
   * hold 3 or more fixed votes, by score, then confirmations, then newest.
   */
  findPressing(bbox: BBox, limit: number): Promise<ReportMapPoint[]>
  /**
   * Makes the user's vote `vote` ("add", adding it or moving it from the other kind) or removes it when it
   * is `vote` ("remove"), judged by confirmationVerdict and applied atomically with both counts. A call that
   * changes nothing reports the current counts and vote.
   */
  setConfirmation(
    reportId: string,
    userId: string,
    vote: ReportVote,
    change: VoteChange,
  ): Promise<ReportConfirmationOutcome>
  findVote(reportId: string, userId: string): Promise<ReportVote | null>
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

export type VoteChange = "add" | "remove"

// The pressing ranking (DECISIONS §61): the first PRESSING_CANDIDATES reports by confirmations are ranked
// over their last PRESSING_RECENT_VOTES votes, and one with PRESSING_DROP_FIXED or more fixed votes among
// those is not listed.
export const PRESSING_CANDIDATES = 200
export const PRESSING_RECENT_VOTES = 5
export const PRESSING_DROP_FIXED = 3

export interface BBox {
  west: number
  south: number
  east: number
  north: number
}
