import {
  AppError,
  MAX_INSIGHTS_ARRIVAL_BUCKETS,
  MAX_INSIGHTS_BROADCASTS,
  MAX_INSIGHTS_TICKET_TYPES,
  MAX_INSIGHTS_TOP_VOLUNTEERS,
  MAX_INSIGHTS_TREND_DAYS,
  type ArrivalOffsetBucket,
  type EventInsights,
  type EventInsightsClock,
  type EventInsightsReturning,
  type EventPhase,
  type InsightsBroadcast,
  type InsightsSourceCount,
  type InsightsTicketType,
  type LeaderboardEntryDTO,
  type SeatPoint,
} from "@civfix/shared"
import { DEFAULT_DURATION_MS } from "@civfix/shared/host"
import type {
  AnalyticsRepository,
  EventClockRecord,
  SeatTrendPoint,
} from "./analytics-repository.drizzle.js"
import {
  hostAnalyticsCacheKey,
  perViewerScope,
  type HostAnalyticsCache,
} from "./host-analytics-cache.js"
import { leaderboardEntryOf } from "../volunteer-hours-service.js"
import type {
  CheckinCountersRecord,
  HostRegistrationRepository,
} from "./registration-repository.types.js"
import { CHECKIN_COARSEN_DAYS } from "./registration-retention.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"
import { DAY_MS, clockPhase } from "./host-analytics-shaping.js"

export const INSIGHTS_LIVE_CACHE_TTL_SEC = 15

export const INSIGHTS_CACHE_TTL_SEC = 300

const INSIGHTS_PORTFOLIO_EVENT_LIMIT = 200

const INSIGHTS_RETURNING_MIN_EVENTS = 2

const INSIGHTS_ARRIVAL_MIN_OFFSET_MIN = -120

const INSIGHTS_ARRIVAL_MAX_OFFSET_MIN = 240

const MINUTE_MS = 60_000

const INSIGHTS_CACHE_ENDPOINT = "insights"
const ENDED_CACHE_RANGE = "event:ended"
const OPEN_CACHE_RANGE = "event"

type InsightsAnalyticsRepository = Pick<
  AnalyticsRepository,
  | "eventClock"
  | "seatTrend"
  | "registrationsBySource"
  | "broadcastsForEvent"
  | "eventHoursTotals"
  | "returningAttendees"
  | "hostedEventIds"
  | "topVolunteers"
>

export interface InsightsServiceDeps {
  analytics: InsightsAnalyticsRepository
  registrations: Pick<HostRegistrationRepository, "checkinCounters">
  cache: HostAnalyticsCache
  now?: () => Date
}

export interface InsightsViewer {
  userId: string
  viewerScope: string
}

export interface InsightsService {
  insights(cleanupId: string, viewer: InsightsViewer): Promise<EventInsights>
}

function endOf(clock: EventClockRecord): number {
  const startsAt = clock.scheduledAt.getTime()
  return clock.endsAt?.getTime() ?? startsAt + DEFAULT_DURATION_MS
}

function cumulativeTrend(points: readonly SeatTrendPoint[]): SeatPoint[] {
  let running = 0
  const trend: SeatPoint[] = []
  for (const point of points.slice(0, MAX_INSIGHTS_TREND_DAYS)) {
    running += point.added - point.removed
    trend.push({ day: point.day, seats: running })
  }
  return trend
}

function cancelledSeats(points: readonly SeatTrendPoint[]): number {
  return points.reduce((sum, point) => sum + point.removed, 0)
}

function arrivalBuckets(
  arrivals: CheckinCountersRecord["arrivals"],
  startsAt: Date,
): ArrivalOffsetBucket[] {
  const byOffset = new Map<number, number>()
  for (const bucket of arrivals) {
    const offsetMin = Math.round((bucket.at.getTime() - startsAt.getTime()) / MINUTE_MS)
    if (offsetMin < INSIGHTS_ARRIVAL_MIN_OFFSET_MIN) continue
    if (offsetMin > INSIGHTS_ARRIVAL_MAX_OFFSET_MIN) continue
    byOffset.set(offsetMin, (byOffset.get(offsetMin) ?? 0) + bucket.count)
  }
  return [...byOffset]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_INSIGHTS_ARRIVAL_BUCKETS)
    .map(([offsetMin, seats]) => ({ offsetMin, seats }))
}

function clockOf(clock: EventClockRecord): EventInsightsClock {
  return {
    status: clock.status,
    startsAt: clock.scheduledAt.toISOString(),
    endsAt: clock.endsAt?.toISOString() ?? null,
    completedAt: clock.completedAt?.toISOString() ?? null,
    registrationClosesAt: clock.registrationClosesAt?.toISOString() ?? null,
    timezone: clock.timezone ?? DEFAULT_EVENT_TIME_ZONE,
  }
}

function ticketTypes(counters: CheckinCountersRecord): InsightsTicketType[] {
  return counters.byTicketType.slice(0, MAX_INSIGHTS_TICKET_TYPES).map((type) => ({
    ticketTypeId: type.ticketTypeId,
    name: type.name,
    registered: type.registered,
    capacity: type.capacity,
    waitlisted: type.waitlisted,
    checkedIn: type.checkedIn,
  }))
}

export function makeInsightsService(deps: InsightsServiceDeps): InsightsService {
  const now = deps.now ?? (() => new Date())

  async function returningOf(
    cleanupId: string,
    viewer: InsightsViewer,
    phase: EventPhase,
  ): Promise<EventInsightsReturning | null> {
    if (phase !== "ended") return null
    const hostedEventIds = await deps.analytics.hostedEventIds(
      viewer.userId,
      null,
      INSIGHTS_PORTFOLIO_EVENT_LIMIT,
    )
    if (hostedEventIds.length < INSIGHTS_RETURNING_MIN_EVENTS) return null
    return deps.analytics.returningAttendees(cleanupId, hostedEventIds)
  }

  async function topVolunteersOf(
    cleanupId: string,
    phase: EventPhase,
  ): Promise<LeaderboardEntryDTO[]> {
    if (phase !== "ended") return []
    const rows = await deps.analytics.topVolunteers([cleanupId], MAX_INSIGHTS_TOP_VOLUNTEERS)
    return rows.map((row, index) => leaderboardEntryOf(row, index + 1))
  }

  async function compute(
    cleanupId: string,
    viewer: InsightsViewer,
    clock: EventClockRecord,
    phase: EventPhase,
    at: Date,
  ): Promise<EventInsights> {
    const [counters, trend, bySource, broadcasts, hours, topVolunteers, returning] =
      await Promise.all([
        deps.registrations.checkinCounters(cleanupId),
        deps.analytics.seatTrend(cleanupId, clock.timezone ?? DEFAULT_EVENT_TIME_ZONE),
        deps.analytics.registrationsBySource(cleanupId),
        deps.analytics.broadcastsForEvent(cleanupId, MAX_INSIGHTS_BROADCASTS),
        deps.analytics.eventHoursTotals(cleanupId),
        topVolunteersOf(cleanupId, phase),
        returningOf(cleanupId, viewer, phase),
      ])

    const coarsened = at.getTime() - endOf(clock) > CHECKIN_COARSEN_DAYS * DAY_MS

    const sources: InsightsSourceCount[] = bySource.map((row) => ({
      source: row.source,
      seats: row.seats,
    }))

    const sent: InsightsBroadcast[] = broadcasts.map((broadcast) => ({
      id: broadcast.id,
      kind: broadcast.kind,
      finishedAt: broadcast.finishedAt?.toISOString() ?? null,
      recipients: broadcast.recipients,
      sent: broadcast.sent,
      failed: broadcast.failed,
      suppressed: broadcast.suppressed,
    }))

    return {
      generatedAt: at.toISOString(),
      phase,
      clock: clockOf(clock),
      seats: {
        registered: counters.registered,
        capacity: counters.capacity,
        waitlisted: counters.waitlisted,
        cancelled: cancelledSeats(trend),
        checkedIn: counters.checkedIn,
        noShow: counters.noShow,
        unmarked: Math.max(counters.registered - counters.checkedIn - counters.noShow, 0),
      },
      registrationTrend: cumulativeTrend(trend),
      byTicketType: ticketTypes(counters),
      bySource: sources,
      broadcasts: sent,
      arrivals: coarsened ? [] : arrivalBuckets(counters.arrivals, clock.scheduledAt),
      hours: {
        credited: hours.credited,
        attendeesCredited: hours.attendeesCredited,
        attendeesCheckedIn: hours.attendeesCheckedIn,
      },
      topVolunteers,
      returning,
    }
  }

  return {
    async insights(cleanupId, viewer) {
      const clock = await deps.analytics.eventClock(cleanupId)
      if (clock === null) throw AppError.notFound("Cleanup not found")
      const at = now()
      const phase = clockPhase(clock, at)
      const generation = await deps.cache.generationOf(cleanupId)
      const rollups = await deps.cache.getOrSet(
        hostAnalyticsCacheKey({
          endpoint: INSIGHTS_CACHE_ENDPOINT,
          scope: cleanupId,
          range: phase === "ended" ? ENDED_CACHE_RANGE : OPEN_CACHE_RANGE,
          viewerScope: perViewerScope(viewer),
          generation,
        }),
        () => compute(cleanupId, viewer, clock, phase, at),
        phase === "live" ? INSIGHTS_LIVE_CACHE_TTL_SEC : INSIGHTS_CACHE_TTL_SEC,
      )
      return { ...rollups, phase, clock: clockOf(clock) }
    },
  }
}
