/**
 * In-memory ModerationRepository (Phase 2): the offline binding of the moderation persistence seam.
 *
 * Mirrors the Drizzle impl's OBSERVABLE contract so the moderation service can be unit-tested with NO
 * database (no Docker), the same way InMemoryDiscoveryRepository backs the discovery tests:
 *   - listOpen pages only OPEN items, applying the search (flag/reporter/reason) + the kind/priority
 *     facet, newest-first by createdAt with an id tiebreak;
 *   - getItem returns the seeded record at any status;
 *   - approve/remove/hold/decideAppeal transition an OPEN item's status and record the underlying-effect
 *     intent on a paired "subject" map the tests can assert (published / rejected report status, lifted
 *     suspension), faithfully to what the Drizzle impl does in SQL;
 *   - createItem appends an item (honoring dedupeOpen against an existing OPEN item for the subject);
 *   - backfillFromHeldReports creates one item per seeded held report lacking an open item.
 * Seed/inspect helpers (seedItem, seedHeldReport, the public items/reportStatus/suspensions maps) let
 * tests arrange + assert state directly.
 */

import { randomUUID } from "node:crypto"
import { clampLimit, decodeCursor, encodeCursor } from "./pagination.js"
import {
  type CreateModerationItemInput,
  type ListModerationArgs,
  type ModerationItemRecord,
  type ModerationRepository,
} from "./moderation-service.js"

/** A held report seeded for the backfill test (the Drizzle impl reads these from the reports table). */
export interface SeededHeldReport {
  id: string
  category: ModerationItemRecord["category"]
  place: string | null
  reporter: string | null
  desc: string | null
  createdAt: Date
}

/** An in-memory ModerationRepository faithful to the Drizzle impl's observable behavior. */
export class InMemoryModerationRepository implements ModerationRepository {
  /** Seeded items keyed by id (insertion order preserved for stable paging). */
  readonly items = new Map<string, ModerationItemRecord>()
  /** Held reports seeded for the backfill, keyed by report id. */
  readonly heldReports = new Map<string, SeededHeldReport>()
  /** Observable report status after an action (reportId -> 'published' | 'rejected'). */
  readonly reportStatus = new Map<string, "published" | "rejected">()
  /** Observable chat suspension state after an appeal (chatSubjectId -> active?). */
  readonly suspensions = new Map<string, boolean>()

  /** Deterministic clock; each created item advances by one millisecond for stable ordering. */
  now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))
  private tick = 0

  private nextDate(): Date {
    this.tick += 1
    return new Date(this.now.getTime() + this.tick)
  }

  /** Seed an item. Defaults fill the shaping fields so a test only sets what it asserts on. */
  seedItem(input: Partial<ModerationItemRecord> & { id?: string }): ModerationItemRecord {
    const id = input.id ?? randomUUID()
    const record: ModerationItemRecord = {
      id,
      kind: input.kind ?? "image",
      subjectType: input.subjectType ?? "report",
      subjectId: input.subjectId ?? randomUUID(),
      flag: input.flag ?? null,
      reason: input.reason ?? null,
      category: input.category ?? null,
      place: input.place ?? null,
      priority: input.priority ?? "med",
      autoAction: input.autoAction ?? null,
      reporter: input.reporter ?? null,
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

  /** Seed a held report for the backfill test. */
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

    // Search: flag OR reporter OR reason, case-insensitive.
    if (args.q !== null) {
      const needle = args.q.toLowerCase()
      rows = rows.filter(
        (r) =>
          (r.flag ?? "").toLowerCase().includes(needle) ||
          (r.reporter ?? "").toLowerCase().includes(needle) ||
          (r.reason ?? "").toLowerCase().includes(needle),
      )
    }

    // Facet: a kind narrows by kind; "high" narrows by priority; "all" keeps everything.
    if (args.filter === "high") {
      rows = rows.filter((r) => r.priority === "high")
    } else if (args.filter !== "all") {
      rows = rows.filter((r) => r.kind === args.filter)
    }

    // Newest-first by createdAt; id is the stable tiebreak (desc) so the keyset cursor pages
    // deterministically.
    rows.sort((a, b) => {
      const primary = b.createdAt.getTime() - a.createdAt.getTime()
      if (primary !== 0) return primary
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })

    const limit = clampLimit(args.limit)
    const anchor = decodeCursor(args.cursor)
    let start = 0
    if (anchor) {
      const idx = rows.findIndex((r) => r.id === anchor.id)
      start = idx >= 0 ? idx + 1 : rows.length
    }
    const slice = rows.slice(start, start + limit + 1)
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

  /** Shared transition: only an OPEN item resolves; records the resolved status + clears it from open. */
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
    // Underlying effect: publish the held report subject.
    if (item.subjectType === "report") {
      this.reportStatus.set(item.subjectId, "published")
      // D-D1: signal the report-chat mirror (a report subject transitions to published on approve).
      item.reportTimelineStatus = "published"
    }
    return item
  }

  async remove(
    id: string,
    _input: { actorId: string | null; reason: string | null },
  ): Promise<ModerationItemRecord | null> {
    const item = this.resolve(id, "removed")
    if (!item) return null
    // Underlying effect: reject the report subject.
    if (item.subjectType === "report") {
      this.reportStatus.set(item.subjectId, "rejected")
      // D-D1: signal the report-chat mirror (a report subject is tombstoned on remove).
      item.reportTimelineStatus = "rejected"
    }
    return item
  }

  async hold(
    id: string,
    _input: { actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null> {
    // Hold extends the hold: the item leaves the OPEN queue but the report is neither published nor
    // rejected (no reportStatus change).
    return this.resolve(id, "held")
  }

  async decideAppeal(
    id: string,
    input: { decision: "uphold" | "overturn"; actorId: string | null; note: string | null },
  ): Promise<ModerationItemRecord | null> {
    const item = this.items.get(id)
    if (!item || item.status !== "open" || item.kind !== "appeal") return null
    item.status = "approved"
    // overturn lifts the suspension (suspension no longer active); uphold keeps it active.
    this.suspensions.set(item.subjectId, input.decision === "uphold")
    return item
  }

  async createItem(input: CreateModerationItemInput): Promise<string | null> {
    if (input.dedupeOpen) {
      for (const r of this.items.values()) {
        if (
          r.status === "open" &&
          r.subjectType === input.subjectType &&
          r.subjectId === input.subjectId
        ) {
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
