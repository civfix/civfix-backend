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

export const REPORT_CREATE_SCOPE = "report_create"

/** The pg-boss queue + payload for the auto-forward job (D9 / #56). Mirrored in API_QUEUE_NAMES. */
export const REPORT_AUTOFORWARD_JOB = "report.autoforward"
export interface ReportAutoForwardJob {
  reportId: string
}

// H3 res 10 cells are ~130 m across — the SAME granularity the anon abuse cap keys on
// (abuse/h3-cap.ABUSE_H3_RES). Distinct from the zoom-derived MAP cluster grid (clusterCellSizeDeg).
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
  // D13: optional entry tag (e.g. 'reply') + the full untruncated body (an inbound city reply). Both null
  // on legacy / status-only rows.
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
  // The immutable human-readable reference code minted at create (issue #56, D1/D4). Nullable forever:
  // historical rows are backfilled out-of-band, and a code can be absent on a row created before #56.
  referenceCode: string | null
  createdAt: Date
  publishedAt: Date | null
  deletedAt: Date | null
}

// The minimal handle the pure clusterer needs. thumbKey/r2Key are the report's FIRST visible (`ready`)
// photo, presigned into a pin's thumbUrl by the service; both null when the report has no visible media.
export interface ReportMapPoint {
  id: string
  lat: number
  lng: number
  category: ReportCategory
  type: ReportType
  status: ReportStatus
  title: string | null
  description: string | null
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
  // The resolved jurisdiction's compact integer CODE (jurisdictions.code), resolved pre-tx alongside the
  // geoid. UNKNOWN_JURCODE (0) when the report has no resolved jurisdiction (D5). Drives the reference
  // code's JURCODE segment; the repo allocates the code from it as the FIRST write in the create tx (D4).
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
  // Build the response snapshot to persist, given the freshly-inserted rows. Runs INSIDE the create tx so
  // the stored snapshot is exactly the DTO the first caller receives. Returns a JSON-serializable ReportDTO.
  buildSnapshot: (
    record: ReportRecord,
    media: ReportMediaView[],
    timeline: ReportTimelineView[],
  ) => Promise<ReportDTO>
}

export type CreateReportTxResult =
  | { kind: "created"; snapshot: ReportDTO }
  | { kind: "replayed"; snapshot: ReportDTO }

// Persistence seam for the reports domain. Keeping ALL reports/media-attach/timeline/idempotency/follow
// access behind this interface is what makes the service testable with no DB.
export interface ReportRepository {
  findIdempotentSnapshot(key: string, scope: string): Promise<ReportDTO | null>
  // Runs the create transaction; catches a UNIQUE(idempotency_key) race and returns the stored snapshot
  // as a "replayed" result so the caller still sees the original report (no duplicate row, no orphan).
  createReportTx(args: CreateReportTxArgs): Promise<CreateReportTxResult>
  // Includes soft-deleted rows so the caller can 404 deleted ones.
  findReportById(id: string): Promise<ReportRecord | null>
  // Resolve a report by its immutable reference_code (issue #56 resolve-either getReport). Includes
  // soft-deleted rows so the caller can 404 them, same as findReportById. Null when no row carries the code.
  findReportByReferenceCode(code: string): Promise<ReportRecord | null>
  // Default returns only `ready` media. ownerView additionally includes the owner's own in-flight
  // `validating` uploads; `held`/`rejected` (moderation outcomes) stay hidden from everyone.
  findMediaForReport(reportId: string, ownerView?: boolean): Promise<ReportMediaView[]>
  // Count of in-flight (`validating`) media for ALL viewers — backs the DTO's `mediaPending` placeholder
  // without serving the unprocessed bytes/URL. `held`/`rejected` are NOT counted.
  countValidatingMediaForReport(reportId: string): Promise<number>
  // Batched form of findMediaForReport for a page of report ids. Empty input yields an empty map (no query).
  findMediaForReports(reportIds: string[], ownerView?: boolean): Promise<Map<string, ReportMediaView[]>>
  findTimelineForReport(reportId: string): Promise<ReportTimelineView[]>
  findTimelineForReports(reportIds: string[]): Promise<Map<string, ReportTimelineView[]>>
  isFollowing(userId: string, reportId: string): Promise<boolean>
  // Batched follow probe: which of these report ids does `userId` follow? Empty input yields an empty set.
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
  // Upsert/delete a follow; returns true if the report exists (so the route can 404 a missing report).
  addFollow(userId: string, reportId: string): Promise<boolean>
  removeFollow(userId: string, reportId: string): Promise<boolean>
  // OWNER status write — atomically verifies ownership + existence, sets status, appends a timeline row.
  // "not_found" = missing or soft-deleted; "forbidden" = not owned by `userId`.
  resolveByOwner(
    reportId: string,
    userId: string,
    input: { status: ReportStatus; note: string },
  ): Promise<"updated" | "not_found" | "forbidden">
  // OWNER visibility write — sets visibility, appends a timeline row; status deliberately unchanged.
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

// Declared structurally (like BBox) so the service does not import the zod-inferred
// ListReportsSearchRequest type — its `.default(30)` makes `limit` REQUIRED on the output type, which
// would force every caller to pass a limit. The route still validates the wire query against the shared
// schema first; the already-defaulted parsed request is assignable to this looser input.
export interface ReportSearchInput {
  q?: string | undefined
  categories?: ReportCategory[] | undefined
  types?: ReportType[] | undefined
  cursor?: string | undefined
  limit?: number | undefined
}

// Additive discussion/city meta for a report's DETAIL read. Maps 1:1 onto the optional ReportDTO fields
// (discussionCount / cityHandle / cityName / canForwardToCity); absent => those fields are omitted.
export interface ReportDiscussionMeta {
  discussionCount: number
  cityHandle: string | null
  cityName: string | null
  // Whether the jurisdiction has at least one usable contact email (so a @city forward could deliver).
  canForwardToCity: boolean
}

export interface ReportServiceDeps {
  repo: ReportRepository
  // Resolve a point to a jurisdiction geoid (nullable when outside coverage). Wraps jurisdiction-service.
  resolveJurisdictionGeoid: (lat: number, lng: number) => Promise<string | null>
  // Resolve a geoid to its compact jurisdictions.code (the reference-code JURCODE segment). Returns
  // UNKNOWN_JURCODE (0) for a null geoid or one with no code on file (D5). OPTIONAL: when omitted (offline
  // tests) the service treats every report as the "unknown" bucket (jurCode 0), so a code is still minted.
  resolveJurisdictionCode?: (geoid: string | null) => Promise<number>
  // Best-effort reverse geocoder for `addr` when the reporter supplied none. A missing seam or null result
  // leaves `addr` empty; it must never block creation.
  reverseGeocode?: (lat: number, lng: number) => Promise<string | null>
  presignMedia: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  // Wraps the cleanup repo's loadLinkedEventsForReports. When omitted, linkedEvents is always [].
  loadLinkedEventsForReports?: (reportIds: string[]) => Promise<Map<string, LinkedEventView[]>>
  // Wraps a discussion-repo read for the DETAIL meta. Best-effort: a thrown loader is swallowed by getReport.
  loadDiscussionMeta?: (reportId: string) => Promise<ReportDiscussionMeta>
  // Auto-forward (D9 / #56): the Jobs seam used to enqueue report.autoforward AFTER the create tx commits,
  // and the report_verified gate read. BOTH optional + wired together — when either is omitted (offline
  // tests / a path that doesn't auto-forward) createReport never enqueues. Anonymous/unverified reporters
  // are never enqueued (the gate returns false). A failed enqueue is logged best-effort, never fatal to the
  // create (the report is already committed + published; manual routing remains available).
  jobs?: Jobs
  // Resolve a reporter's earned report_verified flag (user_moderation.report_verified). Returns false when
  // no moderation row exists. Only a true result gates an auto-forward enqueue.
  isReportVerified?: (userId: string) => Promise<boolean>
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
  // Owner marks their own report resolved / reopens it (-> `published`). 404 missing, 403 not-owned.
  resolveReport(userId: string, reportId: string, resolved: boolean): Promise<ReportDTO>
  // Owner hides their own report (-> 'hidden') or re-lists it (-> 'public'). Never deletes; status untouched.
  unlistReport(userId: string, reportId: string, unlisted: boolean): Promise<ReportDTO>
}
