import {
  AppError,
  MAX_INSIGHTS_ARRIVAL_BUCKETS,
  MAX_INSIGHTS_BROADCASTS,
  MAX_INSIGHTS_TICKET_TYPES,
  MAX_INSIGHTS_TREND_DAYS,
  type ArrivalOffsetBucket,
  type EventInsights,
  type EventInsightsMoney,
  type EventInsightsReturning,
  type EventPhase,
  type InsightsBroadcast,
  type InsightsSourceCount,
  type InsightsTicketType,
  type SeatPoint,
} from "@civfix/shared"
import { eventPhase, DEFAULT_DURATION_MS } from "@civfix/shared/host"
import type {
  AnalyticsRepository,
  EventClockRecord,
  SeatTrendPoint,
} from "./analytics-repository.drizzle.js"
import { hostAnalyticsCacheKey, type HostAnalyticsCache } from "./host-analytics-cache.js"
import type { CheckinCountersRecord, HostRegistrationRepository } from "./registration-repository.types.js"
import { CHECKIN_COARSEN_DAYS } from "./registration-retention.js"
import type { DonationRepository } from "../payments/donation-repository.drizzle.js"

export const INSIGHTS_LIVE_CACHE_TTL_SEC = 15

export const INSIGHTS_CACHE_TTL_SEC = 300

export const INSIGHTS_PORTFOLIO_EVENT_LIMIT = 200

export const INSIGHTS_RETURNING_MIN_EVENTS = 2

export const INSIGHTS_ARRIVAL_MIN_OFFSET_MIN = -120

export const INSIGHTS_ARRIVAL_MAX_OFFSET_MIN = 240

const DAY_MS = 86_400_000

type InsightsAnalyticsRepository = Pick<
  AnalyticsRepository,
  | "eventClock"
  | "seatTrend"
  | "registrationsBySource"
  | "broadcastsForEvent"
  | "eventHoursTotals"
  | "returningAttendees"
  | "hostedEventIds"
>

export interface InsightsServiceDeps {
  analytics: InsightsAnalyticsRepository
  registrations: Pick<HostRegistrationRepository, "checkinCounters">
  donations: Pick<DonationRepository, "eventTotals">
  cache: HostAnalyticsCache
  now?: () => Date
}

export interface InsightsViewer {
  userId: string
  canViewDonations: boolean
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
    const raw = Math.round((bucket.at.getTime() - startsAt.getTime()) / 60_000)
    const offsetMin = Math.min(
      Math.max(raw, INSIGHTS_ARRIVAL_MIN_OFFSET_MIN),
      INSIGHTS_ARRIVAL_MAX_OFFSET_MIN,
    )
    byOffset.set(offsetMin, (byOffset.get(offsetMin) ?? 0) + bucket.count)
  }
  return [...byOffset]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_INSIGHTS_ARRIVAL_BUCKETS)
    .map(([offsetMin, seats]) => ({ offsetMin, seats }))
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

  async function compute(
    cleanupId: string,
    viewer: InsightsViewer,
    clock: EventClockRecord,
    phase: EventPhase,
    at: Date,
  ): Promise<EventInsights> {
    const [counters, trend, bySource, broadcasts, hours, hostedEventIds, money] = await Promise.all([
      deps.registrations.checkinCounters(cleanupId),
      deps.analytics.seatTrend(cleanupId, clock.timezone ?? "UTC"),
      deps.analytics.registrationsBySource(cleanupId),
      deps.analytics.broadcastsForEvent(cleanupId, MAX_INSIGHTS_BROADCASTS),
      deps.analytics.eventHoursTotals(cleanupId),
      deps.analytics.hostedEventIds(viewer.userId, null, INSIGHTS_PORTFOLIO_EVENT_LIMIT),
      viewer.canViewDonations ? deps.donations.eventTotals(cleanupId) : Promise.resolve(null),
    ])

    const returning: EventInsightsReturning | null =
      hostedEventIds.length < INSIGHTS_RETURNING_MIN_EVENTS
        ? null
        : await deps.analytics.returningAttendees(cleanupId, hostedEventIds)

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

    const donations: EventInsightsMoney | null =
      money === null
        ? null
        : {
            currency: "USD",
            donationCount: money.donationCount,
            grossMinor: money.grossMinor,
            netMinor: Math.max(money.netMinor, 0),
            refundedMinor: money.refundedMinor,
            lastChargedAt: money.lastChargedAt?.toISOString() ?? null,
          }

    return {
      generatedAt: at.toISOString(),
      phase,
      clock: {
        status: clock.status,
        startsAt: clock.scheduledAt.toISOString(),
        endsAt: clock.endsAt?.toISOString() ?? null,
        completedAt: clock.completedAt?.toISOString() ?? null,
        registrationClosesAt: clock.registrationClosesAt?.toISOString() ?? null,
        timezone: clock.timezone ?? "UTC",
      },
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
      money: donations,
      returning,
    }
  }

  return {
    async insights(cleanupId, viewer) {
      const clock = await deps.analytics.eventClock(cleanupId)
      if (clock === null) throw AppError.notFound("Cleanup not found")
      const at = now()
      const phase = eventPhase(
        {
          status: clock.status,
          scheduledAt: clock.scheduledAt.toISOString(),
          endsAt: clock.endsAt?.toISOString() ?? null,
          completedAt: clock.completedAt?.toISOString() ?? null,
        },
        at.getTime(),
      )
      return deps.cache.getOrSet(
        hostAnalyticsCacheKey({
          endpoint: "insights",
          scope: cleanupId,
          range: "event",
          viewerScope: `${viewer.viewerScope}:${viewer.userId}`,
        }),
        () => compute(cleanupId, viewer, clock, phase, at),
        phase === "live" ? INSIGHTS_LIVE_CACHE_TTL_SEC : INSIGHTS_CACHE_TTL_SEC,
      )
    },
  }
}
