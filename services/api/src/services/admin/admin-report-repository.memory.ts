/**
 * In-memory AdminReportRepository (Phase 2): the offline binding of the admin reports persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the admin report service can be unit-tested with NO
 * database (no Docker), the same way InMemoryDiscoveryRepository backs the discovery tests:
 *   - listReports applies the search (title/place/id/reporter) + the status + flagged-only facet and
 *     pages newest-id-keyset;
 *   - getReport/listTimeline/getRouting/listMedia read the seeded report + its extras;
 *   - setStatus / toggleFlag / remove mutate the report + append a timeline row;
 *   - notifyReporter records a notification row (inspectable for the follow-up-to-reporter test);
 *   - appendFollowup appends a followup timeline row.
 * Seed/inspect helpers (seedReport, the public reports/timeline/notifications maps) let tests arrange +
 * assert state directly.
 */

import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import type {
  AdminReporterRecord,
  AdminReportMediaRecord,
  AdminReportRecord,
  AdminReportRepository,
  AdminReportRoutingRecord,
  AdminReportTimelineRecord,
  ListReportsArgs,
  NotifyReporterInput,
} from "./admin-report-service.js"
import type {
  AdminReportCounts,
  AdminReportStatus,
  ReportCategory,
  ReportOutreachStatus,
  ReportTimelineItem,
} from "@civfix/shared"
import { mapOutreachStatus } from "./admin-report-repository.drizzle.js"

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
      },
      routing: input.routing ?? null,
      media: input.media ?? [],
      outreach: {
        threadId: input.outreach?.threadId ?? null,
        threadStatus: input.outreach?.threadStatus ?? null,
        hasInbound: input.outreach?.hasInbound ?? false,
        routedTo: input.outreach?.routedTo ?? null,
        routedAt: input.outreach?.routedAt ?? null,
      },
    }
    this.reports.set(id, seeded)
    if (input.timeline) this.timeline.set(id, [...input.timeline])
    return seeded
  }

  async listReports(
    args: ListReportsArgs,
  ): Promise<{ records: AdminReportRecord[]; nextCursor: string | null }> {
    let rows = [...this.reports.values()].map((s) => s.record)

    // A removed (rejected) report stays in the store but is excluded unless explicitly filtered to it; the
    // Drizzle impl filters deleted_at IS NULL. Here we keep rejected visible only when status filter asks.
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          r.place.toLowerCase().includes(needle) ||
          r.id.toLowerCase().includes(needle) ||
          (r.reporter?.name.toLowerCase().includes(needle) ?? false),
      )
    }
    if (args.statuses !== null) {
      const set = new Set(args.statuses)
      rows = rows.filter((r) => set.has(r.status))
    }
    if (args.flaggedOnly) {
      rows = rows.filter((r) => r.flagged)
    }

    // Newest-first by createdAt, id desc tiebreak (stable keyset).
    rows.sort((a, b) => {
      const primary = b.createdAt.getTime() - a.createdAt.getTime()
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    return pageByCursor(rows, args.cursor, args.limit)
  }

  async countByBucket(args: { q: string | null }): Promise<AdminReportCounts> {
    let rows = [...this.reports.values()].map((s) => s.record)
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          r.place.toLowerCase().includes(needle) ||
          r.id.toLowerCase().includes(needle) ||
          (r.reporter?.name.toLowerCase().includes(needle) ?? false),
      )
    }
    // Non-removed only (mirrors the Drizzle deleted_at IS NULL filter): a removed report is `rejected`.
    rows = rows.filter((r) => r.status !== "rejected")
    const SUBMITTED = new Set<AdminReportStatus>(["submitted", "held", "published"])
    const IN_PROGRESS = new Set<AdminReportStatus>(["acknowledged", "in_progress"])
    let submitted = 0
    let inProgress = 0
    let completed = 0
    let flagged = 0
    for (const r of rows) {
      if (SUBMITTED.has(r.status)) submitted += 1
      else if (IN_PROGRESS.has(r.status)) inProgress += 1
      else if (r.status === "resolved") completed += 1
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
    return this.reports.get(id)?.record ?? null
  }

  async listTimeline(id: string): Promise<AdminReportTimelineRecord[]> {
    return [...(this.timeline.get(id) ?? [])]
  }

  async getRouting(id: string): Promise<AdminReportRoutingRecord | null> {
    return this.reports.get(id)?.routing ?? null
  }

  async getOutreach(id: string): Promise<{
    status: ReportOutreachStatus
    threadId: string | null
    routedTo: string | null
    routedAt: string | null
  }> {
    const o = this.reports.get(id)?.outreach
    if (!o || o.threadStatus === null) {
      return { status: "not_sent", threadId: null, routedTo: null, routedAt: null }
    }
    return {
      // Same mapping the Drizzle impl uses (shared mapOutreachStatus), so the two repos agree.
      status: mapOutreachStatus(o.threadStatus, o.hasInbound),
      threadId: o.threadId,
      routedTo: o.routedTo,
      routedAt: o.routedAt ? o.routedAt.toISOString() : null,
    }
  }

  async appendSystemTimeline(
    id: string,
    input: { note: string; kind: ReportTimelineItem["kind"] },
  ): Promise<void> {
    const seeded = this.reports.get(id)
    if (!seeded) return
    // A system row at the report's current status, no actor, no audit (mirrors the Drizzle impl). `kind`
    // is not persisted (the DTO re-derives it); it is part of the contract only.
    void input.kind
    this.appendTimeline(id, {
      status: seeded.record.status,
      note: input.note,
      who: "system",
      createdAt: this.nextDate(),
    })
  }

  async listMedia(id: string): Promise<AdminReportMediaRecord[]> {
    return [...(this.reports.get(id)?.media ?? [])]
  }

  async setStatus(
    id: string,
    input: { status: AdminReportStatus; note: string; actorId: string | null },
  ): Promise<boolean> {
    const seeded = this.reports.get(id)
    if (!seeded) return false
    seeded.record.status = input.status
    this.appendTimeline(id, {
      status: input.status,
      note: input.note,
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

/** Page a sorted array by the shared "<iso>|<id>" id-keyset cursor (one-extra-row probe). */
function pageByCursor(
  rows: AdminReportRecord[],
  cursor: string | null,
  limit: number | undefined,
): { records: AdminReportRecord[]; nextCursor: string | null } {
  const lim = clampLimit(limit)
  const anchor = decodeCursor(cursor)
  let start = 0
  if (anchor) {
    const idx = rows.findIndex((r) => r.id === anchor.id)
    start = idx >= 0 ? idx + 1 : rows.length
  }
  const slice = rows.slice(start, start + lim + 1)
  if (slice.length <= lim) {
    return { records: slice, nextCursor: null }
  }
  const records = slice.slice(0, lim)
  const last = records[records.length - 1]
  const nextCursor = last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  return { records, nextCursor }
}
