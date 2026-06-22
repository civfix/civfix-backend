import type {
  AdminReportCounts,
  AdminReportDTO,
  AdminReportListQuery,
  AdminReportListResponse,
  AdminReportListItemDTO,
  AdminReportStatus,
  ReportCategory,
  ReportOutreachStatus,
  ReportTimelineItem,
} from "@civfix/shared"
import type { OutboundMailService } from "./outbound-mail-service.js"
import type { LinkedEventView } from "../cleanup-service.js"

/** The reporter (author) of a report, as the repo resolves it (or null for an anonymous report). */
export interface AdminReporterRecord {
  id: string
  name: string
  handle: string | null
  emailVerified: boolean
  hasOauth: boolean
  joinedAt: Date | null
}

/**
 * A media asset attached to a report, as the repo reads it back: the raw object-store keys. The service
 * presigns these into client-usable URLs — handing the browser a raw r2 key is the bug behind "the photo
 * doesn't appear in the admin panel". `contentType` is the asset's REAL stored MIME (so a routed-packet
 * attachment isn't mislabeled image/jpeg when the pipeline emitted WebP); optional so the repo can omit it.
 */
export interface AdminReportMediaRecord {
  id: string
  kind: "image" | "video"
  r2Key: string
  thumbKey: string | null
  contentType?: string | null
}

/** A report_timeline row as the repo reads it back (status transition + optional note + actor label). */
export interface AdminReportTimelineRecord {
  status: AdminReportStatus
  note: string | null
  who: string
  createdAt: Date
}

/** The routing posture for a report's jurisdiction (department + the resolved contact email). */
export interface AdminReportRoutingRecord {
  /** The jurisdiction GEOID (threads the city follow-up into one rolling conversation), or null. */
  geoid: string | null
  dept: string
  place: string
  /** The resolved per-category -> default -> legacy contact email, or null when none on file. */
  contact: string | null
  routed: boolean
}

/**
 * A report row joined with everything the LIST needs: the reporter, the open-flag marker, the
 * confirmations count, the address label, coords, and whether media is attached. The DETAIL adds desc +
 * timeline + routing + media (loaded separately).
 */
export interface AdminReportRecord {
  id: string
  category: ReportCategory
  status: AdminReportStatus
  /** True when the report has an OPEN abuse_flag (the orthogonal "flagged" marker, never a status). */
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
  createdAt: Date
}

/** Normalized list arguments the repo consumes. */
export interface ListReportsArgs {
  q: string | null
  /**
   * The set of civfix statuses to match for the selected design bucket (null = any). A design bucket maps
   * to MULTIPLE civfix statuses (see STATUS_BUCKETS): "Submitted" = submitted|held|published (a freshly
   * published pin is live + awaiting city action, NOT done), "In progress" = acknowledged|in_progress,
   * "Completed" = resolved. The repo matches with `= ANY(statuses)`, not a single equality.
   */
  statuses: AdminReportStatus[] | null
  flaggedOnly: boolean
  cursor: string | null
  limit: number
}

/** Input to a follow-up to the reporter (records a notification row for the report's author). */
export interface NotifyReporterInput {
  reportId: string
  reporterUserId: string
  title: string
  body: string
  link: string | null
}

/**
 * Persistence seam for the admin reports domain. The Drizzle impl runs raw SQL (PostGIS for coords); the
 * offline tests pass an in-memory impl. Keeping every read/write here is what makes the service
 * unit-testable with no DB.
 */
export interface AdminReportRepository {
  listReports(
    args: ListReportsArgs,
  ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }>
  /**
   * Per-bucket totals for the filter chips, over the SEARCHED (q) non-removed set — so the chip numbers
   * are accurate and stable across the status facet instead of being capped to the first keyset page.
   */
  countByBucket(args: { q: string | null }): Promise<AdminReportCounts>
  getReport(id: string): Promise<AdminReportRecord | null>
  listTimeline(id: string): Promise<AdminReportTimelineRecord[]>
  getRouting(id: string): Promise<AdminReportRoutingRecord | null>
  /**
   * Resolve the report's outreach lifecycle (was it emailed to its jurisdiction, did it deliver / get a
   * reply / bounce) + a deep-link to the per-report mail thread. Joins the newest per-report mail_threads
   * row with its latest OUT message + the thread status. Mapping (see §2.5):
   *   no thread                                    -> not_sent
   *   thread.status 'bounced'                      -> bounced
   *   thread has any IN message OR status 'replied'-> replied
   *   thread.status 'delivered' / 'opened'         -> delivered
   *   otherwise (a thread with an OUT send)        -> sent
   */
  getOutreach(id: string): Promise<{
    status: ReportOutreachStatus
    threadId: string | null
    routedTo: string | null
    routedAt: string | null
  }>
  /**
   * Append a SYSTEM report_timeline row at the report's CURRENT status (actor NULL, no audit). Used by the
   * inbound reply side-effects (§2.7) to record a jurisdiction reply on the timeline without changing the
   * report status. Unlike setStatus this is a non-transition row; unlike appendFollowup it writes no audit.
   */
  appendSystemTimeline(id: string, input: { note: string; kind: ReportTimelineItem["kind"] }): Promise<void>
  listMedia(id: string): Promise<AdminReportMediaRecord[]>
  setStatus(
    id: string,
    input: { status: AdminReportStatus; note: string; actorId: string | null },
  ): Promise<boolean>
  /** Toggle the report's abuse flag; returns the resulting flagged state, or null when the report is gone. */
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  remove(id: string, input: { note: string; actorId: string | null }): Promise<boolean>
  notifyReporter(input: NotifyReporterInput): Promise<void>
  /**
   * Append a follow-up report_timeline row (after a notification or a city mail has been sent) AND audit
   * the follow-up (report.followup_sent). `to`/`destination` carry the channel for the audit meta.
   */
  appendFollowup(
    id: string,
    input: {
      note: string
      actorId: string | null
      to: "reporter" | "city"
      destination: string
    },
  ): Promise<void>
}

export interface AdminReportServiceDeps {
  repo: AdminReportRepository
  /** The outbound-mail service used for the follow-up to the routed city contact. */
  outboundMail: OutboundMailService
  /**
   * Presign (or otherwise render) a media object's URL pair, wrapping the Storage seam. The repo returns
   * raw object-store KEYS; without presigning those keys resolve against admin.civfix.org and 404. When
   * omitted (offline unit tests) it defaults to an identity pass-through, so a test still sees the raw key.
   */
  presignMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  /**
   * Load the events (cleanups) a report is linked to. OPTIONAL: when omitted, linkedEvents is always []
   * (the additive DTO default), so an un-wired/offline path simply renders no section.
   */
  loadLinkedEventsForReports?: (
    reportIds: string[],
  ) => Promise<Map<string, LinkedEventView[]>>
  /**
   * Load a media object's raw bytes for the Approve & send packet's photo attachments. OPTIONAL: when
   * omitted (offline unit tests) it defaults to returning null, so the routed email carries no binary
   * attachments — only the presigned-link fallbacks.
   */
  loadMediaBytes?: (r2Key: string) => Promise<Uint8Array | null>
  /** Injectable clock (defaults to () => new Date()) so the relative-age labels are deterministic. */
  now?: () => Date
}

/** The outcome of a follow-up send, so the route can audit + ack with the right target/channel. */
export interface FollowupResult {
  to: "reporter" | "city"
  /** The destination address (city) or the reporter's user id (reporter). */
  destination: string
}

/** The outcome of an Approve & send: the per-report thread it landed in + the address it was sent to. */
export interface RouteToJurisdictionResult {
  threadId: string
  routedTo: string
}

export interface AdminReportService {
  list(query: AdminReportListQuery): Promise<AdminReportListResponse>
  get(id: string): Promise<AdminReportDTO>
  setStatus(id: string, input: { status: AdminReportStatus; actorId: string | null }): Promise<void>
  flag(id: string, input: { reason: string | null; actorId: string | null }): Promise<boolean>
  remove(id: string, input: { reason: string | null; actorId: string | null }): Promise<void>
  sendFollowup(
    id: string,
    input: { to: "reporter" | "city"; body: string; actorId: string | null },
  ): Promise<FollowupResult>
  /**
   * Approve & send THIS report to its jurisdiction: resolve the contact (override or the routing contact,
   * else 422 NOT_ROUTABLE), build the full packet (photos attached + signed-link fallbacks), send it on a
   * per-report mail thread, and advance the report toward `acknowledged`. Returns the thread + address.
   */
  routeToJurisdiction(
    id: string,
    input: { contactEmailOverride: string | null; note: string | null; actorId: string | null },
  ): Promise<RouteToJurisdictionResult>
}

export type { AdminReportListItemDTO }
