import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import { assertTargetIsNotOperatorRole } from "../../auth/operator-target.js"
import {
  type CreateModerationItemInput,
  type ListModerationArgs,
  type ModerationItemRecord,
  type ModerationRepository,
} from "./moderation-service.js"

export interface SeededHeldReport {
  id: string
  category: ModerationItemRecord["category"]
  place: string | null
  reporter: string | null
  desc: string | null
  createdAt: Date
}

function isUserSubjectType(subjectType: ModerationItemRecord["subjectType"]): boolean {
  return subjectType === "user" || subjectType === "profile"
}

export class InMemoryModerationRepository implements ModerationRepository {
  readonly items = new Map<string, ModerationItemRecord>()
  readonly heldReports = new Map<string, SeededHeldReport>()
  readonly reportStatus = new Map<string, "published" | "rejected">()
  readonly suspensions = new Map<string, boolean>()
  readonly tombstoned = new Set<string>()
  readonly accountStatus = new Map<string, "active" | "suspended">()
  readonly userRoles = new Map<string, string>()
  readonly deletedUserIds = new Set<string>()

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  private directDestination(
    subjectType: ModerationItemRecord["subjectType"],
    subjectId: string,
  ): Pick<ModerationItemRecord, "destinationKind" | "destinationId"> {
    if (subjectType === "report") return { destinationKind: "report", destinationId: subjectId }
    if (subjectType === "event") return { destinationKind: "event", destinationId: subjectId }
    if (subjectType === "user" || subjectType === "profile") {
      return { destinationKind: "user", destinationId: subjectId }
    }
    return { destinationKind: null, destinationId: null }
  }

  seedItem(input: Partial<ModerationItemRecord> & { id?: string }): ModerationItemRecord {
    const id = input.id ?? randomUUID()
    const subjectType = input.subjectType ?? "report"
    const subjectId = input.subjectId ?? randomUUID()
    const destination = this.directDestination(subjectType, subjectId)
    const record: ModerationItemRecord = {
      id,
      kind: input.kind ?? "image",
      subjectType,
      subjectId,
      destinationKind:
        input.destinationKind === undefined ? destination.destinationKind : input.destinationKind,
      destinationId:
        input.destinationId === undefined ? destination.destinationId : input.destinationId,
      flag: input.flag ?? null,
      reason: input.reason ?? null,
      category: input.category ?? null,
      place: input.place ?? null,
      priority: input.priority ?? "med",
      autoAction: input.autoAction ?? null,
      reporter: input.reporter ?? null,
      reporterId: input.reporterId ?? null,
      desc: input.desc ?? null,
      status: input.status ?? "open",
      signals: input.signals ?? [],
      similar: input.similar ?? [],
      user: input.user ?? null,
      media: input.media ?? [],
      createdAt: input.createdAt ?? this.nextDate(),
    }
    this.items.set(id, record)
    return record
  }

  seedHeldReport(input: Partial<SeededHeldReport> & { id?: string }): SeededHeldReport {
    const id = input.id ?? randomUUID()
    const report: SeededHeldReport = {
      id,
      category: input.category ?? null,
      place: input.place ?? null,
      reporter: input.reporter ?? null,
      desc: input.desc ?? null,
      createdAt: input.createdAt ?? this.nextDate(),
    }
    this.heldReports.set(id, report)
    return report
  }

  async listOpen(
    args: ListModerationArgs,
  ): Promise<{ records: ModerationItemRecord[]; nextCursor: string | null }> {
    let rows = [...this.items.values()].filter((r) => r.status === "open")

    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          (r.flag ?? "").toLowerCase().includes(needle) ||
          (r.reporter ?? "").toLowerCase().includes(needle) ||
          (r.reason ?? "").toLowerCase().includes(needle),
      )
    }

    if (args.filter === "high") {
      rows = rows.filter((r) => r.priority === "high")
    } else if (args.filter !== "all") {
      rows = rows.filter((r) => r.kind === args.filter)
    }

    rows.sort((a, b) => {
      const primary = b.createdAt.getTime() - a.createdAt.getTime()
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    const limit = clampLimit(args.limit)
    const anchor = decodeCursor(args.cursor)
    const remaining =
      anchor === null
        ? rows
        : rows.filter((r) => {
            const d = r.createdAt.getTime() - anchor.createdAt.getTime()
            return d !== 0 ? d < 0 : r.id < anchor.id
          })
    const slice = remaining.slice(0, limit + 1)
    if (slice.length <= limit) {
      return { records: slice, nextCursor: null }
    }
    const records = slice.slice(0, limit)
    const last = records[records.length - 1]
    const nextCursor = last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
    return { records, nextCursor }
  }

  async getItem(id: string): Promise<ModerationItemRecord | null> {
    return this.items.get(id) ?? null
  }

  private resolve(
    id: string,
    status: "approved" | "removed" | "held",
  ): ModerationItemRecord | null {
    const item = this.items.get(id)
    if (!item || item.status !== "open") return null
    item.status = status
    return item
  }

  async approve(
    id: string,
    _input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null> {
    const item = this.resolve(id, "approved")
    if (!item) return null
    if (item.subjectType === "report" && !this.reportStatus.has(item.subjectId)) {
      this.reportStatus.set(item.subjectId, "published")
      item.reportTimelineStatus = "published"
    }
    return item
  }

  async remove(
    id: string,
    _input: { actorId: string | null; reason: string | null },
  ): Promise<ModerationItemRecord | null> {
    const pending = this.items.get(id)
    if (pending && isUserSubjectType(pending.subjectType)) {
      assertTargetIsNotOperatorRole(this.userRoles.get(pending.subjectId), "remove")
    }
    const item = this.resolve(id, "removed")
    if (!item) return null
    delete item.suspendedUserId
    if (item.subjectType === "report" && this.reportStatus.get(item.subjectId) !== "rejected") {
      this.reportStatus.set(item.subjectId, "rejected")
      item.reportTimelineStatus = "rejected"
    }
    if (item.subjectType === "chat" || item.subjectType === "message") {
      this.tombstoned.add(item.subjectId)
    }
    if (isUserSubjectType(item.subjectType)) {
      this.accountStatus.set(item.subjectId, "suspended")
      item.suspendedUserId = item.subjectId
    }
    return item
  }

  async hold(
    id: string,
    _input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null> {
    return this.resolve(id, "held")
  }

  async decideAppeal(
    id: string,
    input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null> {
    const item = this.items.get(id)
    if (!item || item.status !== "open" || item.kind !== "appeal") return null
    item.status = "approved"
    this.suspensions.set(item.subjectId, input.decision === "uphold")
    delete item.restoredUserId
    if (input.decision === "overturn" && this.restoreSubject(item.subjectType, item.subjectId)) {
      if (item.subjectType === "user" || item.subjectType === "profile") {
        item.restoredUserId = item.subjectId
      }
    }
    return item
  }

  private restoreSubject(
    subjectType: ModerationItemRecord["subjectType"],
    subjectId: string,
  ): boolean {
    if (subjectType === "chat" || subjectType === "message") {
      return this.tombstoned.delete(subjectId)
    }
    if (subjectType === "user" || subjectType === "profile") {
      if (this.deletedUserIds.has(subjectId)) return false
      this.accountStatus.set(subjectId, "active")
      return true
    }
    return false
  }

  async createItem(input: CreateModerationItemInput): Promise<string | null> {
    if (input.dedupeOpen) {
      for (const r of this.items.values()) {
        if (
          r.status === "open" &&
          r.subjectType === input.subjectType &&
          r.subjectId === input.subjectId
        ) {
          r.priority = "high"
          return null
        }
      }
    }
    const record = this.seedItem({
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      flag: input.flag ?? null,
      reason: input.reason ?? null,
      category: input.category ?? null,
      place: input.place ?? null,
      priority: input.priority ?? "med",
      autoAction: input.autoAction ?? null,
      reporter: input.reporter ?? null,
      reporterId: input.reporterUserId ?? null,
      desc: input.desc ?? null,
      status: "open",
      signals: input.signals ?? [],
      similar: input.similar ?? [],
      user: input.user ?? null,
    })
    return record.id
  }

  async backfillFromHeldReports(): Promise<number> {
    let created = 0
    for (const report of this.heldReports.values()) {
      const hasOpen = [...this.items.values()].some(
        (r) => r.status === "open" && r.subjectType === "report" && r.subjectId === report.id,
      )
      if (hasOpen) continue
      this.seedItem({
        kind: "image",
        subjectType: "report",
        subjectId: report.id,
        flag: "Held report",
        reason: "Awaiting automated review",
        category: report.category,
        place: report.place,
        reporter: report.reporter,
        desc: report.desc,
        priority: "med",
        autoAction: "Hidden pending review",
        status: "open",
        createdAt: report.createdAt,
      })
      created += 1
    }
    return created
  }
}
