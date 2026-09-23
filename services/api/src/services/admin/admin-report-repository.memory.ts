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
  ReportOutreachState,
} from "./admin-report-service.js"
import type {
  AdminReportCounts,
  AdminReportStatus,
  ReportCategory,
  ReportTimelineItem,
  ReportVisibility,
} from "@civfix/shared"
import { mapOutreachStatus } from "./admin-report-repository.drizzle.js"
import { isPacketKind, type MailMessageKind } from "./mail-repository.js"
import { pickPreviewMedia, REPORT_VERIFIED_THRESHOLD } from "./admin-report-service.js"
import { STATUS_BUCKETS } from "./admin-report-status.js"

export interface RecordedAudit {
  action: string
  target: string
  meta: Record<string, unknown>
  actorId?: string | null
}

export interface SeededOutreach {
  threadId: string | null
  threadStatus: string | null
  hasInbound: boolean
  routedTo: string | null
  routedAt: Date | null
  packetSent: boolean
  outboundKinds?: (MailMessageKind | null)[]
  sendFailed: boolean
  sendInFlight?: boolean
}

export interface SeededReport {
  record: AdminReportRecord
  routing: AdminReportRoutingRecord | null
  media: AdminReportMediaRecord[]
  outreach: SeededOutreach
  deletedAt: Date | null
}

export class InMemoryAdminReportRepository implements AdminReportRepository {
  readonly reports = new Map<string, SeededReport>()
  readonly timeline = new Map<string, AdminReportTimelineRecord[]>()
  readonly audits: RecordedAudit[] = []
  readonly reporterReportVerified = new Map<string, boolean>()

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  seedReport(input: {
    id?: string
    category?: ReportCategory
    status?: AdminReportStatus
    visibility?: ReportVisibility
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
    deletedAt?: Date | null
  }): SeededReport {
    const id = input.id ?? randomUUID()
    const seeded: SeededReport = {
      record: {
        id,
        category: input.category ?? "other",
        status: input.status ?? "submitted",
        visibility: input.visibility ?? "public",
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
        previewMedia: pickPreviewMedia(input.media ?? []),
        createdAt: input.createdAt ?? this.now,
        referenceCode: input.referenceCode ?? null,
        verificationVerdict: input.verificationVerdict ?? null,
        verifiedAt: input.verifiedAt ?? null,
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
        packetSent:
          input.outreach?.packetSent ??
          (input.outreach?.outboundKinds !== undefined
            ? input.outreach.outboundKinds.some(isPacketKind)
            : input.outreach?.threadStatus != null),
        sendFailed: input.outreach?.sendFailed ?? false,
        sendInFlight: input.outreach?.sendInFlight ?? false,
      },
      deletedAt: input.deletedAt ?? null,
    }
    this.reports.set(id, seeded)
    if (input.timeline) this.timeline.set(id, [...input.timeline])
    const reporterId = seeded.record.reporter?.id
    if (reporterId && reporterId !== "" && input.reporterReportVerified != null) {
      this.reporterReportVerified.set(reporterId, input.reporterReportVerified)
    }
    return seeded
  }

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
    let rows = [...this.reports.values()]
      .filter((s) => s.deletedAt === null)
      .map((s) => this.projectRecord(s.record))

    if (args.q !== null) rows = rows.filter((r) => matchesSearch(r, args.q as string))
    if (args.statuses !== null && args.statuses.length > 0) {
      const set = new Set(args.statuses)
      rows = rows.filter((r) => set.has(r.status))
    }
    if (args.flaggedOnly) rows = rows.filter((r) => r.flagged)
    if (args.needsVerificationOnly) rows = rows.filter((r) => r.verificationVerdict === null)

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
    let rows = [...this.reports.values()].filter((s) => s.deletedAt === null).map((s) => s.record)
    if (args.q !== null) rows = rows.filter((r) => matchesSearch(r, args.q as string))
    const submittedSet = new Set<AdminReportStatus>(STATUS_BUCKETS.submitted)
    const inProgressSet = new Set<AdminReportStatus>(STATUS_BUCKETS.in_progress)
    const completedSet = new Set<AdminReportStatus>(STATUS_BUCKETS.completed)
    let submitted = 0
    let inProgress = 0
    let completed = 0
    let flagged = 0
    let needsVerification = 0
    for (const r of rows) {
      if (submittedSet.has(r.status)) submitted += 1
      else if (inProgressSet.has(r.status)) inProgress += 1
      else if (completedSet.has(r.status)) completed += 1
      if (r.flagged) flagged += 1
      if (submittedSet.has(r.status) && r.verificationVerdict === null) needsVerification += 1
    }
    return {
      all: submitted + inProgress + completed,
      submitted,
      in_progress: inProgress,
      completed,
      flagged,
      needsVerification,
    }
  }

  async getReport(id: string): Promise<AdminReportRecord | null> {
    const seeded = this.reports.get(id)
    if (!seeded || seeded.deletedAt !== null) return null
    return this.projectRecord(seeded.record)
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
      return {
        status: "not_sent",
        threadId: null,
        routedTo: null,
        routedAt: null,
        packetSent: false,
        sendFailed: false,
      }
    }
    return {
      status: mapOutreachStatus(o.threadStatus, o.hasInbound),
      threadId: o.threadId,
      routedTo: o.routedTo,
      routedAt: o.routedAt ? o.routedAt.toISOString() : null,
      packetSent: o.packetSent,
      sendFailed: o.sendFailed,
      sendInFlight: o.sendInFlight ?? false,
    }
  }

  async advanceStatusIfIn(
    id: string,
    input: {
      from: readonly AdminReportStatus[]
      to: AdminReportStatus
      note: string
      actorId: string | null
      kind?: ReportTimelineItem["kind"]
    },
  ): Promise<boolean> {
    const seeded = this.reports.get(id)
    if (!seeded) return false
    if (!input.from.includes(seeded.record.status)) return false
    seeded.record.status = input.to
    this.appendTimeline(id, {
      status: input.to,
      note: input.note,
      kind: input.kind ?? null,
      who: input.actorId === null ? "system" : input.actorId,
      createdAt: this.nextDate(),
    })
    this.audits.push({
      actorId: input.actorId,
      action: "report.status_changed",
      target: `report:${id}`,
      meta: { status: input.to },
    })
    return true
  }

  async appendSystemTimeline(
    id: string,
    input: { note: string; kind: ReportTimelineItem["kind"]; body?: string | null },
  ): Promise<void> {
    const seeded = this.reports.get(id)
    if (!seeded) return
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
    if (!seeded || seeded.deletedAt !== null) return false
    void input.body
    seeded.record.status = input.status
    if (input.status === "rejected") seeded.deletedAt = seeded.deletedAt ?? this.nextDate()
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
    if (!seeded || seeded.deletedAt !== null) return null
    const next = !seeded.record.flagged
    seeded.record.flagged = next
    this.appendTimeline(id, {
      status: seeded.record.status,
      note: next ? "Flagged for review" : "Flag cleared",
      kind: "warn",
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
    if (!seeded || seeded.deletedAt !== null) return false
    seeded.record.status = "rejected"
    seeded.deletedAt = this.nextDate()
    this.appendTimeline(id, {
      status: "rejected",
      note: input.note,
      kind: "remove",
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
      kind: "followup",
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
    if (!seeded || seeded.deletedAt !== null) return false
    seeded.record.verificationVerdict = input.verdict
    seeded.record.verifiedAt = this.nextDate()
    this.audits.push({
      action: "report.verdict_set",
      target: `report:${id}`,
      meta: { verdict: input.verdict },
    })

    const reporterId = seeded.record.reporter?.id
    if (input.verdict !== "approved" || !reporterId || reporterId === "") return true

    const approvedCount = [...this.reports.values()].filter(
      (s) =>
        s.record.reporter?.id === reporterId &&
        s.record.verificationVerdict === "approved" &&
        s.deletedAt === null,
    ).length
    if (
      approvedCount >= REPORT_VERIFIED_THRESHOLD &&
      this.reporterReportVerified.get(reporterId) !== true
    ) {
      this.reporterReportVerified.set(reporterId, true)
    }
    return true
  }

  private readonly routeChain = new Map<string, Promise<void>>()

  async withRouteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.routeChain.get(id) ?? Promise.resolve()
    let unlock: () => void = () => {}
    const mine = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const tail = prev.then(() => mine)
    this.routeChain.set(id, tail)
    await prev
    try {
      return await fn()
    } finally {
      unlock()
      if (this.routeChain.get(id) === tail) this.routeChain.delete(id)
    }
  }

  private appendTimeline(id: string, row: AdminReportTimelineRecord): void {
    const list = this.timeline.get(id) ?? []
    list.push(row)
    this.timeline.set(id, list)
  }
}

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

function matchesSearch(record: AdminReportRecord, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    record.title.toLowerCase().includes(needle) ||
    record.place.toLowerCase().includes(needle) ||
    record.address.toLowerCase().includes(needle) ||
    record.referenceCode === q.trim().toUpperCase() ||
    (isUuid(q) && record.id.toLowerCase() === needle) ||
    (record.reporter?.name.toLowerCase().includes(needle) ?? false) ||
    (record.reporter?.handle?.toLowerCase().includes(needle) ?? false)
  )
}
