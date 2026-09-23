import { randomUUID } from "node:crypto"
import { AppError, avatarGradient } from "@civfix/shared"
import type {
  LeaderboardEntryDTO,
  MyVolunteerHoursDTO,
  OrganizationRefDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import { encodeTimeCursor, isBeforeTimeCursor, pageWith } from "../db/cursor-helpers.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./host/event-fields.js"
import { eventDayKey } from "./host/event-day.js"
import {
  DAILY_HOURS_CAP,
  ITEMISED_SOURCES,
  MAX_ORG_CHIPS_FETCH,
  RECIPROCAL_LOOKBACK_MS,
  WEEKLY_HOURS_FLAG_DEFAULT,
} from "./volunteer-hours-service.js"
import type {
  CertificateEntriesPage,
  EntriesForCertificateArgs,
  EventHoursLedger,
  HoursVisibility,
  LeaderboardPage,
  ListEntriesArgs,
  LogEventHoursArgs,
  LogEventHoursResult,
  MyVolunteerHoursTotals,
  OrgHoursView,
  VolunteerHoursAnomaly,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
} from "./volunteer-hours-repository.js"
import { MS_PER_WEEK } from "../lib/time.js"

export interface MemoryLeaderboardUser {
  name: string
  handle: string | null
  avatarUrl: string | null
  organization?: OrganizationRefDTO | null
  showVolunteerHours?: boolean | null
  deleted?: boolean
}

export interface MemoryCleanupMeta {
  title: string | null
  referenceCode: string | null
  scheduledAt: Date | null
  timezone?: string | null
  organizationId?: string | null
}

export interface MemoryOrganization {
  id: string
  slug: string
  name: string
  logoKey?: string | null
  verified?: boolean
  verifiedKind?: OrganizationRefDTO["verifiedKind"]
  deleted?: boolean
  suspended?: boolean
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

const HOURS_ROUNDING_FACTOR = 100

const DEFAULT_LEGACY_REPORT_HOURS = 0.1

function round2(n: number): number {
  return Math.round(n * HOURS_ROUNDING_FACTOR) / HOURS_ROUNDING_FACTOR
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
  private readonly organizations = new Map<string, MemoryOrganization>()
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

  seedOrganization(org: MemoryOrganization): void {
    this.organizations.set(org.id, org)
  }

  voidEntry(entryId: string): void {
    const row = this.entries.find((e) => e.id === entryId)
    if (row) row.voidedAt = this.now()
  }

  seedLegacyReportEntry(
    userId: string,
    reportId: string,
    geoid: string | null,
    hours = DEFAULT_LEGACY_REPORT_HOURS,
  ): string {
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
    this.assertNoReciprocalCredit(args)
    this.assertDailyCap(args)
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
    return Promise.resolve({
      credited: args.entries.length,
      changed,
      anomalies: this.detectAnomalies(args),
    })
  }

  private assertNoReciprocalCredit(args: LogEventHoursArgs): void {
    const creditedTheActor = new Set(
      this.entries
        .filter(
          (e) =>
            e.source === "event" &&
            e.cleanupId === args.cleanupId &&
            e.userId === args.actorId &&
            e.voidedAt === undefined &&
            e.loggedByUserId !== null &&
            e.loggedByUserId !== args.actorId,
        )
        .map((e) => e.loggedByUserId as string),
    )
    if (args.entries.some((entry) => creditedTheActor.has(entry.userId))) {
      throw AppError.conflict(
        "You can't credit hours to someone who has already credited you for this event.",
      )
    }
  }

  private assertDailyCap(args: LogEventHoursArgs): void {
    const day = this.eventDay(args.cleanupId)
    if (day === null) return
    const dailyCapHours = args.dailyCapHours ?? DAILY_HOURS_CAP
    for (const entry of args.entries) {
      const held = this.entries
        .filter(
          (e) =>
            e.source === "event" &&
            e.userId === entry.userId &&
            e.voidedAt === undefined &&
            e.cleanupId !== null &&
            e.cleanupId !== args.cleanupId &&
            this.eventDay(e.cleanupId) === day,
        )
        .reduce((sum, e) => sum + e.hours, 0)
      if (held + entry.hours > dailyCapHours) {
        throw AppError.conflict(
          `That attendee already holds ${round2(held)} h for events on this date; the daily limit is ${dailyCapHours} h.`,
        )
      }
    }
  }

  private eventDay(cleanupId: string): string | null {
    const meta = this.cleanups.get(cleanupId) ?? null
    if (meta === null || meta.scheduledAt === null) return null
    return eventDayKey(meta.scheduledAt, meta.timezone ?? DEFAULT_EVENT_TIME_ZONE)
  }

  private detectAnomalies(args: LogEventHoursArgs): VolunteerHoursAnomaly[] {
    const anomalies: VolunteerHoursAnomaly[] = []
    const weeklyFlagHours = args.weeklyFlagHours ?? WEEKLY_HOURS_FLAG_DEFAULT
    const nowMs = this.now().getTime()
    for (const entry of args.entries) {
      const weekly = this.entries
        .filter(
          (e) =>
            e.userId === entry.userId &&
            e.source !== "report" &&
            e.voidedAt === undefined &&
            nowMs - e.createdAt.getTime() <= MS_PER_WEEK,
        )
        .reduce((sum, e) => sum + e.hours, 0)
      if (weekly > weeklyFlagHours) {
        anomalies.push({
          kind: "weekly_hours",
          userId: entry.userId,
          counterpartUserId: null,
          hours: round2(weekly),
        })
      }
    }
    const creditedTheActorElsewhere = new Set(
      this.entries
        .filter(
          (e) =>
            e.source === "event" &&
            e.userId === args.actorId &&
            e.voidedAt === undefined &&
            e.cleanupId !== null &&
            e.cleanupId !== args.cleanupId &&
            e.loggedByUserId !== null &&
            nowMs - e.createdAt.getTime() <= RECIPROCAL_LOOKBACK_MS,
        )
        .map((e) => e.loggedByUserId as string),
    )
    for (const entry of args.entries) {
      if (creditedTheActorElsewhere.has(entry.userId)) {
        anomalies.push({
          kind: "reciprocal_credit",
          userId: entry.userId,
          counterpartUserId: args.actorId,
          hours: null,
        })
      }
    }
    return anomalies
  }

  private organizationHoursFor(userId: string): OrgHoursView[] {
    const hoursByOrg = new Map<string, number>()
    for (const entry of this.entries) {
      if (entry.userId !== userId) continue
      if (entry.source !== "event" || entry.voidedAt !== undefined) continue
      if (entry.cleanupId === null) continue
      const organizationId = this.cleanups.get(entry.cleanupId)?.organizationId ?? null
      if (organizationId === null) continue
      const org = this.organizations.get(organizationId)
      if (org === undefined || org.deleted === true || org.suspended === true) continue
      hoursByOrg.set(organizationId, (hoursByOrg.get(organizationId) ?? 0) + entry.hours)
    }
    const views: OrgHoursView[] = []
    for (const [organizationId, hours] of hoursByOrg) {
      const org = this.organizations.get(organizationId)
      if (org === undefined) continue
      views.push({
        organizationId,
        slug: org.slug,
        name: org.name,
        logoKey: org.logoKey ?? null,
        verified: org.verified ?? false,
        verifiedKind: org.verifiedKind ?? null,
        hours: round2(hours),
      })
    }
    views.sort((a, b) => b.hours - a.hours || a.organizationId.localeCompare(b.organizationId))
    return views.slice(0, MAX_ORG_CHIPS_FETCH)
  }

  totalsFor(userId: string): Promise<MyVolunteerHoursTotals> {
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
    return Promise.resolve({
      totalHours: this.computeTotalHours(userId),
      byJurisdiction,
      byOrganization: this.organizationHoursFor(userId),
    })
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
      .filter((e) => isBeforeTimeCursor(e.createdAt.getTime(), e.id, args.cursor))
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
              organization: creditor?.organization ?? null,
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
