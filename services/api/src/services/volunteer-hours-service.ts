import { AppError, MAX_EVENT_HOURS, MAX_EVENT_HOURS_ENTRIES, MIN_EVENT_HOURS } from "@civfix/shared"
import type {
  CleanupMemberRole,
  CleanupStatus,
  EventHoursEntry,
  EventHoursResponse,
  LeaderboardEntryDTO,
  LeaderboardQuery,
  LeaderboardResponse,
  LogEventHoursResponse,
  MyVolunteerHoursDTO,
  MyVolunteerHoursEntriesQuery,
  MyVolunteerHoursEntriesResponse,
  OrganizationRefDTO,
  PublicVolunteerHoursQuery,
  PublicVolunteerHoursResponse,
  VolunteerHoursEntryDTO,
  VolunteerHoursSource,
} from "@civfix/shared"
import { can, type HostStanding } from "@civfix/shared/host"
import { parseTimeCursor, type TimeCursor } from "../db/cursor-helpers.js"
import { MIN_EVENT_DURATION_MS } from "./cleanup-rules.js"
import { mapWithLimit } from "./media-presign.js"
import type { AffiliationLoader } from "./affiliation.js"
import type { NotificationService } from "./notification-service.js"

export const LEADERBOARD_DEFAULT_LIMIT = 20
export const LEADERBOARD_MAX_LIMIT = 50
export const LEADERBOARD_MAX_OFFSET = 500
export const EVENT_HOURS_MEMBER_CAP = 2000

export { MAX_EVENT_HOURS_ENTRIES } from "@civfix/shared"

export const HOURS_ENTRIES_DEFAULT_LIMIT = 20
export const HOURS_ENTRIES_MAX_LIMIT = 50

export const LEADERBOARD_EXTRAS_MIN_LIMIT = 25

export const HOURS_NOTIFY_CONCURRENCY = 8


export const EVENT_WINDOW_GRACE_MS = 60 * 60 * 1000

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

export function creditableHoursForEvent(cleanup: {
  scheduledAt: Date
  completedAt: Date | null
}): number | null {
  const windowMs = eventDurationMs(cleanup)
  if (windowMs === null) return null
  if (windowMs <= 0) return 0
  const hours = (windowMs + EVENT_WINDOW_GRACE_MS) / (60 * 60 * 1000)
  return Math.min(MAX_EVENT_HOURS, Math.round(hours * 100) / 100)
}

export function eventDurationMs(cleanup: {
  scheduledAt: Date
  completedAt: Date | null
}): number | null {
  if (cleanup.completedAt === null) return null
  return cleanup.completedAt.getTime() - cleanup.scheduledAt.getTime()
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
  cursor: TimeCursor | null
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

export interface VolunteerHoursRepository {
  logEventHours(args: LogEventHoursArgs): Promise<LogEventHoursResult>
  totalsFor(userId: string): Promise<MyVolunteerHoursDTO>
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
  jurisdictionGeoid: string | null
  title: string
  scheduledAt: Date
  completedAt: Date | null
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

function clampEntriesLimit(limit: number | undefined): number {
  if (limit === undefined) return HOURS_ENTRIES_DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), HOURS_ENTRIES_MAX_LIMIT)
}

function neutralPublicHours(): PublicVolunteerHoursResponse {
  return {
    visible: true,
    totalHours: 0,
    byJurisdiction: [],
    items: [],
    reportHours: 0,
    nextCursor: null,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function entriesWithCreditorAffiliation(
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

export function toVolunteerHoursEntryDTO(view: VolunteerHoursEntryView): VolunteerHoursEntryDTO {
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

export function makeVolunteerHoursService(deps: VolunteerHoursServiceDeps): VolunteerHoursService {
  async function standingFor(cleanupId: string, userId: string): Promise<HostStanding> {
    if (deps.cleanups.standingOf !== undefined) {
      return deps.cleanups.standingOf(cleanupId, userId)
    }
    return { eventRole: await deps.cleanups.roleOf(cleanupId, userId), orgRole: null }
  }

  async function notifyHoursLogged(
    cleanup: { id: string; title: string },
    changed: LogEventHoursResult["changed"],
    actorId: string,
  ): Promise<void> {
    const notifier = deps.notifier
    if (notifier === undefined) return
    const recipients = changed.filter(
      (c) =>
        c.userId !== actorId && (c.previousHours === null || c.hours > c.previousHours),
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

  return {
    getMyHours(userId: string): Promise<MyVolunteerHoursDTO> {
      return deps.repo.totalsFor(userId)
    },

    async getMyHoursEntries(
      userId: string,
      query: MyVolunteerHoursEntriesQuery,
    ): Promise<MyVolunteerHoursEntriesResponse> {
      const limit = clampEntriesLimit(query.limit)
      const [page, totalHours] = await Promise.all([
        deps.repo.listEntries({ userId, cursor: parseTimeCursor(query.cursor), limit }),
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
              cursor: parseTimeCursor(query.cursor),
              limit,
              sources: ["event"],
            })
          : Promise.resolve({ items: [], nextCursor: null }),
      ])

      return {
        visible: true,
        totalHours: totals.totalHours,
        byJurisdiction: totals.byJurisdiction,
        items: await entriesWithCreditorAffiliation(deps.affiliations, page.items, viewerId),
        reportHours: 0,
        nextCursor: page.nextCursor,
      }
    },

    async getEventHours(cleanupId: string, viewerId: string): Promise<EventHoursResponse> {
      const cleanup = await deps.cleanups.load(cleanupId)
      if (cleanup === null) throw AppError.notFound("Event not found")

      const standing = await standingFor(cleanupId, viewerId)
      if (standing.eventRole === null && standing.orgRole === null) {
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
      const cleanup = await deps.cleanups.load(input.cleanupId)
      if (cleanup === null) throw AppError.notFound("Event not found")

      const actorStanding = await standingFor(input.cleanupId, input.actorId)
      if (!can(actorStanding, "manage_event")) {
        throw AppError.forbidden("Only the event hosts can log volunteer hours.")
      }
      if (cleanup.status !== "done") {
        throw AppError.conflict("Volunteer hours can only be logged for a completed event.")
      }
      const durationMs = eventDurationMs(cleanup)
      if (durationMs !== null && durationMs < MIN_EVENT_DURATION_MS) {
        throw AppError.conflict(
          `This event ran for less than ${MIN_EVENT_DURATION_MS / 60_000} minutes, so no volunteer hours can be logged against it.`,
        )
      }
      const windowCap = creditableHoursForEvent(cleanup)

      if (input.entries.length > MAX_EVENT_HOURS_ENTRIES) {
        throw AppError.validation({
          entries: `at most ${MAX_EVENT_HOURS_ENTRIES} attendees may be credited in one request`,
        })
      }

      const seen = new Set<string>()
      for (const entry of input.entries) {
        if (entry.userId === input.actorId) {
          throw AppError.forbidden(
            "You can't log volunteer hours for yourself — another host must credit you.",
          )
        }
        if (!(entry.hours >= MIN_EVENT_HOURS) || entry.hours > MAX_EVENT_HOURS) {
          throw AppError.validation({
            entries: `hours must be at least ${MIN_EVENT_HOURS} and at most ${MAX_EVENT_HOURS}`,
          })
        }
        if (windowCap !== null && entry.hours > windowCap) {
          throw AppError.validation({
            entries: `this event ran for ${round2((durationMs ?? 0) / 3_600_000)} h, so at most ${windowCap} h may be credited per attendee`,
          })
        }
        if (seen.has(entry.userId)) {
          throw AppError.validation({ entries: `duplicate userId: ${entry.userId}` })
        }
        seen.add(entry.userId)
      }
      const memberIds = new Set(
        await deps.cleanups.listMemberIds(input.cleanupId, EVENT_HOURS_MEMBER_CAP),
      )
      const nonMembers = input.entries.filter((e) => !memberIds.has(e.userId))
      if (nonMembers.length > 0) {
        throw AppError.validation({
          entries: `not attending this event: ${nonMembers.map((e) => e.userId).join(", ")}`,
        })
      }

      const result = await deps.repo.logEventHours({
        actorId: input.actorId,
        cleanupId: input.cleanupId,
        geoid: cleanup.jurisdictionGeoid,
        entries: input.entries.map((entry) => ({ ...entry, hours: round2(entry.hours) })),
        dailyCapHours: DAILY_HOURS_CAP,
        weeklyFlagHours: deps.weeklyFlagHours ?? WEEKLY_HOURS_FLAG_DEFAULT,
      })
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
        nextOffset: page.nextOffset,
        ...(page.participantCount !== null ? { participantCount: page.participantCount } : {}),
        ...(viewerId !== null && withExtras
          ? { viewerRank: page.viewerRank, viewerHours: page.viewerHours }
          : {}),
      }
    },
  }
}
