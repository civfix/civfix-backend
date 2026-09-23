/**
 * In-memory AdminEventRepository (Phase 2): the offline binding of the admin events persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the admin event service can be unit-tested with NO
 * database (no Docker):
 *   - listEvents applies the search (title/address/organizer name+handle, exact-uuid id — see
 *     matchesQuery) + the status + flagged-only facet and pages newest-id-keyset; flagged is derived from
 *     the seeded timeline kinds;
 *   - getEvent/listTimeline/listMessages read the seeded cleanup + its extras;
 *   - toggleFlag / cancel mutate the cleanup + append a cleanup_timeline row;
 *
 * STATUS (0.46.0): like the Drizzle repo, this fake DERIVES the status from scheduled_at/ends_at against
 * the wall clock and reads the stored value only for 'cancelled' (cleanup-rules.deriveCleanupStatus, the
 * TS twin of cleanupStatusExpr). seedEvent takes an EventStatus (or a raw legacy `storedStatus`) and,
 * unless the caller pins `scheduledAt`/`endsAt`, seeds a window that derives back to it.
 *   - postMessage appends a chat message + a 'message' timeline row + returns the seeded members;
 *   - notifyMember records a notification row (inspectable for the message-attendees test).
 * Seed/inspect helpers (seedEvent, seedMember, the public maps) let tests arrange + assert state.
 */

import { randomUUID } from "node:crypto"
import { isUuid } from "../../db/cursor-helpers.js"
import { pageInMemoryById } from "./pagination.js"
import { flaggedFromTimeline } from "./admin-event-helpers.js"
import { isPubliclyVisibleStatus } from "../report-visibility.js"
import { toEventStatus } from "./event-status.js"
import { CIVFIX_OFFICIAL_DISPLAY_NAME } from "../../auth/official-account.js"
import { DEFAULT_EVENT_DURATION_MS, deriveCleanupStatus } from "../cleanup-rules.js"
import type {
  AdminEventMessageRecord,
  AdminEventRecord,
  AdminEventRepository,
  AdminEventTimelineRecord,
  AdminOrganizerRecord,
  EventMemberRef,
  ListEventsArgs,
} from "./admin-event-service.js"
import type { LinkedReportView } from "../cleanup-service.js"
import type { AdminEventCounts, EventKind, EventStatus, ReportCategory } from "@civfix/shared"

function seededWindow(
  status: string,
  scheduledAt: Date | undefined,
  endsAt: Date | undefined,
): { scheduledAt: Date; endsAt: Date } {
  const start = scheduledAt ?? new Date(Date.now() + defaultStartOffsetMs(status))
  return { scheduledAt: start, endsAt: endsAt ?? new Date(start.getTime() + DEFAULT_EVENT_DURATION_MS) }
}

function defaultStartOffsetMs(status: string): number {
  if (status === "in_progress" || status === "active") return -3_600_000
  if (status === "completed" || status === "done") return -DEFAULT_EVENT_DURATION_MS - 3_600_000
  return 7 * 86_400_000
}

/** A recorded member notification (the message-attendees fan-out), inspectable by tests. */
export interface RecordedMemberNotification {
  cleanupId: string
  userId: string
  title: string
  body: string
  link: string | null
}

/** A recorded audit row (mirrors the Drizzle impl's in-tx writeAudit), inspectable by tests. */
export interface RecordedEventAudit {
  action: string
  target: string
  meta: Record<string, unknown>
}

/** A seeded cleanup plus its detail extras held in one place. */
export interface SeededEvent {
  record: AdminEventRecord
  /** The raw stored cleanups.status; only 'cancelled' is consulted, exactly as the SQL does. */
  storedStatus: string
  /** cleanups.ends_at — the derivation's right edge. */
  endsAt: Date
  /** cleanups.organization_id (the org link), for the admin org events list. */
  organizationId: string | null
  members: EventMemberRef[]
}

/** A seeded report (the subset the link gallery + the visibility filter need). */
export interface SeededAdminReport {
  id: string
  category: ReportCategory
  title: string | null
  status: LinkedReportView["status"]
  visibility: "public" | "hidden"
  lat: number
  lng: number
  addr: string | null
  thumbKey: string | null
  deleted: boolean
}

/** An in-memory AdminEventRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryAdminEventRepository implements AdminEventRepository {
  /** Seeded cleanups keyed by id (insertion order preserved for stable paging). */
  readonly events = new Map<string, SeededEvent>()
  /** Timeline rows keyed by cleanup id, oldest first. */
  readonly timeline = new Map<string, AdminEventTimelineRecord[]>()
  /** Chat messages keyed by cleanup id, oldest first. */
  readonly messages = new Map<string, AdminEventMessageRecord[]>()
  /** Recorded member notifications (the message-attendees side effect). */
  readonly notifications: RecordedMemberNotification[] = []
  /** Recorded audit rows. */
  readonly audits: RecordedEventAudit[] = []
  /** Seeded reports keyed by id (for the link gallery + visibility filter). */
  readonly reports = new Map<string, SeededAdminReport>()
  /** cleanup_reports junction rows ({cleanupId, reportId, linkedAt}). */
  readonly links: { cleanupId: string; reportId: string; linkedAt: Date }[] = []

  /** Deterministic clock for appended rows; each row advances by one millisecond. */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  /**
   * Seed a cleanup. Defaults fill the optional fields so a test only sets what it asserts on. Pass
   * `status` (an EventStatus, mapped to the stored Phase-1 value) for the common case, or `storedStatus`
   * to seed a RAW Phase-1 value directly (e.g. a legacy 'active'/'done' row, for the H1 filter test).
   */
  seedEvent(input: {
    id?: string
    status?: EventStatus
    /** Raw stored cleanups.status override (Phase-1 enum). Wins over `status` when provided. */
    storedStatus?: string
    eventKind?: EventKind
    title?: string
    place?: string
    attendees?: number
    capacity?: number | null
    bags?: number
    organizer?: AdminOrganizerRecord | null
    desc?: string
    address?: string
    lat?: number
    lng?: number
    scheduledAt?: Date
    endsAt?: Date
    organizationId?: string | null
    members?: EventMemberRef[]
    timeline?: AdminEventTimelineRecord[]
    messages?: AdminEventMessageRecord[]
  }): SeededEvent {
    const id = input.id ?? randomUUID()
    const timeline = input.timeline ?? []
    const seededStatus = input.storedStatus ?? input.status ?? "upcoming"
    const storedStatus = seededStatus === "cancelled" ? "cancelled" : "upcoming"
    const window = seededWindow(seededStatus, input.scheduledAt, input.endsAt)
    const seeded: SeededEvent = {
      record: {
        id,
        status: toEventStatus(seededStatus),
        eventKind: input.eventKind ?? "cleanup",
        flagged: flaggedFromTimeline(timeline.map((t) => t.kind)),
        title: input.title ?? "Park cleanup",
        place: input.place ?? "Somewhere",
        attendees: input.attendees ?? input.members?.length ?? 0,
        capacity: input.capacity ?? null,
        bags: input.bags ?? 0,
        organizer: input.organizer === undefined ? defaultOrganizer() : input.organizer,
        desc: input.desc ?? "",
        address: input.address ?? "",
        lat: input.lat ?? 0,
        lng: input.lng ?? 0,
        scheduledAt: window.scheduledAt,
      },
      storedStatus,
      endsAt: window.endsAt,
      organizationId: input.organizationId ?? null,
      members: input.members ?? [],
    }
    this.events.set(id, seeded)
    if (timeline.length > 0) this.timeline.set(id, [...timeline])
    if (input.messages) this.messages.set(id, [...input.messages])
    return seeded
  }

  /** Seed a report so the link gallery + visibility filter resolve. Defaults to visible (published+public). */
  seedReport(over: Partial<SeededAdminReport> & { id?: string } = {}): SeededAdminReport {
    const report: SeededAdminReport = {
      id: over.id ?? randomUUID(),
      category: over.category ?? "trash",
      title: over.title ?? "Overflowing bin",
      status: over.status ?? "published",
      visibility: over.visibility ?? "public",
      lat: over.lat ?? 0,
      lng: over.lng ?? 0,
      addr: over.addr ?? null,
      thumbKey: over.thumbKey ?? null,
      deleted: over.deleted ?? false,
    }
    this.reports.set(report.id, report)
    return report
  }

  /** Seed a cleanup_reports link directly. */
  seedLink(cleanupId: string, reportId: string): void {
    this.links.push({ cleanupId, reportId, linkedAt: this.nextDate() })
  }

  /**
   * True when a report is publicly visible - mirrors publicReportFilter(sql), which the Drizzle repo uses
   * for both the gallery read and the link-insert validator. Reads the status set from
   * report-visibility.ts rather than re-typing it: a hardcoded `status === "published"` here would make
   * the fake UNDER-select relative to prod (a resolved report would vanish from an event's gallery).
   */
  private reportVisible(r: SeededAdminReport | undefined): r is SeededAdminReport {
    return (
      r !== undefined && !r.deleted && isPubliclyVisibleStatus(r.status) && r.visibility === "public"
    )
  }

  async listEvents(
    args: ListEventsArgs,
  ): Promise<{ records: AdminEventRecord[]; nextCursor: string | null }> {
    let seededRows = [...this.events.values()]

    if (args.status !== null) {
      seededRows = seededRows.filter((s) => this.derivedStatus(s) === args.status)
    }
    if (args.organizationId !== undefined) {
      seededRows = seededRows.filter((s) => s.organizationId === args.organizationId)
    }
    let rows = seededRows.map((s) => this.projected(s))

    if (args.q !== null) rows = rows.filter((r) => matchesQuery(r, args.q as string))
    if (args.flaggedOnly) rows = rows.filter((r) => r.flagged)
    if (args.when !== undefined) {
      const ref = args.when.ref.getTime()
      const upcoming = args.when.kind === "upcoming"
      const byId = new Map(seededRows.map((s) => [s.record.id, s]))
      rows = rows.filter((r) => {
        const seeded = byId.get(r.id)
        if (seeded === undefined) return false
        const ended = seeded.endsAt.getTime() <= ref
        const cancelled = seeded.storedStatus === "cancelled"
        return upcoming ? !cancelled && !ended : ended || cancelled
      })
    }

    rows.sort((a, b) => {
      const primary = b.scheduledAt.getTime() - a.scheduledAt.getTime()
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    // The anchor is the row's scheduled_at (the list's sort key), carried in the cursor's createdAt slot
    // exactly as the Drizzle repo does.
    return pageInMemoryById(rows, args.cursor, args.limit, (r) => ({
      createdAt: r.scheduledAt,
      id: r.id,
    }))
  }

  async countByBucket(args: { q: string | null }): Promise<AdminEventCounts> {
    let rows = [...this.events.values()].map((s) => this.projected(s))
    if (args.q !== null) rows = rows.filter((r) => matchesQuery(r, args.q as string))
    let upcoming = 0
    let inProgress = 0
    let completed = 0
    let flagged = 0
    for (const r of rows) {
      if (r.status === "upcoming") upcoming += 1
      else if (r.status === "in_progress") inProgress += 1
      else if (r.status === "completed") completed += 1
      if (r.flagged) flagged += 1
    }
    return { all: rows.length, upcoming, in_progress: inProgress, completed, flagged }
  }

  async getEvent(id: string): Promise<AdminEventRecord | null> {
    const seeded = this.events.get(id)
    return seeded === undefined ? null : this.projected(seeded)
  }

  private derivedStatus(seeded: SeededEvent): EventStatus {
    return toEventStatus(
      deriveCleanupStatus(
        {
          status: seeded.storedStatus === "cancelled" ? "cancelled" : "upcoming",
          scheduledAt: seeded.record.scheduledAt.toISOString(),
          endsAt: seeded.endsAt.toISOString(),
        },
        Date.now(),
      ),
    )
  }

  private projected(seeded: SeededEvent): AdminEventRecord {
    seeded.record.status = this.derivedStatus(seeded)
    return seeded.record
  }

  async listTimeline(id: string): Promise<AdminEventTimelineRecord[]> {
    return [...(this.timeline.get(id) ?? [])]
  }

  async listMessages(id: string): Promise<AdminEventMessageRecord[]> {
    return [...(this.messages.get(id) ?? [])]
  }

  async setBags(id: string, input: { bags: number; actorId: string | null }): Promise<boolean> {
    const seeded = this.events.get(id)
    if (!seeded) return false
    seeded.record.bags = input.bags
    this.audits.push({
      action: "event.outcome_logged",
      target: `cleanup:${id}`,
      meta: { bags: input.bags },
    })
    return true
  }

  async toggleFlag(
    id: string,
    input: { reason: string | null; actorId: string | null },
  ): Promise<boolean | null> {
    const seeded = this.events.get(id)
    if (!seeded) return null
    const next = !seeded.record.flagged
    seeded.record.flagged = next
    this.appendTimeline(id, {
      kind: next ? "flag" : "unflag",
      note: next ? "Flagged for review" : "Flag cleared",
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: next ? "event.flagged" : "event.unflagged",
      target: `cleanup:${id}`,
      meta: { reason: input.reason },
    })
    return next
  }

  async cancel(id: string, input: { note: string; actorId: string | null }): Promise<boolean> {
    const seeded = this.events.get(id)
    if (!seeded) return false
    // Mirrors the Drizzle repo's `AND status <> 'cancelled'` guard: a repeat cancel must not append a
    // second public timeline row, but the event IS cancelled, so it is not a 404.
    if (seeded.storedStatus === "cancelled") return true
    seeded.storedStatus = "cancelled"
    seeded.record.status = "cancelled"
    this.appendTimeline(id, {
      kind: "cancel",
      note: input.note,
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: "event.cancelled",
      target: `cleanup:${id}`,
      meta: { note: input.note },
    })
    return true
  }

  async postMessage(
    id: string,
    input: { body: string; actorId: string },
  ): Promise<{ notified: number } | null> {
    const seeded = this.events.get(id)
    if (!seeded) return null
    const list = this.messages.get(id) ?? []
    list.push({ who: CIVFIX_OFFICIAL_DISPLAY_NAME, text: input.body, createdAt: this.nextDate() })
    this.messages.set(id, list)
    this.appendTimeline(id, {
      kind: "message",
      note: "Posted an update to attendees",
      who: "operator",
      createdAt: this.nextDate(),
    })
    // L4: fan out a notification per member in the same call (mirrors the Drizzle set-based in-tx insert).
    for (const member of seeded.members) {
      this.notifications.push({
        cleanupId: id,
        userId: member.userId,
        title: "Cleanup update",
        body: input.body,
        link: `/cleanups/${id}`,
      })
    }
    this.audits.push({
      action: "event.message_posted",
      target: `cleanup:${id}`,
      meta: { members: seeded.members.length, messageId: randomUUID() },
    })
    return { notified: seeded.members.length }
  }

  async loadLinkedReports(id: string): Promise<LinkedReportView[]> {
    const ordered = [...this.links]
      .filter((l) => l.cleanupId === id)
      .sort((a, b) => b.linkedAt.getTime() - a.linkedAt.getTime())
    const views: LinkedReportView[] = []
    for (const link of ordered) {
      const r = this.reports.get(link.reportId)
      if (!this.reportVisible(r)) continue
      views.push({
        cleanupId: id,
        id: r.id,
        category: r.category,
        title: r.title,
        status: r.status,
        lat: r.lat,
        lng: r.lng,
        addr: r.addr,
        thumbKey: r.thumbKey,
        linkedAt: link.linkedAt,
      })
    }
    return views
  }

  async linkReports(
    id: string,
    reportIds: string[],
    actorId: string | null,
  ): Promise<{ linked: string[] } | null> {
    if (!this.events.has(id)) return null
    const linked: string[] = []
    for (const reportId of reportIds) {
      // Only visible reports may be linked; a held/hidden/missing id is skipped (mirrors the SQL filter).
      if (!this.reportVisible(this.reports.get(reportId))) continue
      if (this.links.some((l) => l.cleanupId === id && l.reportId === reportId)) continue
      this.links.push({ cleanupId: id, reportId, linkedAt: this.nextDate() })
      this.appendTimeline(id, {
        kind: "report_linked",
        note: `Linked report ${reportId}`,
        who: "operator",
        createdAt: this.nextDate(),
      })
      linked.push(reportId)
    }
    this.audits.push({
      action: "event.reports_linked",
      target: `cleanup:${id}`,
      meta: { reportIds: linked },
    })
    void actorId
    return { linked }
  }

  async unlinkReport(
    id: string,
    reportId: string,
    actorId: string | null,
  ): Promise<boolean | null> {
    if (!this.events.has(id)) return null
    const idx = this.links.findIndex((l) => l.cleanupId === id && l.reportId === reportId)
    if (idx < 0) return false
    this.links.splice(idx, 1)
    this.appendTimeline(id, {
      kind: "report_unlinked",
      note: `Unlinked report ${reportId}`,
      who: "operator",
      createdAt: this.nextDate(),
    })
    this.audits.push({
      action: "event.report_unlinked",
      target: `cleanup:${id}`,
      meta: { reportId },
    })
    void actorId
    return true
  }

  private appendTimeline(id: string, row: AdminEventTimelineRecord): void {
    const list = this.timeline.get(id) ?? []
    list.push(row)
    this.timeline.set(id, list)
  }
}

/**
 * The search-needle filter shared by listEvents + countByBucket.
 *
 * MIRRORS searchEventsFragment (admin-event-sql.ts) COLUMN FOR COLUMN:
 *   `c.title ILIKE %q% OR c.address ILIKE %q% OR u.display_name ILIKE %q% OR u.handle ILIKE %q%`
 *   `OR c.id = $q::uuid` — the id branch only when q is a uuid.
 * The id was previously matched as a SUBSTRING, which SQL never does (an exact uuid equality), so an
 * id-prefix search passed offline and returned nothing in production. `place` and `address` are both
 * checked because the SQL projection reads ONE column into both (`c.address AS place, c.address`) while
 * the fake lets a test seed them separately — so whichever a test set is the address SQL would search.
 * The organizer HANDLE (`u.handle::text`) was missing entirely.
 */
function matchesQuery(record: AdminEventRecord, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    record.title.toLowerCase().includes(needle) ||
    record.place.toLowerCase().includes(needle) ||
    record.address.toLowerCase().includes(needle) ||
    (isUuid(q) && record.id.toLowerCase() === needle) ||
    (record.organizer?.name.toLowerCase().includes(needle) ?? false) ||
    (record.organizer?.handle?.toLowerCase().includes(needle) ?? false)
  )
}

/** Default seeded organizer (a claimed account with a verified email + oauth). */
function defaultOrganizer(): AdminOrganizerRecord {
  return {
    id: randomUUID(),
    name: "Olive Organizer",
    handle: "olive",
    emailVerified: true,
    hasOauth: false,
    joinedAt: new Date(Date.UTC(2025, 0, 1)),
  }
}
