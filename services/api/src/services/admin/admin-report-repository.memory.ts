/**
 * In-memory AdminReportRepository: the offline binding of the admin reports persistence seam, faithful to
 * the Drizzle impl's OBSERVABLE contract so the service is unit-testable with no database. Seed/inspect
 * helpers (seedReport + the public reports/timeline/notifications maps) let tests arrange + assert state.
 */

import { randomUUID } from "node:crypto"
import { isUuid } from "../../db/cursor-helpers.js"
import { pageInMemoryById } from "./pagination.js"
import type {
  AdminReporterRecord,
  AdminReportMediaRecord,
  AdminReportRecord,
  AdminReportRepository,
  AdminReportRoutingRecord,
  AdminReportTimelineRecord,
  ListReportsArgs,
  NotifyReporterInput,
  ReportOutreachState,
} from "./admin-report-service.js"
import type {
  AdminReportCounts,
  AdminReportStatus,
  ReportCategory,
  ReportTimelineItem,
} from "@civfix/shared"
import { mapOutreachStatus } from "./admin-report-repository.drizzle.js"
import { REPORT_VERIFIED_THRESHOLD } from "./admin-report-service.js"
import { STATUS_BUCKETS } from "./admin-report-status.js"

/** A recorded notification (the follow-up to the reporter), inspectable by tests. */
export interface RecordedReportNotification {
  reportId: string
  userId: string
  title: string
  body: string
  link: string | null
}

/** A recorded audit row (the Drizzle impl writes audit_log in-tx; here it is captured for assertions). */
export interface RecordedAudit {
  action: string
  target: string
  meta: Record<string, unknown>
}

/**
 * The per-report outreach state the memory repo's getOutreach derives from (mirrors the per-report mail
 * thread + its OUT/IN messages the Drizzle impl joins). A test seeds this to exercise the outreach status
 * mapping; the default (no thread) yields `not_sent`.
 */
export interface SeededOutreach {
  threadId: string | null
  /** The mail thread status (sent|delivered|opened|replied|bounced|...), or null when no thread exists. */
  threadStatus: string | null
  /** Whether any inbound (city reply) message has landed on the thread. */
  hasInbound: boolean
  routedTo: string | null
  routedAt: Date | null
  /**
   * Whether every send on the thread threw: a 'failed' mail_event and no 'sent' one (the Drizzle impl
   * derives this in SQL). The thread is stamped 'sent' before the mailer runs, so this is the only way to
   * tell a lost send from a real one — the route endpoint's retry gate reads it.
   */
  sendFailed: boolean
}

/** A seeded report plus its detail extras (routing/media/outreach) held in one place. */
export interface SeededReport {
  record: AdminReportRecord
  routing: AdminReportRoutingRecord | null
  media: AdminReportMediaRecord[]
  outreach: SeededOutreach
}

/** An in-memory AdminReportRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryAdminReportRepository implements AdminReportRepository {
  /** Seeded reports keyed by id (insertion order preserved for stable paging). */
  readonly reports = new Map<string, SeededReport>()
  /** Timeline rows keyed by report id, oldest first. */
  readonly timeline = new Map<string, AdminReportTimelineRecord[]>()
  /** Recorded reporter notifications (the follow-up-to-reporter side effect). */
  readonly notifications: RecordedReportNotification[] = []
  /** Recorded audit rows (mirrors the Drizzle impl's in-tx writeAudit), inspectable by tests. */
  readonly audits: RecordedAudit[] = []
  /**
   * Mirror of user_moderation.report_verified keyed by reporter user id (the Drizzle impl flips it in the
   * verdict tx). Inspectable by tests; seeded false by default for any reporter the verdict flow touches.
   */
  readonly reporterReportVerified = new Map<string, boolean>()

  /** Deterministic clock for appended timeline rows; each row advances by one millisecond. */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  /** Seed a report. Defaults fill the optional fields so a test only sets what it asserts on. */
  seedReport(input: {
    id?: string
    category?: ReportCategory
    status?: AdminReportStatus
    flagged?: boolean
    title?: string
    place?: string
    reporter?: AdminReporterRecord | null
    confirmations?: number
    address?: string
    desc?: string
    lat?: number
    lng?: number
    hasPhoto?: boolean
    createdAt?: Date
    referenceCode?: string | null
    verificationVerdict?: "approved" | "rejected" | null
    verifiedAt?: Date | null
    reporterReportVerified?: boolean | null
    routing?: AdminReportRoutingRecord | null
    media?: AdminReportMediaRecord[]
    timeline?: AdminReportTimelineRecord[]
    outreach?: Partial<SeededOutreach>
  }): SeededReport {
    const id = input.id ?? randomUUID()
    const seeded: SeededReport = {
      record: {
        id,
        category: input.category ?? "other",
        status: input.status ?? "submitted",
        flagged: input.flagged ?? false,
        title: input.title ?? "Untitled report",
        place: input.place ?? "Somewhere",
        reporter: input.reporter === undefined ? defaultReporter() : input.reporter,
        confirmations: input.confirmations ?? 0,
        address: input.address ?? "",
        desc: input.desc ?? "",
        lat: input.lat ?? 0,
        lng: input.lng ?? 0,
        hasPhoto: input.hasPhoto ?? false,
        createdAt: input.createdAt ?? this.now,
        referenceCode: input.referenceCode ?? null,
        verificationVerdict: input.verificationVerdict ?? null,
        verifiedAt: input.verifiedAt ?? null,
        // The record carries the read-time projection; the live value comes from reporterReportVerified
        // below (mirroring the Drizzle LEFT JOIN). Stored here for the seed default, recomputed in getReport.
        reporterReportVerified: input.reporterReportVerified ?? null,
      },
      routing: input.routing ?? null,
      media: input.media ?? [],
      outreach: {
        threadId: input.outreach?.threadId ?? null,
        threadStatus: input.outreach?.threadStatus ?? null,
        hasInbound: input.outreach?.hasInbound ?? false,
        routedTo: input.outreach?.routedTo ?? null,
        routedAt: input.outreach?.routedAt ?? null,
        sendFailed: input.outreach?.sendFailed ?? false,
      },
    }
    this.reports.set(id, seeded)
    if (input.timeline) this.timeline.set(id, [...input.timeline])
    // Seed the reporter's report_verified mirror (the LEFT JOIN source) when the seed expressed it and the
    // report has a (non-anon) reporter, so getReport projects the live value the way the Drizzle join does.
    const reporterId = seeded.record.reporter?.id
    if (reporterId && reporterId !== "" && input.reporterReportVerified != null) {
      this.reporterReportVerified.set(reporterId, input.reporterReportVerified)
    }
    return seeded
  }

  /** Project a stored record with the LIVE reporter report_verified (mirrors the Drizzle LEFT JOIN). */
  private projectRecord(record: AdminReportRecord): AdminReportRecord {
    const reporterId = record.reporter?.id
    const reporterReportVerified =
      reporterId && reporterId !== ""
        ? (this.reporterReportVerified.get(reporterId) ?? false)
        : null
    return { ...record, reporterReportVerified }
  }

  async listReports(
    args: ListReportsArgs,
  ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }> {
    let rows = [...this.reports.values()].map((s) => this.projectRecord(s.record))

    if (args.q !== null) rows = rows.filter((r) => matchesSearch(r, args.q as string))
    if (args.statuses !== null) {
      const set = new Set(args.statuses)
      rows = rows.filter((r) => set.has(r.status))
    } else {
      // The Drizzle impl filters deleted_at IS NULL; a removed report is `rejected`. Exclude it unless a
      // status filter explicitly asks for it, so a removed report doesn't stay visible in the default list.
      rows = rows.filter((r) => r.status !== "rejected")
    }
    if (args.flaggedOnly) rows = rows.filter((r) => r.flagged)

    // Newest-first by createdAt, id desc tiebreak (stable keyset).
    rows.sort((a, b) => {
      const primary = b.createdAt.getTime() - a.createdAt.getTime()
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    return pageInMemoryById(rows, args.cursor, args.limit, (r) => ({
      createdAt: r.createdAt,
      id: r.id,
    }))
  }

  async countByBucket(args: { q: string | null }): Promise<AdminReportCounts> {
    let rows = [...this.reports.values()].map((s) => s.record)
    if (args.q !== null) rows = rows.filter((r) => matchesSearch(r, args.q as string))
    // Non-removed only (mirrors the Drizzle deleted_at IS NULL filter): a removed report is `rejected`.
    rows = rows.filter((r) => r.status !== "rejected")
    const submittedSet = new Set<AdminReportStatus>(STATUS_BUCKETS.submitted)
    const inProgressSet = new Set<AdminReportStatus>(STATUS_BUCKETS.in_progress)
    const completedSet = new Set<AdminReportStatus>(STATUS_BUCKETS.completed)
    let submitted = 0
    let inProgress = 0
    let completed = 0
    let flagged = 0
    for (const r of rows) {
      if (submittedSet.has(r.status)) submitted += 1
      else if (inProgressSet.has(r.status)) inProgress += 1
      else if (completedSet.has(r.status)) completed += 1
      if (r.flagged) flagged += 1
    }
    return {
      all: submitted + inProgress + completed,
      submitted,
      in_progress: inProgress,
      completed,
      flagged,
    }
  }

  async getReport(id: string): Promise<AdminReportRecord | null> {
    const record = this.reports.get(id)?.record
    return record ? this.projectRecord(record) : null
  }

  async listTimeline(id: string): Promise<AdminReportTimelineRecord[]> {
    return [...(this.timeline.get(id) ?? [])]
  }

  async getRouting(id: string): Promise<AdminReportRoutingRecord | null> {
    return this.reports.get(id)?.routing ?? null
  }

  async getOutreach(id: string): Promise<ReportOutreachState> {
    const o = this.reports.get(id)?.outreach
    if (!o || o.threadStatus === null) {
      return { status: "not_sent", threadId: null, routedTo: null, routedAt: null, sendFailed: false }
    }
    return {
      // Same mapping the Drizzle impl uses (shared mapOutreachStatus), so the two repos agree.
      status: mapOutreachStatus(o.threadStatus, o.hasInbound),
      threadId: o.threadId,
      routedTo: o.routedTo,
      routedAt: o.routedAt ? o.routedAt.toISOString() : null,
      sendFailed: o.sendFailed,
    }
  }

  async appendSystemTimeline(
    id: string,
    input: { note: string; kind: ReportTimelineItem["kind"]; body?: string | null },
  ): Promise<void> {
    const seeded = this.reports.get(id)
    if (!seeded) return
    // A system row at the report's current status, no actor, no audit (mirrors the Drizzle impl). `kind` is
    // stored the way 0031's column is (listTimeline reads it back and the DTO prefers it); `body` is the
    // PUBLIC timeline's full-reply text and has no admin surface, so it is accepted and not stored.
    void input.body
    this.appendTimeline(id, {
      status: seeded.record.status,
      note: input.note,
      kind: input.kind ?? null,
      who: "system",
      createdAt: this.nextDate(),
    })
  }

  async listMedia(id: string): Promise<AdminReportMediaRecord[]> {
    return [...(this.reports.get(id)?.media ?? [])]
  }

  async setStatus(
    id: string,
    input: {
      status: AdminReportStatus
      note: string
      actorId: string | null
      kind?: ReportTimelineItem["kind"]
      body?: string | null
    },
  ): Promise<boolean> {
    const seeded = this.reports.get(id)
    if (!seeded) return false
    // `body` (D13) feeds the PUBLIC timeline projection only; `kind` is stored like 0031's column.
    void input.body
    seeded.record.status = input.status
    this.appendTimeline(id, {
      status: input.status,
      note: input.note,
      kind: input.kind ?? null,
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: "report.status_changed",
      target: `report:${id}`,
      meta: { status: input.status },
    })
    return true
  }

  async toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null> {
    const seeded = this.reports.get(id)
    if (!seeded) return null
    const next = !seeded.record.flagged
    seeded.record.flagged = next
    this.appendTimeline(id, {
      status: seeded.record.status,
      note: next ? "Flagged for review" : "Flag cleared",
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: next ? "report.flagged" : "report.unflagged",
      target: `report:${id}`,
      meta: { reason: input.reason },
    })
    return next
  }

  async remove(id: string, input: { note: string; actorId: string | null }): Promise<boolean> {
    const seeded = this.reports.get(id)
    if (!seeded) return false
    seeded.record.status = "rejected"
    this.appendTimeline(id, {
      status: "rejected",
      note: input.note,
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: "report.removed",
      target: `report:${id}`,
      meta: { note: input.note },
    })
    return true
  }

  async notifyReporter(input: NotifyReporterInput): Promise<void> {
    this.notifications.push({
      reportId: input.reportId,
      userId: input.reporterUserId,
      title: input.title,
      body: input.body,
      link: input.link,
    })
  }

  async appendFollowup(
    id: string,
    input: {
      note: string
      actorId: string | null
      to: "reporter" | "city"
      destination: string
    },
  ): Promise<void> {
    this.appendTimeline(id, {
      status: this.reports.get(id)?.record.status ?? "submitted",
      note: input.note,
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: "report.followup_sent",
      target: `report:${id}`,
      meta: { to: input.to, destination: input.destination },
    })
  }

  async setReportVerdict(
    id: string,
    input: { verdict: "approved" | "rejected"; actorId: string | null },
  ): Promise<boolean> {
    const seeded = this.reports.get(id)
    if (!seeded) return false
    // Write the verdict (idempotent: re-setting the same verdict re-stamps verifiedAt), mirroring the
    // Drizzle UPDATE ... RETURNING reporter_user_id.
    seeded.record.verificationVerdict = input.verdict
    seeded.record.verifiedAt = this.nextDate()
    this.audits.push({
      action: "report.verdict_set",
      target: `report:${id}`,
      meta: { verdict: input.verdict },
    })

    // Only an `approved` verdict for a non-anon reporter can earn report_verified. `rejected` never counts
    // and never resets an earned flag; an anon report (no reporter id) never counts (D7).
    const reporterId = seeded.record.reporter?.id
    if (input.verdict !== "approved" || !reporterId || reporterId === "") return true

    // Recompute the reporter's approved, non-deleted report count (idempotent). At/above the threshold,
    // flip report_verified to true if not already set (mirrors the Drizzle count + conditional upsert).
    const approvedCount = [...this.reports.values()].filter(
      (s) =>
        s.record.reporter?.id === reporterId &&
        s.record.verificationVerdict === "approved" &&
        s.record.status !== "rejected",
    ).length
    if (approvedCount >= REPORT_VERIFIED_THRESHOLD && this.reporterReportVerified.get(reporterId) !== true) {
      this.reporterReportVerified.set(reporterId, true)
    }
    return true
  }

  private appendTimeline(id: string, row: AdminReportTimelineRecord): void {
    const list = this.timeline.get(id) ?? []
    list.push(row)
    this.timeline.set(id, list)
  }
}

/** Default seeded reporter (a claimed account with a verified email + oauth). */
function defaultReporter(): AdminReporterRecord {
  return {
    id: randomUUID(),
    name: "Jane Neighbor",
    handle: "jane",
    emailVerified: true,
    hasOauth: false,
    joinedAt: new Date(Date.UTC(2025, 0, 1)),
  }
}

/**
 * Search predicate shared by listReports + countByBucket so the chips and the list always agree.
 *
 * MIRRORS searchReportsFragment (admin-report-repository.drizzle.ts) COLUMN FOR COLUMN:
 *   `r.title ILIKE %q% OR j.name ILIKE %q% OR u.display_name ILIKE %q% OR u.handle ILIKE %q%`
 *   `OR r.id = $q::uuid` — the id branch only when q is a uuid.
 * Two drifts used to make search unit tests pass against behavior production does not have: the id was
 * matched as a SUBSTRING (SQL does an exact uuid equality, so "rep-1" or a uuid prefix finds nothing), and
 * the reporter HANDLE was not searched at all (SQL matches `u.handle::text`).
 */
function matchesSearch(record: AdminReportRecord, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    record.title.toLowerCase().includes(needle) ||
    record.place.toLowerCase().includes(needle) ||
    (isUuid(q) && record.id.toLowerCase() === needle) ||
    (record.reporter?.name.toLowerCase().includes(needle) ?? false) ||
    (record.reporter?.handle?.toLowerCase().includes(needle) ?? false)
  )
}
