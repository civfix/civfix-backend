import { randomUUID } from "node:crypto"
import { AppError, avatarGradient } from "@civfix/shared"
import type {
  LeaderboardEntryDTO,
  MyVolunteerHoursDTO,
  OrganizationRefDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import { CIVFIX_OFFICIAL_USER_ID, isOfficialAccount } from "../../src/auth/official-account.js"
import { encodeTimeCursor, isBeforeTimeCursor, pageWith } from "../../src/db/cursor-helpers.js"
import { DEFAULT_EVENT_TIME_ZONE } from "../../src/services/host/event-fields.js"
import { eventDayKey } from "../../src/services/host/event-day.js"
import {
  DAILY_HOURS_CAP,
  ITEMISED_SOURCES,
  MANUAL_CREDIT_REPEAT_WINDOW_MS,
  MAX_ORG_CHIPS_FETCH,
  OPERATOR_LEDGER_MAX_LIMIT,
  RECIPROCAL_LOOKBACK_MS,
  WEEKLY_HOURS_FLAG_DEFAULT,
} from "../../src/services/volunteer-hours-service.js"
import type {
  CertificateEntriesPage,
  EntriesForCertificateArgs,
  EventHoursLedger,
  HoursVisibility,
  LeaderboardPage,
  ListEntriesArgs,
  EventCreditChange,
  EventCreditWrite,
  LogEventHoursArgs,
  LogEventHoursResult,
  MyVolunteerHoursTotals,
  OperatorCreditResult,
  OperatorEventCreditArgs,
  OperatorLedgerArgs,
  OperatorLedgerEntryView,
  OperatorLedgerTotals,
  OperatorManualCreditArgs,
  OperatorVoidArgs,
  OrgHoursView,
  VolunteerHoursAnomaly,
  VolunteerHoursEntryView,
  VolunteerHoursRepository,
  VoidedEntry,
} from "../../src/services/volunteer-hours-repository.js"
import { assertWithinDailyHoursCap } from "../../src/services/volunteer-hours-rules.js"
import { MS_PER_WEEK } from "../../src/lib/time.js"

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

export interface LedgerEntry {
  id: string
  userId: string
  source: VolunteerHoursSource
  hours: number
  createdAt: Date
  cleanupId: string | null
  reportId: string | null
  geoid: string | null
  loggedByUserId: string | null
  note: string | null
  serviceDate: string | null
  creditedByOperatorId: string | null
  voidedByOperatorId: string | null
  voidReason: string | null
  voidedAt?: Date
}

export interface RecordedHoursAudit {
  actorId: string
  action: string
  target: string
  meta: Record<string, unknown>
}

export interface RecordedHoursJournal {
  cleanupId: string
  userId: string
  actorUserId: string
  previousHours: number | null
  newHours: number
}

function serviceDayNoonUtc(serviceDate: string): Date {
  return new Date(`${serviceDate}T12:00:00.000Z`)
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
  private readonly rollup = new Map<string, number>()
  private readonly users = new Map<string, MemoryLeaderboardUser>()
  private readonly jurisdictionNames = new Map<string, string>()
  private readonly cleanups = new Map<string, MemoryCleanupMeta>()
  private readonly organizations = new Map<string, MemoryOrganization>()
  private readonly entries: LedgerEntry[] = []
  readonly audits: RecordedHoursAudit[] = []
  readonly journal: RecordedHoursJournal[] = []
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

  markVoided(entryId: string): void {
    const row = this.entries.find((e) => e.id === entryId)
    if (row === undefined || row.voidedAt !== undefined) return
    row.voidedAt = this.now()
    if (row.geoid !== null) this.addRollup(row.userId, row.geoid, -row.hours)
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
      note: null,
      serviceDate: null,
      creditedByOperatorId: null,
      voidedByOperatorId: null,
      voidReason: null,
    })
    if (geoid !== null) this.addRollup(userId, geoid, hours)
    return id
  }

  ledgerRow(entryId: string): LedgerEntry | null {
    const row = this.entries.find((e) => e.id === entryId)
    return row === undefined ? null : { ...row }
  }

  async logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult> {
    this.assertNoReciprocalCredit(args)
    this.assertDailyCap(args)
    const changed = this.writeEventCredits({
      cleanupId: args.cleanupId,
      geoid: args.geoid,
      actorId: args.actorId,
      loggedByUserId: args.actorId,
      note: null,
      creditedByOperatorId: null,
      entries: args.entries,
    })
    return {
      credited: args.entries.length,
      changed,
      anomalies: this.detectAnomalies(args),
    }
  }

  private writeEventCredits(write: EventCreditWrite): EventCreditChange[] {
    const changed: EventCreditChange[] = []
    for (const entry of write.entries) {
      const hours = round2(entry.hours)
      const existing = this.entries.find(
        (e) => e.source === "event" && e.cleanupId === write.cleanupId && e.userId === entry.userId,
      )
      const live = existing !== undefined && existing.voidedAt === undefined ? existing : null
      if (live !== null && live.hours === hours && live.geoid === write.geoid) continue

      const previousHours = existing === undefined ? null : (live?.hours ?? 0)
      changed.push({ userId: entry.userId, hours, previousHours })
      this.journal.push({
        cleanupId: write.cleanupId,
        userId: entry.userId,
        actorUserId: write.actorId,
        previousHours,
        newHours: hours,
      })
      if (live !== null && live.geoid !== null)
        this.addRollup(entry.userId, live.geoid, -live.hours)
      if (write.geoid !== null) this.addRollup(entry.userId, write.geoid, hours)

      if (existing === undefined) {
        this.entries.push({
          id: this.newId(),
          userId: entry.userId,
          source: "event",
          hours,
          createdAt: this.now(),
          cleanupId: write.cleanupId,
          reportId: null,
          geoid: write.geoid,
          loggedByUserId: write.loggedByUserId,
          note: write.note,
          serviceDate: null,
          creditedByOperatorId: write.creditedByOperatorId,
          voidedByOperatorId: null,
          voidReason: null,
        })
        continue
      }
      if (existing.voidedAt !== undefined) {
        delete existing.voidedAt
        existing.createdAt = this.now()
      }
      existing.hours = hours
      existing.geoid = write.geoid
      existing.loggedByUserId = write.loggedByUserId
      existing.note = write.note
      existing.creditedByOperatorId = write.creditedByOperatorId
      existing.voidedByOperatorId = null
      existing.voidReason = null
    }
    return changed
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
    const held = this.sameDayEventHours(
      args.cleanupId,
      args.entries.map((e) => e.userId),
    )
    if (held === null) return
    assertWithinDailyHoursCap(args.entries, held, args.dailyCapHours ?? DAILY_HOURS_CAP)
  }

  private sameDayEventHours(
    cleanupId: string,
    userIds: readonly string[],
  ): Map<string, number> | null {
    const day = this.eventDay(cleanupId)
    if (day === null) return null
    return this.creditedHoursOnDay(day, userIds, cleanupId)
  }

  private creditedHoursOnDay(
    day: string,
    userIds: readonly string[],
    excludeCleanupId: string | null,
  ): Map<string, number> {
    const held = new Map<string, number>()
    for (const e of this.entries) {
      if (e.voidedAt !== undefined || !userIds.includes(e.userId)) continue
      if (e.source === "manual") {
        if (e.serviceDate !== day) continue
      } else if (e.source === "event") {
        if (e.cleanupId === null || e.cleanupId === excludeCleanupId) continue
        if (this.eventDay(e.cleanupId) !== day) continue
      } else {
        continue
      }
      held.set(e.userId, (held.get(e.userId) ?? 0) + e.hours)
    }
    return held
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
        .map((e) => ({
          userId: e.userId,
          hours: round2(e.hours),
          loggedAt: e.createdAt,
          creditedByOfficial: isOfficialAccount(e.loggedByUserId),
        })),
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

  async creditEventAsOperator(args: OperatorEventCreditArgs): Promise<OperatorCreditResult> {
    const hours = round2(args.hours)
    const live = this.entries.find(
      (e) =>
        e.source === "event" &&
        e.cleanupId === args.cleanupId &&
        e.userId === args.userId &&
        e.voidedAt === undefined,
    )
    if (live !== undefined) {
      throw AppError.conflict(
        `That volunteer already holds ${round2(live.hours)} h for this event; void that entry first.`,
      )
    }
    const entries = [{ userId: args.userId, hours }]
    const held = this.sameDayEventHours(args.cleanupId, [args.userId])
    if (held !== null) {
      assertWithinDailyHoursCap(entries, held, args.dailyCapHours ?? DAILY_HOURS_CAP)
    }
    this.writeEventCredits({
      cleanupId: args.cleanupId,
      geoid: args.geoid,
      actorId: args.operatorId,
      loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
      note: args.reason,
      creditedByOperatorId: args.operatorId,
      entries,
    })
    const row = this.entries.find(
      (e) => e.source === "event" && e.cleanupId === args.cleanupId && e.userId === args.userId,
    )
    if (row === undefined)
      throw new Error("creditEventAsOperator: the upserted event row is missing")
    this.audits.push({
      actorId: args.operatorId,
      action: "user.hours_credited",
      target: `user:${args.userId}`,
      meta: {
        entryId: row.id,
        source: "event",
        cleanupId: args.cleanupId,
        hours,
        reason: args.reason,
      },
    })
    return { entryId: row.id }
  }

  async creditManual(args: OperatorManualCreditArgs): Promise<OperatorCreditResult> {
    const hours = round2(args.hours)
    const nowMs = this.now().getTime()
    const repeat = this.entries.some(
      (e) =>
        e.userId === args.userId &&
        e.source === "manual" &&
        e.voidedAt === undefined &&
        e.hours === hours &&
        e.serviceDate === args.serviceDate &&
        e.creditedByOperatorId === args.operatorId &&
        nowMs - e.createdAt.getTime() < MANUAL_CREDIT_REPEAT_WINDOW_MS,
    )
    if (repeat) {
      throw AppError.conflict(
        "That adjustment was recorded moments ago; check the ledger before adding it again.",
      )
    }
    assertWithinDailyHoursCap(
      [{ userId: args.userId, hours }],
      this.creditedHoursOnDay(args.serviceDate, [args.userId], null),
      args.dailyCapHours ?? DAILY_HOURS_CAP,
    )
    const entryId = this.newId()
    this.entries.push({
      id: entryId,
      userId: args.userId,
      source: "manual",
      hours,
      createdAt: this.now(),
      cleanupId: null,
      reportId: null,
      geoid: null,
      loggedByUserId: CIVFIX_OFFICIAL_USER_ID,
      note: args.reason,
      serviceDate: args.serviceDate,
      creditedByOperatorId: args.operatorId,
      voidedByOperatorId: null,
      voidReason: null,
    })
    this.audits.push({
      actorId: args.operatorId,
      action: "user.hours_credited",
      target: `user:${args.userId}`,
      meta: {
        entryId,
        source: "manual",
        hours,
        serviceDate: args.serviceDate,
        reason: args.reason,
      },
    })
    return { entryId }
  }

  async voidEntry(args: OperatorVoidArgs): Promise<VoidedEntry> {
    const row = this.entries.find((e) => e.id === args.entryId && e.userId === args.userId)
    if (row === undefined) throw AppError.notFound("Hours entry not found")
    if (row.voidedAt !== undefined) {
      throw AppError.conflict("That hours entry is already void.")
    }
    if (row.source === "report") {
      throw AppError.conflict("Report credits are retired and can't be voided.")
    }
    row.voidedAt = this.now()
    row.voidedByOperatorId = args.operatorId
    row.voidReason = args.reason
    if (row.source === "event" && row.cleanupId !== null) {
      this.journal.push({
        cleanupId: row.cleanupId,
        userId: row.userId,
        actorUserId: args.operatorId,
        previousHours: row.hours,
        newHours: 0,
      })
    }
    if (row.geoid !== null) this.addRollup(row.userId, row.geoid, -row.hours)
    this.audits.push({
      actorId: args.operatorId,
      action: "user.hours_voided",
      target: `user:${args.userId}`,
      meta: {
        entryId: row.id,
        source: row.source,
        ...(row.cleanupId !== null ? { cleanupId: row.cleanupId } : {}),
        hours: row.hours,
        reason: args.reason,
      },
    })
    return { id: row.id, source: row.source, cleanupId: row.cleanupId, hours: row.hours }
  }

  listOperatorLedger(
    args: OperatorLedgerArgs,
  ): Promise<{ items: OperatorLedgerEntryView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, Math.floor(args.limit)), OPERATOR_LEDGER_MAX_LIMIT)
    const rows = this.entries
      .filter((e) => e.userId === args.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .filter((e) => isBeforeTimeCursor(e.createdAt.getTime(), e.id, args.cursor))
      .slice(0, limit + 1)
    const { items, nextCursor } = pageWith(rows, limit, (last) =>
      encodeTimeCursor({ at: last.createdAt, id: last.id }),
    )
    return Promise.resolve({ items: items.map((e) => this.toOperatorView(e)), nextCursor })
  }

  operatorLedgerTotals(userId: string): Promise<OperatorLedgerTotals> {
    const mine = this.entries.filter((e) => e.userId === userId)
    return Promise.resolve({
      totalHours: this.computeTotalHours(userId),
      liveEntries: mine.filter((e) => e.voidedAt === undefined).length,
      voidedEntries: mine.filter((e) => e.voidedAt !== undefined).length,
    })
  }

  private toOperatorView(e: LedgerEntry): OperatorLedgerEntryView {
    const meta = e.cleanupId !== null ? (this.cleanups.get(e.cleanupId) ?? null) : null
    const nameOf = (id: string): string => this.users.get(id)?.name ?? ""
    return {
      id: e.id,
      source: e.source,
      hours: round2(e.hours),
      occurredAt: this.occurredAt(e),
      createdAt: e.createdAt,
      serviceDate: e.serviceDate,
      event:
        e.cleanupId !== null
          ? {
              id: e.cleanupId,
              title: meta?.title ?? "",
              referenceCode: meta?.referenceCode ?? null,
            }
          : null,
      jurisdiction:
        e.geoid !== null
          ? { geoid: e.geoid, name: this.jurisdictionNames.get(e.geoid) ?? null }
          : null,
      creditedBy:
        e.loggedByUserId !== null
          ? {
              id: e.loggedByUserId,
              name: nameOf(e.loggedByUserId),
              handle: this.users.get(e.loggedByUserId)?.handle ?? "",
              official: isOfficialAccount(e.loggedByUserId),
            }
          : null,
      operator:
        e.creditedByOperatorId !== null
          ? { id: e.creditedByOperatorId, name: nameOf(e.creditedByOperatorId) }
          : null,
      note: e.note,
      voidedAt: e.voidedAt ?? null,
      voidedBy:
        e.voidedByOperatorId !== null
          ? { id: e.voidedByOperatorId, name: nameOf(e.voidedByOperatorId) }
          : null,
      voidReason: e.voidReason,
    }
  }

  private occurredAt(e: LedgerEntry): Date {
    const scheduledAt = e.cleanupId !== null ? this.cleanups.get(e.cleanupId)?.scheduledAt : null
    if (scheduledAt != null) return scheduledAt
    if (e.serviceDate !== null) return serviceDayNoonUtc(e.serviceDate)
    return e.createdAt
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
      occurredAt: this.occurredAt(e),
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
