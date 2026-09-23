import {
  AppError,
  avatarGradient,
  MAX_EVENT_HOURS,
  MAX_EVENT_HOURS_ENTRIES,
  MIN_EVENT_HOURS,
} from "@civfix/shared"
import type {
  CleanupMemberRole,
  CleanupStatus,
  EventHoursEntry,
  EventHoursResponse,
  EventVisibility,
  LeaderboardEntryDTO,
  LeaderboardQuery,
  LeaderboardResponse,
  LogEventHoursResponse,
  MyVolunteerHoursDTO,
  MyVolunteerHoursEntriesQuery,
  MyVolunteerHoursEntriesResponse,
  OrganizationRefDTO,
  OrgHoursDTO,
  PublicVolunteerHoursQuery,
  PublicVolunteerHoursResponse,
  VolunteerHoursEntryDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import { can, type HostStanding } from "@civfix/shared/host"
import { parseKeysetCursor, type KeysetCursor } from "../db/cursor-helpers.js"
import { MIN_EVENT_DURATION_MS, eventWindowOf, hasEventEnded } from "./cleanup-rules.js"
import { mapWithLimit, PRESIGN_CONCURRENCY } from "./media-presign.js"
import type { AffiliationLoader } from "./affiliation.js"
import { hasHostStanding, isEventPubliclyVisible } from "./host/authz.js"
import type { TopVolunteerRow } from "./host/analytics-repository.drizzle.js"
import type { InsightsInvalidator } from "./host/host-analytics-cache.js"
import type { NotificationService } from "./notification-service.js"

const LEADERBOARD_DEFAULT_LIMIT = 20
export const LEADERBOARD_MAX_LIMIT = 50
export const LEADERBOARD_MAX_OFFSET = 500
export const EVENT_HOURS_MEMBER_CAP = 2000

const HOURS_ENTRIES_DEFAULT_LIMIT = 20
const HOURS_ENTRIES_MAX_LIMIT = 50

const LEADERBOARD_EXTRAS_MIN_LIMIT = 25

export const MAX_ORG_CHIPS_FETCH = 20

const HOURS_NOTIFY_CONCURRENCY = 8

const MS_PER_MINUTE = 60_000

const MS_PER_HOUR = 60 * MS_PER_MINUTE

const HOURS_ROUNDING_FACTOR = 100

const EVENT_WINDOW_GRACE_MS = MS_PER_HOUR

export const DAILY_HOURS_CAP = 24

export const WEEKLY_HOURS_FLAG_DEFAULT = 60

export const RECIPROCAL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

export type VolunteerHoursAnomalyKind = "weekly_hours" | "reciprocal_credit"

export interface VolunteerHoursAnomaly {
  kind: VolunteerHoursAnomalyKind
  userId: string
  counterpartUserId: string | null
  hours: number | null
}

export interface HoursModerationSink {
  flag(input: {
    userId: string
    cleanupId: string
    kind: VolunteerHoursAnomalyKind
    counterpartUserId: string | null
    hours: number | null
  }): Promise<void>
}

export interface EventHoursWindow {
  scheduledAt: Date
  endsAt: Date
  completedAt: Date | null
}

export function creditableHoursForEvent(cleanup: EventHoursWindow): number {
  const windowMs = eventDurationMs(cleanup)
  if (windowMs <= 0) return 0
  const hours = (windowMs + EVENT_WINDOW_GRACE_MS) / MS_PER_HOUR
  return Math.min(MAX_EVENT_HOURS, round2(hours))
}

function eventDurationMs(cleanup: EventHoursWindow): number {
  const end = cleanup.completedAt ?? cleanup.endsAt
  return end.getTime() - cleanup.scheduledAt.getTime()
}

export interface LogEventHoursArgs {
  actorId: string
  cleanupId: string
  geoid: string | null
  entries: EventHoursEntry[]
  dailyCapHours?: number
  weeklyFlagHours?: number
}

export interface LogEventHoursResult {
  credited: number
  changed: { userId: string; hours: number; previousHours: number | null }[]
  anomalies: VolunteerHoursAnomaly[]
}

export interface VolunteerHoursEntryView {
  id: string
  source: VolunteerHoursSource
  hours: number
  createdAt: Date
  occurredAt: Date
  cleanupId: string | null
  cleanupTitle: string | null
  cleanupReferenceCode: string | null
  reportId: string | null
  jurisdictionGeoid: string | null
  jurisdictionName: string | null
  creditedBy: {
    id: string
    name: string
    handle: string | null
    organization: OrganizationRefDTO | null
  } | null
}

export interface EventHoursLedgerEntry {
  userId: string
  hours: number
  loggedAt: Date
}

export interface EventHoursLedger {
  entries: EventHoursLedgerEntry[]
  anyLogged: boolean
}

export interface HoursVisibility {
  aggregate: boolean
  items: boolean
}

export interface LeaderboardPage {
  jurisdictionName: string | null
  entries: LeaderboardEntryDTO[]
  nextOffset: number | null
  participantCount: number | null
  viewerRank: number | null
  viewerHours: number | null
}

export const ITEMISED_SOURCES: readonly VolunteerHoursSource[] = ["event", "manual"]

export interface ListEntriesArgs {
  userId: string
  cursor: KeysetCursor | null
  limit: number
  sources?: VolunteerHoursSource[]
}

export interface EntriesForCertificateArgs {
  userId: string
  geoid: string | null
  from: Date | null
  to: Date | null
  limit: number
}

export interface CertificateEntriesPage {
  items: VolunteerHoursEntryView[]
  totalHours: number
  entryCount: number
}

export interface OrgHoursView {
  organizationId: string
  slug: string
  name: string
  logoKey: string | null
  verified: boolean
  verifiedKind: OrganizationRefDTO["verifiedKind"]
  hours: number
}

export interface MyVolunteerHoursTotals {
  totalHours: number
  byJurisdiction: MyVolunteerHoursDTO["byJurisdiction"]
  byOrganization: OrgHoursView[]
}

export type OrgLogoPresigner = (key: string) => Promise<string>

export function leaderboardEntryOf(row: TopVolunteerRow, rank: number): LeaderboardEntryDTO {
  return {
    rank,
    userId: row.userId,
    name: row.name,
    ...(row.handle !== null ? { handle: row.handle } : {}),
    avatar: avatarGradient(row.userId),
    ...(row.avatarUrl !== null ? { avatarUrl: row.avatarUrl } : {}),
    hours: round2(row.hours),
  }
}

export interface VolunteerHoursRepository {
  logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult>
  totalsFor(userId: string): Promise<MyVolunteerHoursTotals>
  totalHoursFor(userId: string): Promise<number>
  leaderboard(
    geoid: string,
    limit: number,
    offset: number,
    viewerId: string | null,
    withExtras: boolean,
  ): Promise<LeaderboardPage>
  listEntries(
    args: ListEntriesArgs,
  ): Promise<{ items: VolunteerHoursEntryView[]; nextCursor: string | null }>
  listEventHours(cleanupId: string, viewerId: string | null): Promise<EventHoursLedger>
  hoursVisibilityFor(userId: string): Promise<HoursVisibility>
  entriesForCertificate(args: EntriesForCertificateArgs): Promise<CertificateEntriesPage>
}

export interface CleanupHoursView {
  organizerUserId: string
  status: CleanupStatus
  visibility: EventVisibility
  jurisdictionGeoid: string | null
  title: string
  scheduledAt: Date
  endsAt: Date
  completedAt: Date | null
  timezone: string | null
}

export interface CleanupHoursLookup {
  load(cleanupId: string): Promise<CleanupHoursView | null>
  listMemberIds(cleanupId: string, limit: number): Promise<string[]>
  roleOf(cleanupId: string, userId: string): Promise<CleanupMemberRole | null>
  standingOf?(cleanupId: string, userId: string): Promise<HostStanding>
}

export interface VolunteerHoursServiceDeps {
  repo: VolunteerHoursRepository
  cleanups: CleanupHoursLookup
  affiliations?: AffiliationLoader
  presignOrgLogo?: OrgLogoPresigner
  insightsInvalidator?: InsightsInvalidator
  isBlockedEitherWay?: (viewerId: string, targetId: string) => Promise<boolean>
  notifier?: Pick<NotificationService, "createNotification">
  moderation?: HoursModerationSink
  weeklyFlagHours?: number
  logger?: { warn(obj: unknown, msg?: string): void }
}

export interface VolunteerHoursService {
  getMyHours(userId: string): Promise<MyVolunteerHoursDTO>
  getMyHoursEntries(
    userId: string,
    query: MyVolunteerHoursEntriesQuery,
  ): Promise<MyVolunteerHoursEntriesResponse>
  getPublicHours(
    query: PublicVolunteerHoursQuery,
    viewerId: string | null,
  ): Promise<PublicVolunteerHoursResponse>
  getEventHours(cleanupId: string, viewerId: string): Promise<EventHoursResponse>
  logEventHours(input: {
    cleanupId: string
    actorId: string
    entries: EventHoursEntry[]
  }): Promise<LogEventHoursResponse>
  leaderboard(
    geoid: string,
    query: LeaderboardQuery,
    viewerId?: string | null,
  ): Promise<LeaderboardResponse>
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LEADERBOARD_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), LEADERBOARD_MAX_LIMIT)
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  return Math.min(Math.max(0, Math.floor(offset)), LEADERBOARD_MAX_OFFSET)
}

// An offset past the ceiling clamps back onto the page just served, so a client following it would
// loop on that page forever.
function reachableNextOffset(next: number | null): number | null {
  return next !== null && next <= LEADERBOARD_MAX_OFFSET ? next : null
}

function clampEntriesLimit(limit: number | undefined): number {
  if (limit === undefined) return HOURS_ENTRIES_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), HOURS_ENTRIES_MAX_LIMIT)
}

function neutralPublicHours(): PublicVolunteerHoursResponse {
  return {
    visible: true,
    totalHours: 0,
    byJurisdiction: [],
    byOrganization: [],
    items: [],
    reportHours: 0,
    nextCursor: null,
  }
}

function round2(n: number): number {
  return Math.round(n * HOURS_ROUNDING_FACTOR) / HOURS_ROUNDING_FACTOR
}

async function entriesWithCreditorAffiliation(
  load: AffiliationLoader | undefined,
  views: readonly VolunteerHoursEntryView[],
  viewerId: string | null,
): Promise<VolunteerHoursEntryDTO[]> {
  const dtos = views.map(toVolunteerHoursEntryDTO)
  if (load === undefined) return dtos
  const creditorIds = views
    .map((v) => v.creditedBy?.id)
    .filter((id): id is string => id !== undefined)
  if (creditorIds.length === 0) return dtos
  const affiliations = await load(creditorIds, viewerId)
  if (affiliations.size === 0) return dtos
  return dtos.map((dto) =>
    dto.creditedBy === undefined || dto.creditedBy === null
      ? dto
      : {
          ...dto,
          creditedBy: {
            ...dto.creditedBy,
            organization: affiliations.get(dto.creditedBy.id) ?? null,
          },
        },
  )
}

function toVolunteerHoursEntryDTO(view: VolunteerHoursEntryView): VolunteerHoursEntryDTO {
  return {
    id: view.id,
    source: view.source,
    hours: round2(view.hours),
    occurredAt: view.occurredAt.toISOString(),
    creditedAt: view.createdAt.toISOString(),
    ...(view.cleanupId !== null ? { eventId: view.cleanupId } : {}),
    ...(view.cleanupTitle !== null ? { eventTitle: view.cleanupTitle } : {}),
    ...(view.cleanupReferenceCode !== null
      ? { eventReferenceCode: view.cleanupReferenceCode }
      : {}),
    ...(view.reportId !== null ? { reportId: view.reportId } : {}),
    ...(view.jurisdictionGeoid !== null ? { jurisdictionGeoid: view.jurisdictionGeoid } : {}),
    ...(view.jurisdictionName !== null ? { jurisdictionName: view.jurisdictionName } : {}),
    ...(view.creditedBy !== null
      ? {
          creditedBy: {
            id: view.creditedBy.id,
            name: view.creditedBy.name,
            ...(view.creditedBy.handle !== null ? { handle: view.creditedBy.handle } : {}),
            organization: view.creditedBy.organization,
          },
        }
      : {}),
  }
}

function toEventHoursRow(entry: EventHoursLedgerEntry): {
  userId: string
  hours: number
  loggedAt: string
} {
  return {
    userId: entry.userId,
    hours: round2(entry.hours),
    loggedAt: entry.loggedAt.toISOString(),
  }
}

function assertHoursLoggable(
  cleanup: CleanupHoursView,
  actorStanding: HostStanding,
): { durationMs: number; windowCap: number } {
  if (!can(actorStanding, "manage_event")) {
    throw AppError.forbidden("Only the event hosts can log volunteer hours.")
  }
  if (cleanup.status === "cancelled") {
    throw AppError.conflict("Volunteer hours can't be logged for a cancelled event.")
  }
  if (!hasEventEnded(eventWindowOf(cleanup), Date.now())) {
    throw AppError.conflict("Volunteer hours can be logged once the event has ended.")
  }
  const durationMs = eventDurationMs(cleanup)
  if (durationMs < MIN_EVENT_DURATION_MS) {
    throw AppError.conflict(
      `This event ran for less than ${MIN_EVENT_DURATION_MS / MS_PER_MINUTE} minutes, so no volunteer hours can be logged against it.`,
    )
  }
  return { durationMs, windowCap: creditableHoursForEvent(cleanup) }
}

function assertCreditableEntries(
  entries: readonly EventHoursEntry[],
  actorId: string,
  durationMs: number,
  windowCap: number,
): void {
  if (entries.length > MAX_EVENT_HOURS_ENTRIES) {
    throw AppError.validation({
      entries: `at most ${MAX_EVENT_HOURS_ENTRIES} attendees may be credited in one request`,
    })
  }

  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.userId === actorId) {
      throw AppError.forbidden(
        "You can't log volunteer hours for yourself. Another host must credit you.",
      )
    }
    if (!(entry.hours >= MIN_EVENT_HOURS) || entry.hours > MAX_EVENT_HOURS) {
      throw AppError.validation({
        entries: `hours must be at least ${MIN_EVENT_HOURS} and at most ${MAX_EVENT_HOURS}`,
      })
    }
    if (entry.hours > windowCap) {
      throw AppError.validation({
        entries: `this event ran for ${round2(durationMs / MS_PER_HOUR)} h, so at most ${windowCap} h may be credited per attendee`,
      })
    }
    if (seen.has(entry.userId)) {
      throw AppError.validation({ entries: `duplicate userId: ${entry.userId}` })
    }
    seen.add(entry.userId)
  }
}

export function makeVolunteerHoursService(deps: VolunteerHoursServiceDeps): VolunteerHoursService {
  async function organizationChips(views: readonly OrgHoursView[]): Promise<OrgHoursDTO[]> {
    const presign = deps.presignOrgLogo
    const keys =
      presign === undefined
        ? []
        : [...new Set(views.map((v) => v.logoKey).filter((k): k is string => k !== null))]
    const byKey = new Map<string, string>()
    if (presign !== undefined && keys.length > 0) {
      const urls = await mapWithLimit(keys, PRESIGN_CONCURRENCY, (key) => presign(key))
      keys.forEach((key, i) => {
        const url = urls[i]
        if (url !== undefined) byKey.set(key, url)
      })
    }
    return views.map((view) => ({
      organization: {
        id: view.organizationId,
        slug: view.slug,
        name: view.name,
        logoUrl: view.logoKey === null ? null : (byKey.get(view.logoKey) ?? null),
        verified: view.verified,
        verifiedKind: view.verifiedKind,
      },
      hours: round2(view.hours),
    }))
  }

  async function standingFor(cleanupId: string, userId: string): Promise<HostStanding> {
    if (deps.cleanups.standingOf !== undefined) {
      return deps.cleanups.standingOf(cleanupId, userId)
    }
    return { eventRole: await deps.cleanups.roleOf(cleanupId, userId), orgRole: null }
  }

  // Matches the event read's visibility rule: a private event the viewer has no standing on must
  // answer exactly like an unknown id, or these endpoints become an existence oracle.
  async function loadVisibleCleanup(
    cleanupId: string,
    viewerId: string,
  ): Promise<{ cleanup: CleanupHoursView; standing: HostStanding }> {
    const cleanup = await deps.cleanups.load(cleanupId)
    if (cleanup === null) throw AppError.notFound("Event not found")
    const standing = await standingFor(cleanupId, viewerId)
    if (!hasHostStanding(standing) && !isEventPubliclyVisible(cleanup.visibility)) {
      throw AppError.notFound("Event not found")
    }
    return { cleanup, standing }
  }

  async function notifyHoursLogged(
    cleanup: { id: string; title: string },
    changed: LogEventHoursResult["changed"],
    actorId: string,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    const recipients = changed.filter(
      (c) => c.userId !== actorId && (c.previousHours === null || c.hours > c.previousHours),
    )
    await mapWithLimit(recipients, HOURS_NOTIFY_CONCURRENCY, async (c) => {
      try {
        await notifier.createNotification(c.userId, {
          type: "hours_logged",
          titleKey: "notification.hours_logged.title",
          bodyKey: "notification.hours_logged.body",
          vars: { hours: round2(c.hours), title: cleanup.title },
          link: `/cleanups/${cleanup.id}`,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId: cleanup.id, userId: c.userId },
          "hours_logged notification failed (suppressed)",
        )
      }
    })
  }

  async function reportAnomalies(
    anomalies: VolunteerHoursAnomaly[],
    cleanupId: string,
  ): Promise<void> {
    const moderation = deps.moderation
    if (moderation === undefined) return
    for (const anomaly of anomalies) {
      try {
        await moderation.flag({
          userId: anomaly.userId,
          cleanupId,
          kind: anomaly.kind,
          counterpartUserId: anomaly.counterpartUserId,
          hours: anomaly.hours,
        })
      } catch (err) {
        deps.logger?.warn(
          { err, cleanupId, kind: anomaly.kind },
          "volunteer hours anomaly could not be filed for moderation (suppressed)",
        )
      }
    }
  }

  async function assertAllAttending(
    cleanupId: string,
    entries: readonly EventHoursEntry[],
  ): Promise<void> {
    const memberIds = new Set(await deps.cleanups.listMemberIds(cleanupId, EVENT_HOURS_MEMBER_CAP))
    const nonMembers = entries.filter((e) => !memberIds.has(e.userId))
    if (nonMembers.length > 0) {
      throw AppError.validation({
        entries: `not attending this event: ${nonMembers.map((e) => e.userId).join(", ")}`,
      })
    }
  }

  return {
    async getMyHours(userId: string): Promise<MyVolunteerHoursDTO> {
      const totals = await deps.repo.totalsFor(userId)
      return {
        totalHours: totals.totalHours,
        byJurisdiction: totals.byJurisdiction,
        byOrganization: await organizationChips(totals.byOrganization),
      }
    },

    async getMyHoursEntries(
      userId: string,
      query: MyVolunteerHoursEntriesQuery,
    ): Promise<MyVolunteerHoursEntriesResponse> {
      const limit = clampEntriesLimit(query.limit)
      const [page, totalHours] = await Promise.all([
        deps.repo.listEntries({ userId, cursor: parseKeysetCursor(query.cursor), limit }),
        deps.repo.totalHoursFor(userId),
      ])
      return {
        items: await entriesWithCreditorAffiliation(deps.affiliations, page.items, userId),
        nextCursor: page.nextCursor,
        totalHours,
      }
    },

    async getPublicHours(
      query: PublicVolunteerHoursQuery,
      viewerId: string | null,
    ): Promise<PublicVolunteerHoursResponse> {
      const userId = query.id
      const isSelf = viewerId !== null && viewerId === userId

      const [blockedEitherWay, visibility] = await Promise.all([
        !isSelf && viewerId !== null && deps.isBlockedEitherWay
          ? deps.isBlockedEitherWay(viewerId, userId)
          : Promise.resolve(false),
        isSelf
          ? Promise.resolve({ aggregate: true, items: true })
          : deps.repo.hoursVisibilityFor(userId),
      ])

      if (blockedEitherWay || !visibility.aggregate) {
        return neutralPublicHours()
      }

      const limit = clampEntriesLimit(query.limit)
      const [totals, page] = await Promise.all([
        deps.repo.totalsFor(userId),
        visibility.items
          ? deps.repo.listEntries({
              userId,
              cursor: parseKeysetCursor(query.cursor),
              limit,
              sources: ["event"],
            })
          : Promise.resolve({ items: [], nextCursor: null }),
      ])

      return {
        visible: true,
        totalHours: totals.totalHours,
        byJurisdiction: totals.byJurisdiction,
        byOrganization: await organizationChips(totals.byOrganization),
        items: await entriesWithCreditorAffiliation(deps.affiliations, page.items, viewerId),
        reportHours: 0,
        nextCursor: page.nextCursor,
      }
    },

    async getEventHours(cleanupId: string, viewerId: string): Promise<EventHoursResponse> {
      const { standing } = await loadVisibleCleanup(cleanupId, viewerId)
      if (!hasHostStanding(standing)) {
        return { scope: "self", entries: [] }
      }

      if (can(standing, "manage_event")) {
        const ledger = await deps.repo.listEventHours(cleanupId, null)
        return {
          scope: "all",
          entries: ledger.entries.map(toEventHoursRow),
          anyLogged: ledger.entries.length > 0,
        }
      }

      const ledger = await deps.repo.listEventHours(cleanupId, viewerId)
      return {
        scope: "self",
        entries: ledger.entries.map(toEventHoursRow),
        anyLogged: ledger.anyLogged,
      }
    },

    async logEventHours(input: {
      cleanupId: string
      actorId: string
      entries: EventHoursEntry[]
    }): Promise<LogEventHoursResponse> {
      const { cleanup, standing: actorStanding } = await loadVisibleCleanup(
        input.cleanupId,
        input.actorId,
      )
      const { durationMs, windowCap } = assertHoursLoggable(cleanup, actorStanding)
      assertCreditableEntries(input.entries, input.actorId, durationMs, windowCap)
      await assertAllAttending(input.cleanupId, input.entries)

      const result = await deps.repo.logEventHours({
        actorId: input.actorId,
        cleanupId: input.cleanupId,
        geoid: cleanup.jurisdictionGeoid,
        entries: input.entries.map((entry) => ({ ...entry, hours: round2(entry.hours) })),
        dailyCapHours: DAILY_HOURS_CAP,
        weeklyFlagHours: deps.weeklyFlagHours ?? WEEKLY_HOURS_FLAG_DEFAULT,
      })
      await deps.insightsInvalidator?.bumpInsightsGeneration(input.cleanupId)
      await reportAnomalies(result.anomalies, input.cleanupId)
      await notifyHoursLogged(
        { id: input.cleanupId, title: cleanup.title },
        result.changed,
        input.actorId,
      )
      return { credited: result.credited }
    },

    async leaderboard(
      geoid: string,
      query: LeaderboardQuery,
      viewerId: string | null = null,
    ): Promise<LeaderboardResponse> {
      const limit = clampLimit(query.limit)
      const offset = clampOffset(query.offset)
      const withExtras = query.limit === undefined || limit >= LEADERBOARD_EXTRAS_MIN_LIMIT
      const page = await deps.repo.leaderboard(geoid, limit, offset, viewerId, withExtras)
      return {
        geoid,
        jurisdictionName: page.jurisdictionName,
        entries: page.entries,
        nextOffset: reachableNextOffset(page.nextOffset),
        ...(page.participantCount !== null ? { participantCount: page.participantCount } : {}),
        ...(viewerId !== null && withExtras
          ? { viewerRank: page.viewerRank, viewerHours: page.viewerHours }
          : {}),
      }
    },
  }
}
