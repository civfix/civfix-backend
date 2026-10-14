import { randomUUID } from "node:crypto"
import { clampLimit } from "../../../src/services/admin/pagination.js"
import { pageBeforeTimeCursor, parseKeysetCursor } from "../../../src/db/cursor-helpers.js"
import {
  assertTargetIsNotOfficialAccount,
  assertTargetIsNotOperatorRole,
} from "../../../src/auth/operator-target.js"
import { isMessageSubject, isUserSubject } from "../../../src/services/admin/moderation-service.js"
import type {
  CreateModerationItemInput,
  ListModerationArgs,
  ModerationItemRecord,
  ModerationRepository,
} from "../../../src/services/admin/moderation-repository.js"

export interface SeededHeldReport {
  id: string
  category: ModerationItemRecord["category"]
  place: string | null
  reporter: string | null
  desc: string | null
  createdAt: Date
}

const DEFAULT_ITEM_PRIORITY = "med"

function directDestination(
  subjectType: ModerationItemRecord["subjectType"],
  subjectId: string,
): Pick<ModerationItemRecord, "destinationKind" | "destinationId"> {
  if (subjectType === "report") return { destinationKind: "report", destinationId: subjectId }
  if (subjectType === "event") return { destinationKind: "event", destinationId: subjectId }
  if (isUserSubject(subjectType)) return { destinationKind: "user", destinationId: subjectId }
  return { destinationKind: null, destinationId: null }
}

export class InMemoryModerationRepository implements ModerationRepository {
  readonly items = new Map<string, ModerationItemRecord>()
  readonly heldReports = new Map<string, SeededHeldReport>()
  readonly reportStatus = new Map<string, "published" | "rejected">()
  readonly suspensions = new Map<string, boolean>()
  readonly tombstoned = new Set<string>()
  readonly accountStatus = new Map<string, "active" | "suspended" | "banned">()
  readonly userRoles = new Map<string, string>()
  readonly deletedUserIds = new Set<string>()

  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  seedItem(input: Partial<ModerationItemRecord> & { id?: string }): ModerationItemRecord {
    const id = input.id ?? randomUUID()
    const subjectType = input.subjectType ?? "report"
    const subjectId = input.subjectId ?? randomUUID()
    const destination = directDestination(subjectType, subjectId)
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
      priority: input.priority ?? DEFAULT_ITEM_PRIORITY,
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
    const anchor = parseKeysetCursor(args.cursor, { requireUuid: false })
    const { items: records, nextCursor } = pageBeforeTimeCursor(rows, anchor, limit, (r) => ({
      at: r.createdAt,
      id: r.id,
    }))
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
    if (pending && isUserSubject(pending.subjectType)) {
      assertTargetIsNotOfficialAccount(pending.subjectId, "remove")
      assertTargetIsNotOperatorRole(this.userRoles.get(pending.subjectId), "remove")
    }
    const item = this.resolve(id, "removed")
    if (!item) return null
    delete item.suspendedUserId
    if (item.subjectType === "report" && this.reportStatus.get(item.subjectId) !== "rejected") {
      this.reportStatus.set(item.subjectId, "rejected")
      item.reportTimelineStatus = "rejected"
    }
    if (isMessageSubject(item.subjectType)) this.tombstoned.add(item.subjectId)
    if (isUserSubject(item.subjectType) && this.accountStatus.get(item.subjectId) !== "banned") {
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
    const restored =
      input.decision === "overturn" && this.restoreSubject(item.subjectType, item.subjectId)
    if (restored && isUserSubject(item.subjectType)) item.restoredUserId = item.subjectId
    return item
  }

  private restoreSubject(
    subjectType: ModerationItemRecord["subjectType"],
    subjectId: string,
  ): boolean {
    if (isMessageSubject(subjectType)) return this.tombstoned.delete(subjectId)
    if (isUserSubject(subjectType)) {
      if (this.deletedUserIds.has(subjectId)) return false
      if (this.accountStatus.get(subjectId) !== "suspended") return false
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
      priority: input.priority ?? DEFAULT_ITEM_PRIORITY,
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
