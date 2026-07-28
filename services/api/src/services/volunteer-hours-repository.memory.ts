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
  /**
   * C18's nullable tri-state, mirrored so the twin can exercise all three states:
   *   undefined / null = never chosen -> aggregate visible, items[] empty
   *   true             = opted in     -> aggregate + items visible
   *   false            = opted out    -> hidden everywhere public
   */
  showVolunteerHours?: boolean | null
  /** Tombstoned account (users.deleted_at IS NOT NULL): hidden on BOTH gates, like the Drizzle read. */
  deleted?: boolean
}

/** Event metadata the ledger join produces (cleanups.title / reference_code / scheduled_at). */
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
  /** Mirrors `volunteer_hours.voided_at` — 0065 writes it for the report credits; every read filters it. */
  voidedAt?: Date
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface InMemoryVolunteerHoursRepositoryOpts {
  /** Injectable so a test can force exact `created_at` ties and assert the `(created_at, id)` tie-break. */
  now?: () => Date
  newId?: () => string
}

/**
 * The in-memory twin of the Drizzle VolunteerHoursRepository. It exists so ~2000 lines of unit tests can
 * exercise the service without Docker, which makes a DIVERGENCE between the two invisible to CI (unit
 * tests run this, integration runs the real one) — so every rule the Drizzle impl enforces is mirrored
 * here deliberately, including the per-geoid rollup reversal, the `voided_at` filter, the C18 tri-state
 * gates and the B33b `changed[]` pre-image.
 */
export class InMemoryVolunteerHoursRepository implements VolunteerHoursRepository {
  // The prior credit AND the jurisdiction it was booked into. The geoid is stored because an event whose
  // location was edited must MOVE its rollup rather than delta against whichever jurisdiction it happens
  // to be in now — the same rule the Drizzle impl's per-geoid deltas implement. It is ALSO the B33b
  // pre-image the hours_logged bell needs ("was there a credit before, and was it smaller?").
  private readonly eventLedger = new Map<string, { hours: number; geoid: string | null }>()
  private readonly rollup = new Map<string, number>()
  private readonly users = new Map<string, MemoryLeaderboardUser>()
  private readonly jurisdictionNames = new Map<string, string>()
  private readonly cleanups = new Map<string, MemoryCleanupMeta>()
  /** The row-level ledger the itemised transcript reads (the Drizzle `volunteer_hours` table). */
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

  /** Mark a ledger row void, the way 0065 voided every report credit. Every read filters these out. */
  voidEntry(entryId: string): void {
    const row = this.entries.find((e) => e.id === entryId)
    if (row) row.voidedAt = this.now()
  }

  /**
   * TEST SEAM, not a capability: plant a PRE-0065 `source='report'` row (and, as the old award did, its
   * rollup contribution) so a test can prove the read filters exclude it. Production has no way to write
   * one — `awardReportHours` is gone from the interface and both impls, because filing a report is not
   * volunteer service. Do NOT call this from src/.
   */
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
      // B33b: the pre-image, snapshotted BEFORE the overwrite exactly as the Drizzle audit INSERT does.
      // `null` = no prior credit, deliberately distinct from a stored 0.
      changed.push({
        userId: entry.userId,
        hours: entry.hours,
        previousHours: previous === null ? null : previous.hours,
      })
      this.eventLedger.set(key, { hours: entry.hours, geoid: args.geoid })
      // Re-log in the SAME jurisdiction: move the rollup by the difference. Re-log after the event
      // MOVED: reverse the whole prior credit out of the old jurisdiction and book the full amount in
      // the new one, so neither leaderboard keeps hours the event no longer took place in.
      if (previous !== null && previous.geoid !== null && previous.geoid !== args.geoid) {
        this.addRollup(entry.userId, previous.geoid, -previous.hours)
      }
      if (args.geoid !== null) {
        const priorHere = previous !== null && previous.geoid === args.geoid ? previous.hours : 0
        this.addRollup(entry.userId, args.geoid, entry.hours - priorHere)
      }
      // One row per (cleanup, user) — the 0035 partial-unique index, upserted in place.
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
    let totalHours = 0
    for (const [key, total] of this.rollup) {
      const parsed = this.parseKey(key)
      if (parsed.userId !== userId || total <= 0) continue
      totalHours += total
      byJurisdiction.push({
        geoid: parsed.geoid,
        name: this.jurisdictionNames.get(parsed.geoid) ?? null,
        hours: round2(total),
      })
    }
    byJurisdiction.sort((a, b) => b.hours - a.hours || a.geoid.localeCompare(b.geoid))
    return Promise.resolve({ totalHours: round2(totalHours), byJurisdiction })
  }

  totalHoursFor(userId: string): Promise<number> {
    let total = 0
    for (const [key, value] of this.rollup) {
      if (this.parseKey(key).userId === userId && value > 0) total += value
    }
    return Promise.resolve(round2(total))
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
      // C18: `IS NOT FALSE`, not a truth test — an unseeded or never-chosen user stays on the board.
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
    // Omitted `sources` means ITEMISED_SOURCES (never 'report'), exactly like the Drizzle default.
    const sources = args.sources ?? ITEMISED_SOURCES
    const rows = this.entries
      .filter(
        (e) => e.userId === args.userId && e.voidedAt === undefined && sources.includes(e.source),
      )
      // Newest first on (created_at DESC, id DESC), the same keyset the 0062 index serves.
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
      // Independent of the filter: an attendee with no row of their own still needs to know whether the
      // host has logged at all (the Drizzle twin runs a separate EXISTS probe for exactly this).
      anyLogged: all.length > 0,
    })
  }

  /**
   * C18's two gates. An UNSEEDED id reads as the NULL tri-state (never chosen), not as "no users row":
   * `seedUser` here carries display metadata, and the twin has no notion of row existence — the Drizzle
   * impl's `WHERE id = $1 AND deleted_at IS NULL` miss (a genuinely unknown id ⇒ hidden) is pinned in
   * test/integration/volunteer-hours-pg.test.ts instead. Use `deleted: true` to model a tombstone.
   */
  hoursVisibilityFor(userId: string): Promise<HoursVisibility> {
    const user = this.users.get(userId)
    if (user?.deleted === true) return Promise.resolve({ aggregate: false, items: false })
    const flag = user?.showVolunteerHours ?? null
    return Promise.resolve({ aggregate: flag !== false, items: flag === true })
  }

  /** Mirrors the Drizzle read INCLUDING its `source <> 'report'` filter — a report never prints. */
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
    const items = matching.slice(0, args.limit).map((e) => this.toView(e))
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
