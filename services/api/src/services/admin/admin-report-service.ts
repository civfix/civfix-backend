/**
 * Admin reports service (Phase 2): every neighbor report routed to a city department.
 *
 * Backs the reports list (filter by civfix status + flagged + search title/place/id/reporter,
 * paginated), the detail (desc, timeline, reporter, routing, media), and the operator actions: set
 * status (writes report_timeline), flag/unflag (toggles an abuse_flag + timeline), remove (-> rejected
 * soft-delete + timeline), and send a follow-up to the reporter (-> in-app notification + timeline) or
 * the routed city contact (-> outbound mail via OutboundMailService + timeline). See enumeration 2.C +
 * endpoints #16-#21 and reconciliation 4.2 / 4.4 / 4.5.
 *
 * REPOSITORY SEAM: every read/write goes through AdminReportRepository (Drizzle impl in
 * admin-report-repository.drizzle.ts; an in-memory impl in admin-report-repository.memory.ts for the
 * offline unit tests), mirroring the Phase 1 report-service/report-repository split so the service is
 * testable with no database and no Docker.
 *
 * STATUS RECONCILIATION (decisions 8 / enumeration 4.2): the design's submitted|in-progress|completed
 * buckets map to the civfix report-status enum submitted|in_progress|resolved; "flagged" is the
 * orthogonal abuse marker (an open abuse_flag), never a status; "Remove report" -> rejected. The list
 * `filter` facet (all|submitted|in_progress|completed|flagged) maps `completed` -> resolved before the
 * repo query; `flagged` selects reports with an open abuse_flag regardless of status.
 *
 * AUDIT: every mutation is audited by the ROUTE (which holds the operator userId + request tag), per the
 * foundation audit-helper contract; this service performs the effect (timeline + state) and the mail/
 * notification side-effects, returning enough for the route to audit + ack.
 */

import { AppError } from "@civfix/shared"
import type {
  AdminReportCounts,
  AdminReportDTO,
  AdminReportListItemDTO,
  AdminReportListQuery,
  AdminReportListResponse,
  AdminReportStatus,
  LinkedEventRef,
  ReportCategory,
  ReportMedia,
  ReportOutreach,
  ReportOutreachStatus,
  ReportRouting,
  ReportTimelineItem,
} from "@civfix/shared"
import type { OutboundAttachment } from "@civfix/shared/interfaces"
import type { OutboundMailService } from "./outbound-mail-service.js"
import { toLinkedEventRef, type LinkedEventView } from "../cleanup-service.js"
import { toRelAbs } from "./admin-format.js"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** The reporter (author) of a report, as the repo resolves it (or null for an anonymous report). */
export interface AdminReporterRecord {
  id: string
  name: string
  handle: string | null
  /** Whether the account's email is proven (retained on the record; the trust label was removed). */
  emailVerified: boolean
  /** Whether any oauth identity links the account (retained on the record; the trust label was removed). */
  hasOauth: boolean
  joinedAt: Date | null
}

/**
 * A media asset attached to a report, as the repo reads it back: the raw object-store keys. The service
 * presigns these into client-usable URLs (see `get` below) — handing the browser a raw r2 key is the bug
 * behind "the photo doesn't appear in the admin panel".
 */
export interface AdminReportMediaRecord {
  id: string
  kind: "image" | "video"
  r2Key: string
  thumbKey: string | null
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
  /** A human department label (jurisdiction name; department is not modeled in Phase 2). */
  dept: string
  place: string
  /** The resolved per-category -> default -> legacy contact email, or null when none on file. */
  contact: string | null
  routed: boolean
}

/**
 * A report row joined with everything the LIST needs: the reporter, the open-flag marker, the
 * confirmations count (report_follows), the address label, coords, and whether media is attached. The
 * DETAIL adds desc + timeline + routing + media (loaded separately).
 */
export interface AdminReportRecord {
  id: string
  category: ReportCategory
  status: AdminReportStatus
  /** True when the report has an OPEN abuse_flag (the orthogonal "flagged" marker). */
  flagged: boolean
  title: string
  place: string
  reporter: AdminReporterRecord | null
  /** Count of report_follows for the report (the design's "confirmations"). */
  confirmations: number
  /** Free-text address label rendered in the detail location row. */
  address: string
  desc: string
  lat: number
  lng: number
  hasPhoto: boolean
  createdAt: Date
}

/** Normalized list arguments the repo consumes. `statuses` is the set of civfix statuses to match (null = any). */
export interface ListReportsArgs {
  q: string | null
  /**
   * The set of civfix statuses to match for the selected design bucket (null = any). A design bucket maps
   * to MULTIPLE civfix statuses (see STATUS_BUCKETS): "Submitted" = submitted|held|published (a freshly
   * published pin is live + awaiting city action, NOT done), "In progress" = acknowledged|in_progress,
   * "Completed" = resolved. The repo matches with `= ANY(statuses)`, not a single equality.
   */
  statuses: AdminReportStatus[] | null
  /** When true, restrict to reports with an OPEN abuse_flag (the "Flagged" facet). */
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
  /** Page the reports list applying the search / status / flagged facet, newest-first keyset paged. */
  listReports(
    args: ListReportsArgs,
  ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }>
  /**
   * Per-bucket totals for the filter chips, over the SEARCHED (q) non-removed set — so the chip numbers
   * are accurate and stable across the status facet instead of being capped to the first keyset page.
   */
  countByBucket(args: { q: string | null }): Promise<AdminReportCounts>
  /** Load one report's base record by id, or null when it does not exist (or is deleted). */
  getReport(id: string): Promise<AdminReportRecord | null>
  /** Load the ordered timeline for a report (oldest first). */
  listTimeline(id: string): Promise<AdminReportTimelineRecord[]>
  /** Load the routing posture (department + resolved contact) for a report's jurisdiction. */
  getRouting(id: string): Promise<AdminReportRoutingRecord | null>
  /**
   * Resolve the report's outreach lifecycle (was it emailed to its jurisdiction, did it deliver / get a
   * reply / bounce) + a deep-link to the per-report mail thread. Joins the newest per-report mail_threads
   * row (report_id = id) with its latest OUT message + the thread status. Mapping (see §2.5):
   *   no thread                                    -> not_sent
   *   thread.status 'bounced'                      -> bounced
   *   thread has any IN message OR status 'replied'-> replied
   *   thread.status 'delivered' / 'opened'         -> delivered
   *   otherwise (a thread with an OUT send)        -> sent
   * `routedTo` = the latest OUT to_addr; `routedAt` = the earliest OUT created_at (ISO), both null when
   * the thread carries no outbound message yet.
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
  /** Load the media assets attached to a report (ordered). */
  listMedia(id: string): Promise<AdminReportMediaRecord[]>
  /**
   * Set the report status AND append a report_timeline row noting the operator transition. Returns false
   * when the report does not exist (so the route can 404).
   */
  setStatus(
    id: string,
    input: { status: AdminReportStatus; note: string; actorId: string | null },
  ): Promise<boolean>
  /**
   * Toggle the report's abuse flag: open one when none is open, else resolve the open one(s). Appends a
   * report_timeline row recording the (un)flag. Returns the resulting flagged state, or null when the
   * report does not exist.
   */
  toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null>
  /**
   * Remove a report: set status 'rejected' (soft) + append a report_timeline 'rejected' row. Returns
   * false when the report does not exist.
   */
  remove(id: string, input: { note: string; actorId: string | null }): Promise<boolean>
  /** Record an in-app notification for the report's reporter (the follow-up to the reporter). */
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

// ---------------------------------------------------------------------------
// Pure helpers (no DB, no IO)
// ---------------------------------------------------------------------------

/**
 * The canonical civfix-status -> design-bucket reconciliation (decisions 8 / enumeration 4.2). The design
 * surface has only three live buckets (Submitted | In progress | Completed) plus the orthogonal Removed,
 * but the civfix lifecycle has seven statuses: submitted -> held -> published -> acknowledged ->
 * in_progress -> resolved (+ rejected). An authed pin is created `published` (live, visible, AWAITING city
 * action), so published+held belong in the SUBMITTED bucket, NOT Completed. Only `resolved` is Completed.
 *
 * This is the single source of truth the list-filter facet builds its status SET from; the admin frontend
 * keeps a matching map (src/lib/report-status.ts) so the pill labels and the filter never disagree.
 */
export const STATUS_BUCKETS: Record<
  "submitted" | "in_progress" | "completed" | "removed",
  AdminReportStatus[]
> = {
  submitted: ["submitted", "held", "published"],
  in_progress: ["acknowledged", "in_progress"],
  completed: ["resolved"],
  removed: ["rejected"],
}

/**
 * Map the list `filter` facet to a repo query shape. The design facet (all|submitted|in_progress|
 * completed|flagged) reconciles to a SET of civfix statuses to match (via STATUS_BUCKETS) and/or the
 * flagged-only marker. `all` matches everything.
 */
export function resolveListFilter(filter: string | undefined): {
  statuses: AdminReportStatus[] | null
  flaggedOnly: boolean
} {
  switch (filter) {
    case "submitted":
      return { statuses: STATUS_BUCKETS.submitted, flaggedOnly: false }
    case "in_progress":
      return { statuses: STATUS_BUCKETS.in_progress, flaggedOnly: false }
    case "completed":
      return { statuses: STATUS_BUCKETS.completed, flaggedOnly: false }
    case "flagged":
      return { statuses: null, flaggedOnly: true }
    default:
      return { statuses: null, flaggedOnly: false }
  }
}

/** A short human note for a status transition, used on the report_timeline row + the activity feed. */
export function statusChangeNote(status: AdminReportStatus): string {
  switch (status) {
    case "submitted":
      return "Status set to Submitted"
    case "in_progress":
      return "Status set to In progress"
    case "resolved":
      return "Status set to Resolved"
    case "rejected":
      return "Report removed"
    default:
      return `Status set to ${status}`
  }
}

/**
 * The note prefix a jurisdiction-reply timeline row carries (written by the inbound side-effects, §2.7).
 * The DTO maps a row with this prefix to the contract's `reply` timeline kind regardless of the row's
 * status, since report_timeline has no `kind` column (the kind is derived). Keep in lockstep with the
 * inbound processor's reply note.
 */
export const JURISDICTION_REPLY_NOTE_PREFIX = "Jurisdiction replied"

/**
 * Map a civfix report status to the design's timeline icon kind. The detail timeline renders an icon per
 * row; the design kinds are submit|route|confirm|status|done|warn|followup|remove.
 */
export function timelineKindForStatus(status: AdminReportStatus): ReportTimelineItem["kind"] {
  switch (status) {
    case "submitted":
      return "submit"
    case "acknowledged":
      return "route"
    case "resolved":
      return "done"
    case "rejected":
      return "remove"
    default:
      return "status"
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AdminReportServiceDeps {
  repo: AdminReportRepository
  /** The outbound-mail service used for the follow-up to the routed city contact. */
  outboundMail: OutboundMailService
  /**
   * Presign (or otherwise render) a media object's URL pair, wrapping the Storage seam — exactly like the
   * citizen report service. The repo returns raw object-store KEYS (r2_key / thumb_key); without presigning
   * those keys resolve against admin.civfix.org and 404 (the "reporter photo" box is always broken). When
   * omitted (offline unit tests) it defaults to an identity pass-through, so a test still sees the raw key.
   */
  presignMedia?: (
    r2Key: string,
    thumbKey: string | null,
  ) => Promise<{ url: string; thumbUrl?: string }>
  /**
   * Load the events (cleanups) a report is linked to (the report detail's "linked events" section).
   * OPTIONAL: when omitted, linkedEvents is always [] (the additive DTO default), so an un-wired/offline
   * path simply renders no section. Wraps the cleanup repo's loadLinkedEventsForReports.
   */
  loadLinkedEventsForReports?: (
    reportIds: string[],
  ) => Promise<Map<string, LinkedEventView[]>>
  /**
   * Load a media object's raw bytes for the Approve & send packet's photo attachments, wrapping the
   * Storage seam (`Storage.getObject(r2Key)`). OPTIONAL: when omitted (offline unit tests) it defaults to
   * returning null, so the routed email carries no binary attachments — only the presigned-link fallbacks.
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

export function makeAdminReportService(deps: AdminReportServiceDeps): AdminReportService {
  const now = deps.now ?? (() => new Date())
  // Default to an identity pass-through (raw keys) when no presigner is injected, so offline tests still
  // see the seeded key; production wires the real Storage presigner so the photo box renders.
  const presignMedia =
    deps.presignMedia ??
    (async (r2Key: string, thumbKey: string | null) =>
      thumbKey === null ? { url: r2Key } : { url: r2Key, thumbUrl: thumbKey })

  /** Project a report record into the list-row DTO (the shape both the list + detail base share). */
  function toListItem(record: AdminReportRecord, ref: Date): AdminReportListItemDTO {
    const reporter = record.reporter
    return {
      id: record.id,
      category: record.category,
      status: record.status,
      flagged: record.flagged,
      title: record.title,
      place: record.place,
      reporter: {
        id: reporter?.id ?? "",
        name: reporter?.name ?? "Anonymous",
        handle: reporter?.handle ?? "anonymous",
        joined: reporter?.joinedAt ? toRelAbs(reporter.joinedAt, ref).abs : "-",
      },
      confirmations: record.confirmations,
      submitted: toRelAbs(record.createdAt, ref),
      coords: [record.lat, record.lng],
      address: record.address,
      hasPhoto: record.hasPhoto,
    }
  }

  /** Project a timeline record into the wire DTO (relative "when" + icon kind). */
  function toTimelineDTO(record: AdminReportTimelineRecord, ref: Date): ReportTimelineItem {
    // A jurisdiction-reply row (written at the report's current status by the inbound side-effects) carries
    // the `reply` kind even though report_timeline has no kind column: we recognize it by its note prefix.
    const kind: ReportTimelineItem["kind"] =
      record.note?.startsWith(JURISDICTION_REPLY_NOTE_PREFIX) === true
        ? "reply"
        : timelineKindForStatus(record.status)
    return {
      who: record.who,
      what: record.note ?? statusChangeNote(record.status),
      when: toRelAbs(record.createdAt, ref).rel,
      kind,
    }
  }

  return {
    async list(query: AdminReportListQuery): Promise<AdminReportListResponse> {
      const ref = now()
      const { statuses, flaggedOnly } = resolveListFilter(query.filter)
      const args: ListReportsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        statuses,
        flaggedOnly,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      // Counts span the SEARCHED set (q) but ignore the status/flagged facet, so the chips stay accurate +
      // stable as the operator switches buckets (replaces the frontend's first-page-only client count).
      const [{ records, nextCursor }, counts] = await Promise.all([
        deps.repo.listReports(args),
        deps.repo.countByBucket({ q: args.q }),
      ])
      return { items: records.map((r) => toListItem(r, ref)), nextCursor, counts }
    },

    async get(id: string): Promise<AdminReportDTO> {
      const ref = now()
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")
      const [timeline, routing, media, linkedEventsMap, outreach] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.getRouting(id),
        deps.repo.listMedia(id),
        deps.loadLinkedEventsForReports !== undefined
          ? deps.loadLinkedEventsForReports([id])
          : Promise.resolve(new Map<string, LinkedEventView[]>()),
        deps.repo.getOutreach(id),
      ])
      const base = toListItem(record, ref)
      const city: ReportRouting = {
        dept: routing?.dept ?? "",
        place: routing?.place ?? record.place,
        contact: routing?.contact ?? null,
        routed: routing?.routed ?? false,
      }
      // Presign each media object so the admin gets browser-loadable URLs (the repo returns raw r2 keys).
      const mediaDtos: ReportMedia[] = await Promise.all(
        media.map(async (m) => {
          const { url, thumbUrl } = await presignMedia(m.r2Key, m.thumbKey)
          return { id: m.id, kind: m.kind, url, thumbUrl: thumbUrl ?? null }
        }),
      )
      const linkedEvents: LinkedEventRef[] = (linkedEventsMap.get(id) ?? []).map(toLinkedEventRef)
      const outreachDTO: ReportOutreach = {
        status: outreach.status,
        threadId: outreach.threadId,
        routedTo: outreach.routedTo,
        routedAt: outreach.routedAt,
      }
      return {
        ...base,
        desc: record.desc,
        timeline: timeline.map((t) => toTimelineDTO(t, ref)),
        city,
        media: mediaDtos,
        linkedEvents,
        // The report's resolved jurisdiction GEOID (deep-links the admin to its Jurisdictions row) + the
        // outreach lifecycle (was it emailed, did the city reply/bounce) + a per-report mail-thread link.
        geoid: routing?.geoid ?? null,
        outreach: outreachDTO,
      }
    },

    async setStatus(
      id: string,
      input: { status: AdminReportStatus; actorId: string | null },
    ): Promise<void> {
      const ok = await deps.repo.setStatus(id, {
        status: input.status,
        note: statusChangeNote(input.status),
        actorId: input.actorId,
      })
      if (!ok) throw AppError.notFound("Report not found")
    },

    async flag(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<boolean> {
      const flagged = await deps.repo.toggleFlag(id, input)
      if (flagged === null) throw AppError.notFound("Report not found")
      return flagged
    },

    async remove(
      id: string,
      input: { reason: string | null; actorId: string | null },
    ): Promise<void> {
      const note =
        input.reason && input.reason.trim() !== ""
          ? `Report removed: ${input.reason.trim()}`
          : statusChangeNote("rejected")
      const ok = await deps.repo.remove(id, { note, actorId: input.actorId })
      if (!ok) throw AppError.notFound("Report not found")
    },

    async sendFollowup(
      id: string,
      input: { to: "reporter" | "city"; body: string; actorId: string | null },
    ): Promise<FollowupResult> {
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")

      if (input.to === "reporter") {
        const reporterId = record.reporter?.id
        if (!reporterId || reporterId === "") {
          // An anonymous report has no account to notify (the design disables this only for City; guard
          // it server-side so a reporter follow-up to an anon report is a clear 422, not a silent no-op).
          throw AppError.validation({ to: "report has no reporter account to notify" })
        }
        await deps.repo.notifyReporter({
          reportId: id,
          reporterUserId: reporterId,
          title: "Update on your report",
          body: input.body,
          link: `/reports/${id}`,
        })
        // M4: the timeline + audit are written atomically by appendFollowup (one tx). The notify above is
        // an in-app row (also a DB write), so the only residual gap is a post-notify failure of this
        // record; retry once so a transient blip does not drop the audit, and never swallow a persistent
        // failure (it surfaces, rather than leaving a sent-but-unrecorded action invisible).
        await recordFollowup(deps, id, {
          note: "Follow-up sent to the reporter",
          actorId: input.actorId,
          to: "reporter",
          destination: reporterId,
        })
        return { to: "reporter", destination: reporterId }
      }

      // to === "city": route the follow-up to the jurisdiction's contact via the outbound-mail pipeline.
      const routing = await deps.repo.getRouting(id)
      const contact = routing?.contact ?? null
      if (contact === null || contact === "") {
        // The design disables City when no contact is on file; enforce it server-side (422, not a bounce).
        throw AppError.validation({ to: "no city contact on file for this report" })
      }
      await deps.outboundMail.sendToCity({
        geoid: routing?.geoid ?? null,
        toAddr: contact,
        subject: `civfix report ${id}`,
        body: input.body,
        reportContext: { reportId: id, category: record.category, place: record.place },
        org: routing?.dept ?? null,
      })
      // M4: SMTP cannot join a DB tx, so the email is already out here. Record the timeline + audit
      // (atomic in appendFollowup) with a one-shot retry so a transient DB blip after a successful send
      // does not drop the report.followup_sent record; a persistent failure is surfaced (not swallowed),
      // minimizing the sent-but-unrecorded window the review flagged.
      await recordFollowup(deps, id, {
        note: `Follow-up sent to ${contact}`,
        actorId: input.actorId,
        to: "city",
        destination: contact,
      })
      return { to: "city", destination: contact }
    },

    async routeToJurisdiction(
      id: string,
      input: { contactEmailOverride: string | null; note: string | null; actorId: string | null },
    ): Promise<RouteToJurisdictionResult> {
      // 1. Load the report (404 when missing/removed).
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")

      // 2. Resolve the destination: the per-send override (operator-typed) wins, else the routing contact.
      // With neither on file the report is not routable yet (422 NOT_ROUTABLE) — the city has no inbox.
      const routing = await deps.repo.getRouting(id)
      const override =
        input.contactEmailOverride && input.contactEmailOverride.trim() !== ""
          ? input.contactEmailOverride.trim()
          : null
      const toAddr = override ?? routing?.contact ?? null
      if (toAddr === null || toAddr === "") {
        throw AppError.notRoutable("No routing contact for this report's jurisdiction")
      }

      // 3. Load media: presign every asset for the HTML link list, and load the IMAGE bytes (skip
      // null/oversize, cap N) for the binary attachments. A missing presigner / loader simply yields
      // fewer attachments (link-only) — never an error, so an offline path still routes.
      const media = await deps.repo.listMedia(id)
      const mediaLinks: string[] = []
      const attachments: OutboundAttachment[] = []
      for (const m of media) {
        const { url } = await presignMedia(m.r2Key, m.thumbKey)
        mediaLinks.push(url)
        if (m.kind !== "image") continue
        if (attachments.length >= MAX_PACKET_ATTACHMENTS) continue
        const bytes = deps.loadMediaBytes ? await deps.loadMediaBytes(m.r2Key) : null
        if (bytes === null) continue
        if (bytes.byteLength > MAX_PACKET_ATTACHMENT_BYTES) continue
        attachments.push({
          filename: attachmentFilename(m.r2Key, attachments.length),
          contentType: "image/jpeg",
          content: bytes,
        })
      }

      // 4. Build the full packet (subject + text/html body with the report facts, the operator note, the
      // reporter label, and the photo links).
      const packet = buildReportPacket(record, routing, mediaLinks, input.note)

      // 5. Send it on the per-report thread (find-or-create by report_id, minted reply token, attachments).
      const { thread } = await deps.outboundMail.sendReportToJurisdiction({
        reportId: id,
        geoid: routing?.geoid ?? null,
        org: routing?.dept ?? null,
        toAddr,
        subject: packet.subject,
        text: packet.text,
        html: packet.html,
        ...(attachments.length > 0 ? { attachments } : {}),
      })

      // 6. Advance the report toward `acknowledged` — but only from a pre-acknowledged state, so re-routing
      // a report already in_progress/resolved never DOWNGRADES it. When past acknowledged, record the send
      // as a system timeline row instead (no status change, no audit).
      if (ROUTABLE_FROM_STATUSES.has(record.status)) {
        await deps.repo.setStatus(id, {
          status: "acknowledged",
          note: `Sent to jurisdiction (${toAddr})`,
          actorId: input.actorId,
        })
      } else {
        await deps.repo.appendSystemTimeline(id, {
          note: `Sent to jurisdiction (${toAddr})`,
          kind: "route",
        })
      }

      // 7. Return the thread + the address routed to (the route audits + acks from this).
      return { threadId: thread.id, routedTo: toAddr }
    },
  }
}

/** Max binary photo attachments on a routed packet (the rest are linked). */
const MAX_PACKET_ATTACHMENTS = 10
/** Max bytes for ONE routed-packet attachment (larger images are linked, not buffered). */
const MAX_PACKET_ATTACHMENT_BYTES = 10 * 1024 * 1024
/**
 * The report statuses from which Approve & send advances to `acknowledged`. A report already past
 * acknowledged (in_progress/resolved/rejected) keeps its status — re-sending only records a timeline row.
 */
const ROUTABLE_FROM_STATUSES = new Set<AdminReportStatus>(["submitted", "held", "published"])

/** Derive a safe image filename from an r2 key (last path segment), falling back to a numbered name. */
function attachmentFilename(r2Key: string, index: number): string {
  const tail = r2Key.split("/").pop() ?? ""
  const cleaned = tail.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "")
  if (cleaned.length > 0) return cleaned.slice(0, 120)
  return `photo-${index + 1}.jpg`
}

/** The rendered outreach packet: subject + a plain-text body and an HTML body (links + the operator note). */
export interface ReportPacket {
  subject: string
  text: string
  html: string
}

/**
 * Build the report packet emailed to a jurisdiction: a subject `civfix report: {title} [{id8}]` and a
 * text + HTML body carrying the report's title, category, address, coordinates + a map link, description,
 * the optional operator note, the reporter label (or "anonymous"), and the presigned photo links. Pure
 * (no IO) so it is unit-testable; the HTML escapes every interpolated value (the body is attacker-adjacent
 * — a report title/description is user content).
 */
export function buildReportPacket(
  record: AdminReportRecord,
  routing: AdminReportRoutingRecord | null,
  mediaLinks: string[],
  note: string | null,
): ReportPacket {
  const id8 = record.id.slice(0, 8)
  const subject = `civfix report: ${record.title} [${id8}]`
  const place = routing?.place ?? record.place
  const address = record.address && record.address.trim() !== "" ? record.address : place
  const mapLink = `https://www.openstreetmap.org/?mlat=${record.lat}&mlon=${record.lng}#map=18/${record.lat}/${record.lng}`
  const reporter = record.reporter?.name ?? "anonymous"
  const noteText = note && note.trim() !== "" ? note.trim() : null

  const textLines = [
    `A neighbor reported a ${record.category} issue in ${place} via civfix.`,
    "",
    `Title:       ${record.title}`,
    `Category:    ${record.category}`,
    `Location:    ${address}`,
    `Coordinates: ${record.lat}, ${record.lng}`,
    `Map:         ${mapLink}`,
    "",
    "Description:",
    record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)",
    "",
    `Reported by: ${reporter}`,
  ]
  if (noteText !== null) {
    textLines.push("", "Note from the civfix operator:", noteText)
  }
  if (mediaLinks.length > 0) {
    textLines.push("", "Photos:")
    for (const link of mediaLinks) textLines.push(link)
  }
  textLines.push("", `Reference: ${record.id}`, "Reply to this email to respond on the report.")
  const text = textLines.join("\n")

  const photosHtml =
    mediaLinks.length > 0
      ? `<p><strong>Photos:</strong></p><ul>${mediaLinks
          .map((l) => `<li><a href="${escapeHtmlValue(l)}">${escapeHtmlValue(l)}</a></li>`)
          .join("")}</ul>`
      : ""
  const noteHtml =
    noteText !== null
      ? `<p><strong>Note from the civfix operator:</strong><br>${escapeHtmlValue(noteText)}</p>`
      : ""
  const html =
    `<p>A neighbor reported a <strong>${escapeHtmlValue(record.category)}</strong> issue in ` +
    `${escapeHtmlValue(place)} via civfix.</p>` +
    `<table>` +
    `<tr><td><strong>Title</strong></td><td>${escapeHtmlValue(record.title)}</td></tr>` +
    `<tr><td><strong>Category</strong></td><td>${escapeHtmlValue(record.category)}</td></tr>` +
    `<tr><td><strong>Location</strong></td><td>${escapeHtmlValue(address)}</td></tr>` +
    `<tr><td><strong>Coordinates</strong></td><td>${record.lat}, ${record.lng} ` +
    `(<a href="${escapeHtmlValue(mapLink)}">map</a>)</td></tr>` +
    `<tr><td><strong>Reported by</strong></td><td>${escapeHtmlValue(reporter)}</td></tr>` +
    `</table>` +
    `<p><strong>Description:</strong><br>${escapeHtmlValue(
      record.desc && record.desc.trim() !== "" ? record.desc.trim() : "(none provided)",
    )}</p>` +
    noteHtml +
    photosHtml +
    `<p>Reference: ${escapeHtmlValue(record.id)}<br>Reply to this email to respond on the report.</p>`
  return { subject, text, html }
}

/** Escape the five HTML metacharacters so an interpolated report value cannot inject markup. */
function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Record a follow-up's timeline + audit (atomic in repo.appendFollowup) with a single retry (M4). The
 * external send (mail / in-app notify) has already happened by the time this is called, so a transient DB
 * failure here would otherwise drop the report.followup_sent record for a real send. One retry absorbs a
 * blip; a persistent failure is rethrown (surfaced, never swallowed) so a sent-but-unrecorded action is
 * loud rather than silent.
 */
async function recordFollowup(
  deps: AdminReportServiceDeps,
  id: string,
  input: { note: string; actorId: string | null; to: "reporter" | "city"; destination: string },
): Promise<void> {
  try {
    await deps.repo.appendFollowup(id, input)
  } catch {
    // One retry: the send already succeeded, so we try once more to durably record it before giving up.
    await deps.repo.appendFollowup(id, input)
  }
}
