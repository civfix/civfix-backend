import { randomUUID } from "node:crypto"
import { avatarGradient } from "@civfix/shared"
import type {
  LeaderboardEntryDTO,
  MyVolunteerHoursDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import { encodeTimeCursor, pageWith } from "../db/cursor-helpers.js"
import { ITEMISED_SOURCES } from "./volunteer-hours-service.js"
import type {
  CertificateEntriesPage,
  EntriesForCertificateArgs,
  EventHoursLedger,
  HoursVisibility,
  LeaderboardPage,
  ListEntriesArgs,
  LogEventHoursArgs,
  LogEventHoursResult,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
} from "./volunteer-hours-service.js"

export interface MemoryLeaderboardUser {
  name: string
  handle: string | null
  avatarUrl: string | null
  verified: boolean
  showVolunteerHours?: boolean | null
  deleted?: boolean
}

export interface MemoryCleanupMeta {
  title: string | null
  referenceCode: string | null
  scheduledAt: Date | null
}

interface LedgerEntry {
  id: string
  userId: string
  source: VolunteerHoursSource
  hours: number
  createdAt: Date
  cleanupId: string | null
  reportId: string | null
  geoid: string | null
  loggedByUserId: string | null
  voidedAt?: Date
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface InMemoryVolunteerHoursRepositoryOpts {
  now?: () => Date
  newId?: () => string
}

export class InMemoryVolunteerHoursRepository implements VolunteerHoursRepository {
  private readonly eventLedger = new Map<string, { hours: number; geoid: string | null }>()
  private readonly rollup = new Map<string, number>()
  private readonly users = new Map<string, MemoryLeaderboardUser>()
  private readonly jurisdictionNames = new Map<string, string>()
  private readonly cleanups = new Map<string, MemoryCleanupMeta>()
  private readonly entries: LedgerEntry[] = []
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(opts?: InMemoryVolunteerHoursRepositoryOpts) {
    this.now = opts?.now ?? (() => new Date())
    this.newId = opts?.newId ?? (() => randomUUID())
  }

  seedUser(userId: string, user: MemoryLeaderboardUser): void {
    this.users.set(userId, user)
  }

  seedJurisdiction(geoid: string, name: string): void {
    this.jurisdictionNames.set(geoid, name)
  }

  seedCleanup(cleanupId: string, meta: MemoryCleanupMeta): void {
    this.cleanups.set(cleanupId, meta)
  }

  voidEntry(entryId: string): void {
    const row = this.entries.find((e) => e.id === entryId)
    if (row) row.voidedAt = this.now()
  }

  seedLegacyReportEntry(userId: string, reportId: string, geoid: string | null, hours = 0.1): string {
    const id = this.newId()
    this.entries.push({
      id,
      userId,
      source: "report",
      hours,
      createdAt: this.now(),
      cleanupId: null,
      reportId,
      geoid,
      loggedByUserId: null,
    })
    if (geoid !== null) this.addRollup(userId, geoid, hours)
    return id
  }

  logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult> {
    const changed: LogEventHoursResult["changed"] = []
    for (const entry of args.entries) {
      const key = `${args.cleanupId}|${entry.userId}`
      const previous = this.eventLedger.get(key) ?? null
      changed.push({
        userId: entry.userId,
        hours: entry.hours,
        previousHours: previous === null ? null : previous.hours,
      })
      this.eventLedger.set(key, { hours: entry.hours, geoid: args.geoid })
      if (previous !== null && previous.geoid !== null && previous.geoid !== args.geoid) {
        this.addRollup(entry.userId, previous.geoid, -previous.hours)
      }
      if (args.geoid !== null) {
        const priorHere = previous !== null && previous.geoid === args.geoid ? previous.hours : 0
        this.addRollup(entry.userId, args.geoid, entry.hours - priorHere)
      }
      const existing = this.entries.find(
        (e) => e.source === "event" && e.cleanupId === args.cleanupId && e.userId === entry.userId,
      )
      if (existing !== undefined) {
        existing.hours = entry.hours
        existing.geoid = args.geoid
        existing.loggedByUserId = args.actorId
      } else {
        this.entries.push({
          id: this.newId(),
          userId: entry.userId,
          source: "event",
          hours: entry.hours,
          createdAt: this.now(),
          cleanupId: args.cleanupId,
          reportId: null,
          geoid: args.geoid,
          loggedByUserId: args.actorId,
        })
      }
    }
    return Promise.resolve({ credited: args.entries.length, changed })
  }

  totalsFor(userId: string): Promise<MyVolunteerHoursDTO> {
    const byJurisdiction: MyVolunteerHoursDTO["byJurisdiction"] = []
    for (const [key, total] of this.rollup) {
      const parsed = this.parseKey(key)
      if (parsed.userId !== userId || total <= 0) continue
      byJurisdiction.push({
        geoid: parsed.geoid,
        name: this.jurisdictionNames.get(parsed.geoid) ?? null,
        hours: round2(total),
      })
    }
    byJurisdiction.sort((a, b) => b.hours - a.hours || a.geoid.localeCompare(b.geoid))
    return Promise.resolve({ totalHours: this.computeTotalHours(userId), byJurisdiction })
  }

  totalHoursFor(userId: string): Promise<number> {
    return Promise.resolve(this.computeTotalHours(userId))
  }

  private computeTotalHours(userId: string): number {
    let total = 0
    for (const [key, value] of this.rollup) {
      if (this.parseKey(key).userId === userId && value > 0) total += value
    }
    for (const e of this.entries) {
      if (
        e.userId === userId &&
        e.voidedAt === undefined &&
        e.source !== "report" &&
        e.geoid === null
      ) {
        total += e.hours
      }
    }
    return round2(total)
  }

  leaderboard(
    geoid: string,
    limit: number,
    offset: number,
    viewerId: string | null,
    withExtras: boolean,
  ): Promise<LeaderboardPage> {
    const ranked: { userId: string; hours: number }[] = []
    for (const [key, total] of this.rollup) {
      const parsed = this.parseKey(key)
      if (parsed.geoid !== geoid || total <= 0) continue
      if (!this.aggregateVisible(parsed.userId)) continue
      ranked.push({ userId: parsed.userId, hours: total })
    }
    ranked.sort((a, b) => b.hours - a.hours || a.userId.localeCompare(b.userId))

    const window = ranked.slice(offset, offset + limit + 1)
    const hasMore = window.length > limit
    const page = hasMore ? window.slice(0, limit) : window
    const entries: LeaderboardEntryDTO[] = page.map((row, i) => {
      const user = this.users.get(row.userId)
      return {
        rank: offset + i + 1,
        userId: row.userId,
        name: user?.name ?? "",
        ...(user?.handle != null ? { handle: user.handle } : {}),
        avatar: avatarGradient(row.userId),
        ...(user?.avatarUrl != null ? { avatarUrl: user.avatarUrl } : {}),
        verified: user?.verified ?? false,
        hours: round2(row.hours),
      }
    })

    const meIndex = viewerId === null ? -1 : ranked.findIndex((r) => r.userId === viewerId)
    return Promise.resolve({
      jurisdictionName: this.jurisdictionNames.get(geoid) ?? null,
      entries,
      nextOffset: hasMore ? offset + limit : null,
      participantCount: withExtras && offset === 0 ? ranked.length : null,
      viewerRank: withExtras && meIndex >= 0 ? meIndex + 1 : null,
      viewerHours: withExtras && meIndex >= 0 ? round2(ranked[meIndex]!.hours) : null,
    })
  }

  listEntries(
    args: ListEntriesArgs,
  ): Promise<{ items: VolunteerHoursEntryView[]; nextCursor: string | null }> {
    const sources = args.sources ?? ITEMISED_SOURCES
    const rows = this.entries
      .filter(
        (e) => e.userId === args.userId && e.voidedAt === undefined && sources.includes(e.source),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .filter((e) => {
        if (args.cursor === null) return true
        const at = e.createdAt.getTime()
        const anchor = args.cursor.at.getTime()
        return at < anchor || (at === anchor && e.id < args.cursor.id)
      })
      .slice(0, args.limit + 1)

    const { items, nextCursor } = pageWith(rows, args.limit, (last) =>
      encodeTimeCursor({ at: last.createdAt, id: last.id }),
    )
    return Promise.resolve({ items: items.map((e) => this.toView(e)), nextCursor })
  }

  listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger> {
    const all = this.entries.filter(
      (e) => e.source === "event" && e.cleanupId === cleanupId && e.voidedAt === undefined,
    )
    const rows = viewerId === null ? all : all.filter((e) => e.userId === viewerId)
    return Promise.resolve({
      entries: rows
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .map((e) => ({ userId: e.userId, hours: round2(e.hours), loggedAt: e.createdAt })),
      anyLogged: all.length > 0,
    })
  }

  hoursVisibilityFor(userId: string): Promise<HoursVisibility> {
    const user = this.users.get(userId)
    if (user?.deleted === true) return Promise.resolve({ aggregate: false, items: false })
    const flag = user?.showVolunteerHours ?? null
    return Promise.resolve({ aggregate: flag !== false, items: flag === true })
  }

  entriesForCertificate(args: EntriesForCertificateArgs): Promise<CertificateEntriesPage> {
    const matching = this.entries
      .filter(
        (e) =>
          e.userId === args.userId &&
          e.voidedAt === undefined &&
          e.source !== "report" &&
          (args.geoid === null || e.geoid === args.geoid) &&
          (args.from === null || e.createdAt.getTime() >= args.from.getTime()) &&
          (args.to === null || e.createdAt.getTime() <= args.to.getTime()),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    const items = matching
      .slice(Math.max(0, matching.length - args.limit))
      .map((e) => this.toView(e))
    return Promise.resolve({
      items,
      totalHours: round2(items.reduce((sum, r) => sum + r.hours, 0)),
      entryCount: matching.length,
    })
  }

  private aggregateVisible(userId: string): boolean {
    const user = this.users.get(userId)
    if (user?.deleted === true) return false
    return (user?.showVolunteerHours ?? null) !== false
  }

  private toView(e: LedgerEntry): VolunteerHoursEntryView {
    const meta = e.cleanupId !== null ? (this.cleanups.get(e.cleanupId) ?? null) : null
    const creditor = e.loggedByUserId !== null ? (this.users.get(e.loggedByUserId) ?? null) : null
    return {
      id: e.id,
      source: e.source,
      hours: round2(e.hours),
      createdAt: e.createdAt,
      occurredAt: meta?.scheduledAt ?? e.createdAt,
      cleanupId: e.cleanupId,
      cleanupTitle: meta?.title ?? null,
      cleanupReferenceCode: meta?.referenceCode ?? null,
      reportId: e.reportId,
      jurisdictionGeoid: e.geoid,
      jurisdictionName: e.geoid !== null ? (this.jurisdictionNames.get(e.geoid) ?? null) : null,
      creditedBy:
        e.loggedByUserId !== null
          ? {
              id: e.loggedByUserId,
              name: creditor?.name ?? "",
              handle: creditor?.handle ?? null,
              verified: creditor?.verified ?? false,
            }
          : null,
    }
  }

  private addRollup(userId: string, geoid: string, delta: number): void {
    const key = `${userId}|${geoid}`
    this.rollup.set(key, (this.rollup.get(key) ?? 0) + delta)
  }

  private parseKey(key: string): { userId: string; geoid: string } {
    const sep = key.indexOf("|")
    return { userId: key.slice(0, sep), geoid: key.slice(sep + 1) }
  }
}
