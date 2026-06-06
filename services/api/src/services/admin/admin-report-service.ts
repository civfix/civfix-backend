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
  AdminReportDTO,
  AdminReportListItemDTO,
  AdminReportListQuery,
  AdminReportListResponse,
  AdminReportStatus,
  ReportCategory,
  ReportMedia,
  ReportRouting,
  ReportTimelineItem,
} from "@civfix/shared"
import type { OutboundMailService } from "./outbound-mail-service.js"
import { deriveTrust, toRelAbs } from "./admin-format.js"

// ---------------------------------------------------------------------------
// Repository seam (structural records; faked in tests)
// ---------------------------------------------------------------------------

/** The reporter (author) of a report, as the repo resolves it (or null for an anonymous report). */
export interface AdminReporterRecord {
  id: string
  name: string
  handle: string | null
  /** Whether the account's email is proven (drives the derived trust label). */
  emailVerified: boolean
  /** Whether any oauth identity links the account (also makes a verified neighbor). */
  hasOauth: boolean
  joinedAt: Date | null
}

/** A media asset attached to a report (the real object-store url, resolved by the repo). */
export interface AdminReportMediaRecord {
  id: string
  kind: "image" | "video"
  url: string
  thumbUrl: string | null
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

/** Normalized list arguments the repo consumes. `status` is the civfix status to match (null = any). */
export interface ListReportsArgs {
  q: string | null
  /** A specific civfix status to match (submitted|in_progress|resolved), or null for any. */
  status: AdminReportStatus | null
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
  /** Load one report's base record by id, or null when it does not exist (or is deleted). */
  getReport(id: string): Promise<AdminReportRecord | null>
  /** Load the ordered timeline for a report (oldest first). */
  listTimeline(id: string): Promise<AdminReportTimelineRecord[]>
  /** Load the routing posture (department + resolved contact) for a report's jurisdiction. */
  getRouting(id: string): Promise<AdminReportRoutingRecord | null>
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
 * Map the list `filter` facet to a repo query shape. The design facet (all|submitted|in_progress|
 * completed|flagged) reconciles to: a civfix status to match (completed -> resolved) and/or the
 * flagged-only marker. `all` matches everything.
 */
export function resolveListFilter(filter: string | undefined): {
  status: AdminReportStatus | null
  flaggedOnly: boolean
} {
  switch (filter) {
    case "submitted":
      return { status: "submitted", flaggedOnly: false }
    case "in_progress":
      return { status: "in_progress", flaggedOnly: false }
    case "completed":
      // Reconciliation: the design's "completed" bucket is the civfix resolved status.
      return { status: "resolved", flaggedOnly: false }
    case "flagged":
      return { status: null, flaggedOnly: true }
    default:
      return { status: null, flaggedOnly: false }
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
  /** Injectable clock (defaults to () => new Date()) so the relative-age labels are deterministic. */
  now?: () => Date
}

/** The outcome of a follow-up send, so the route can audit + ack with the right target/channel. */
export interface FollowupResult {
  to: "reporter" | "city"
  /** The destination address (city) or the reporter's user id (reporter). */
  destination: string
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
}

export function makeAdminReportService(deps: AdminReportServiceDeps): AdminReportService {
  const now = deps.now ?? (() => new Date())

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
        trust: reporter
          ? deriveTrust({ emailVerified: reporter.emailVerified, hasOauth: reporter.hasOauth })
          : "Unverified",
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
    return {
      who: record.who,
      what: record.note ?? statusChangeNote(record.status),
      when: toRelAbs(record.createdAt, ref).rel,
      kind: timelineKindForStatus(record.status),
    }
  }

  return {
    async list(query: AdminReportListQuery): Promise<AdminReportListResponse> {
      const ref = now()
      const { status, flaggedOnly } = resolveListFilter(query.filter)
      const args: ListReportsArgs = {
        q: query.q && query.q.trim() !== "" ? query.q.trim() : null,
        status,
        flaggedOnly,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 25,
      }
      const { records, nextCursor } = await deps.repo.listReports(args)
      return { items: records.map((r) => toListItem(r, ref)), nextCursor }
    },

    async get(id: string): Promise<AdminReportDTO> {
      const ref = now()
      const record = await deps.repo.getReport(id)
      if (!record) throw AppError.notFound("Report not found")
      const [timeline, routing, media] = await Promise.all([
        deps.repo.listTimeline(id),
        deps.repo.getRouting(id),
        deps.repo.listMedia(id),
      ])
      const base = toListItem(record, ref)
      const city: ReportRouting = {
        dept: routing?.dept ?? "",
        place: routing?.place ?? record.place,
        contact: routing?.contact ?? null,
        routed: routing?.routed ?? false,
      }
      const mediaDtos: ReportMedia[] = media.map((m) => ({
        id: m.id,
        kind: m.kind,
        url: m.url,
        thumbUrl: m.thumbUrl,
      }))
      return {
        ...base,
        desc: record.desc,
        timeline: timeline.map((t) => toTimelineDTO(t, ref)),
        city,
        media: mediaDtos,
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
  }
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
