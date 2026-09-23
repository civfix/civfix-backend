import {
  ANALYTICS_SUPPRESSION_K,
  AppError,
  EVENT_ANALYTICS_CARD_SERIES_POINTS,
  EVENT_ANALYTICS_CARD_SLOT_ROWS,
  EVENT_ANALYTICS_COMPARISON_MIN_EVENTS,
  EVENT_ANALYTICS_COMPARISON_WINDOW,
  MAX_EVENT_ANALYTICS_ARRIVAL_BUCKETS,
  MAX_EVENT_ANALYTICS_PANEL_ROWS,
  MAX_EVENT_ANALYTICS_SERIES_POINTS,
  type BreakdownRow,
  type EventAnalyticsPhase,
  type EventAnalyticsScope,
  type FunnelStep,
  type GetEventAnalyticsResponse,
  type Panel,
  type SeriesPoint,
  type SuppressedRate,
} from "@civfix/shared"
import {
  breakdown,
  dailySeries,
  eventPhase,
  funnel,
  seriesClosure,
  suppressRate,
  type DayCount,
  type DayRange,
  type DerivedBreakdownRow,
  type DerivedPanel,
  type KeyCount,
  type SeriesClosure,
} from "@civfix/shared/host"
import type { AnalyticsRepository, EventClockRecord } from "./analytics-repository.drizzle.js"
import type { EventAnalyticsRepository } from "./event-analytics-repository.drizzle.js"
import type { MetricRow, MetricsRepository } from "./metrics-repository.drizzle.js"
import { hostAnalyticsCacheKey, type HostAnalyticsCache } from "./host-analytics-cache.js"
import { eventDayKey } from "./event-day.js"
import { DEFAULT_EVENT_TIME_ZONE } from "./event-fields.js"
import { ARRIVAL_SAMPLE_LIMIT } from "./analytics-service.js"

export const EVENT_ANALYTICS_LIFECYCLE_DAYS = MAX_EVENT_ANALYTICS_SERIES_POINTS
export const EVENT_ANALYTICS_ARCHIVE_DAYS = 30
export const EVENT_ANALYTICS_ARRIVAL_BUCKET_MIN = 15
export const EVENT_ANALYTICS_DELTA_DAYS = 7
export const DAY_MS = 86_400_000

export interface EventAnalyticsServiceDeps {
  analytics: AnalyticsRepository
  events: EventAnalyticsRepository
  metrics: MetricsRepository
  cache: HostAnalyticsCache
  now?: () => Date
}

export interface EventAnalyticsViewer {
  userId: string
  organizationId: string | null
  viewerScope: string
}

export interface EventAnalyticsService {
  analytics(
    cleanupId: string,
    scope: EventAnalyticsScope,
    viewer: EventAnalyticsViewer,
  ): Promise<GetEventAnalyticsResponse>
}

function shiftDayKey(day: string, deltaDays: number): string {
  const [year, month, date] = day.split("-").map(Number)
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1) + deltaDays * DAY_MS)
  return shifted.toISOString().slice(0, 10)
}

function emptyRate(): SuppressedRate {
  return { value: null, numerator: null, denominator: null, suppressed: true }
}

function toRate(numerator: number, denominator: number): SuppressedRate {
  const ratio = suppressRate(numerator, denominator)
  return {
    value: ratio.value,
    numerator: ratio.suppressed ? null : numerator,
    denominator: ratio.suppressed ? null : denominator,
    suppressed: ratio.suppressed,
  }
}

function toSeries(
  points: readonly { day: string; value: number | null; suppressed: boolean }[],
): SeriesPoint[] {
  return points.map((point) => ({
    day: point.day,
    value: point.value,
    suppressed: point.suppressed,
  }))
}

function toPanel(panel: DerivedPanel<DerivedBreakdownRow>): Panel {
  return {
    panelSuppressed: panel.panelSuppressed,
    rows: panel.rows.slice(0, MAX_EVENT_ANALYTICS_PANEL_ROWS).map(
      (row): BreakdownRow => ({
        key: row.key,
        label: row.key,
        value: row.value,
        suppressed: row.suppressed,
      }),
    ),
  }
}

function toFunnelSteps(
  panel: DerivedPanel<{ key: string; value: number | null; suppressed: boolean }>,
): FunnelStep[] {
  return panel.rows.map((row) => ({
    step: row.key,
    label: row.key,
    value: row.value,
    suppressed: row.suppressed,
  }))
}

function metricTotal(rows: readonly MetricRow[], metric: string): number | null {
  const matching = rows.filter((row) => row.metric === metric)
  if (matching.length === 0) return null
  return matching.reduce((acc, row) => acc + row.value, 0)
}

function seriesOf(rows: readonly MetricRow[], metric: string): DayCount[] {
  const byDay = new Map<string, number>()
  for (const row of rows) {
    if (row.metric !== metric) continue
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.value)
  }
  return [...byDay].map(([day, count]) => ({ day, count }))
}

function tailSum(points: readonly { value: number | null }[], days: number): number | null {
  const tail = points.slice(-days)
  let total = 0
  for (const point of tail) {
    if (point.value === null) return null
    total += point.value
  }
  return total
}

function closureAllowsTotal(closure: SeriesClosure): boolean {
  return closure.panelSuppressed || closure.totalPublishable
}

export function analyticsPhaseOf(clock: EventClockRecord, at: Date): EventAnalyticsPhase {
  const phase = eventPhase(
    {
      status: clock.status,
      scheduledAt: clock.scheduledAt.toISOString(),
      endsAt: clock.endsAt?.toISOString() ?? null,
      completedAt: clock.completedAt?.toISOString() ?? null,
    },
    at.getTime(),
  )
  if (phase === "live") return "day_of"
  if (phase !== "ended") return "upcoming"
  const endedAt = clock.completedAt ?? clock.endsAt ?? clock.scheduledAt
  return at.getTime() - endedAt.getTime() > EVENT_ANALYTICS_ARCHIVE_DAYS * DAY_MS
    ? "archived"
    : "completed"
}

export function arrivalBuckets(offsets: readonly number[]): SeriesPoint[] {
  const byBucket = new Map<number, number>()
  for (const offset of offsets) {
    const bucket = Math.floor(offset / EVENT_ANALYTICS_ARRIVAL_BUCKET_MIN)
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1)
  }
  return [...byBucket]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_EVENT_ANALYTICS_ARRIVAL_BUCKETS)
    .map(([bucket, count]) => ({
      day: String(bucket * EVENT_ANALYTICS_ARRIVAL_BUCKET_MIN),
      value: count,
      suppressed: false,
    }))
}

export function makeEventAnalyticsService(deps: EventAnalyticsServiceDeps): EventAnalyticsService {
  const now = deps.now ?? (() => new Date())

  function lifecycleWindow(clock: EventClockRecord, timezone: string): DayRange {
    const to = eventDayKey(now(), timezone)
    const from = eventDayKey(clock.createdAt, timezone)
    const earliest = shiftDayKey(to, 1 - EVENT_ANALYTICS_LIFECYCLE_DAYS)
    return { from: from < earliest ? earliest : from, to }
  }

  async function comparisonOf(
    cleanupId: string,
    viewer: EventAnalyticsViewer,
  ): Promise<GetEventAnalyticsResponse["comparison"]> {
    const ids = await deps.events.previousCompletedEventIds({
      userId: viewer.userId,
      organizationId: viewer.organizationId,
      excludeCleanupId: cleanupId,
      limit: EVENT_ANALYTICS_COMPARISON_WINDOW,
    })
    if (ids.length < EVENT_ANALYTICS_COMPARISON_MIN_EVENTS) return null
    const medians = await deps.events.comparisonMedians(ids)
    return {
      sampleSize: medians.sampleSize,
      medians: {
        signups: medians.signups,
        checkInRate: medians.checkInRate,
        hoursPerVolunteer: medians.hoursPerVolunteer,
        fillRate: medians.fillRate,
      },
    }
  }

  async function compute(
    cleanupId: string,
    scope: EventAnalyticsScope,
    viewer: EventAnalyticsViewer,
    clock: EventClockRecord,
    phase: EventAnalyticsPhase,
    at: Date,
  ): Promise<GetEventAnalyticsResponse> {
    const timezone = clock.timezone ?? DEFAULT_EVENT_TIME_ZONE
    const window = lifecycleWindow(clock, timezone)
    const full = scope === "full"

    const [
      kpis,
      facts,
      metricRows,
      registrationDays,
      cancellationDays,
      offsets,
      waitlist,
      hours,
      bySource,
      registrationsBySlot,
      checkinsBySlot,
      hoursBuckets,
      reportStatuses,
      comparison,
    ] = await Promise.all([
      deps.analytics.eventKpis(cleanupId),
      deps.events.facts(cleanupId),
      deps.metrics.read(cleanupId, ["page_views", "donation_clicks"], window.from, window.to),
      deps.analytics.registrationsByDay(cleanupId, timezone, window.from, window.to),
      deps.analytics.cancellationsByDay(cleanupId, timezone, window.from, window.to),
      deps.analytics.arrivalOffsets(cleanupId, ARRIVAL_SAMPLE_LIMIT),
      deps.analytics.waitlistConversion(cleanupId),
      deps.analytics.eventHoursTotals(cleanupId),
      deps.analytics.registrationsBySource(cleanupId),
      deps.events.registrationsBySlot(cleanupId),
      full ? deps.analytics.checkinsBySlot(cleanupId) : Promise.resolve<KeyCount[]>([]),
      full ? deps.events.hoursBuckets(cleanupId) : Promise.resolve<KeyCount[]>([]),
      full ? deps.events.reportStatuses(cleanupId) : Promise.resolve<KeyCount[]>([]),
      full ? comparisonOf(cleanupId, viewer) : Promise.resolve(null),
    ])

    const closure = seriesClosure(registrationDays, window, { suppressPoints: true })
    const registeredPublishable = closureAllowsTotal(closure)
    const cancellations = dailySeries(cancellationDays, window, { suppressPoints: true })
    const viewsSeries = dailySeries(seriesOf(metricRows, "page_views"), window)
    const pageViews = metricTotal(metricRows, "page_views")
    const donationClicks = metricTotal(metricRows, "donation_clicks")

    const steps: KeyCount[] = [
      { key: "signups", count: kpis.registered },
      { key: "checked_in", count: kpis.checkedIn },
      { key: "logged_hours", count: hours.attendeesCredited },
    ]

    const cumulative = toSeries(closure.cumulative)
    const daily = toSeries(closure.daily)
    const viewsDaily = toSeries(viewsSeries.points)
    const arrivals = arrivalBuckets(offsets)

    const response: GetEventAnalyticsResponse = {
      generatedAt: at.toISOString(),
      k: ANALYTICS_SUPPRESSION_K,
      scope,
      phase,
      lifecycle: {
        createdAt: clock.createdAt.toISOString(),
        startAt: clock.scheduledAt.toISOString(),
        endAt: clock.endsAt?.toISOString() ?? null,
        completedAt: clock.completedAt?.toISOString() ?? null,
      },
      kpis: {
        signups: kpis.registered,
        capacity: kpis.capacity,
        waitlisted: kpis.waitlisted,
        cancelled: kpis.cancelled,
        checkedIn: kpis.checkedIn,
        noShow: kpis.noShow,
        walkUps: facts.walkUps,
        pageViews,
        uniqueViewers: null,
        shares: null,
        donationClicks,
        hoursTotal: hours.credited,
        hoursVolunteers: hours.attendeesCredited,
        reportsLinked: facts.reportsLinked,
        reportsResolved: facts.reportsResolved,
        postsCreated: facts.postsCreated,
      },
      rates: {
        checkIn: registeredPublishable ? toRate(kpis.checkedIn, kpis.registered) : emptyRate(),
        noShow: registeredPublishable ? toRate(kpis.noShow, kpis.registered) : emptyRate(),
        fill:
          kpis.capacity === null || kpis.capacity === 0 || !registeredPublishable
            ? emptyRate()
            : toRate(kpis.registered, kpis.capacity),
        viewToSignup:
          pageViews === null || pageViews === 0 || !registeredPublishable
            ? emptyRate()
            : toRate(kpis.registered, pageViews),
        waitlistConversion: toRate(waitlist.promoted, waitlist.joined),
      },
      deltas: {
        signups7d: tailSum(daily, EVENT_ANALYTICS_DELTA_DAYS),
        views7d: tailSum(viewsDaily, EVENT_ANALYTICS_DELTA_DAYS),
      },
      signups: {
        cumulative: full ? cumulative : cumulative.slice(-EVENT_ANALYTICS_CARD_SERIES_POINTS),
        daily: full ? daily : [],
        cancellations: full ? toSeries(cancellations.points) : [],
        bySlot: cardSlotPanel(registrationsBySlot, registeredPublishable, full),
        ...(full
          ? {
              bySource: toPanel(
                breakdown(
                  bySource.map((row) => ({ key: row.source, count: row.seats })),
                  { totalPublishable: registeredPublishable },
                ),
              ),
            }
          : {}),
      },
      reach: {
        viewsDaily: full ? viewsDaily : viewsDaily.slice(-EVENT_ANALYTICS_CARD_SERIES_POINTS),
        funnel: full ? toFunnelSteps(funnel(steps)) : [],
      },
      eventDay: {
        arrivals: full ? arrivals : arrivals.slice(-EVENT_ANALYTICS_CARD_SERIES_POINTS),
        ...(full ? { bySlot: toPanel(breakdown(checkinsBySlot)) } : {}),
      },
      impact: full
        ? {
            hoursBuckets: toPanel(breakdown(hoursBuckets)),
            reportStatuses: toPanel(breakdown(reportStatuses)),
          }
        : {},
      comparison,
    }
    return response
  }

  function cardSlotPanel(
    rows: readonly KeyCount[],
    registeredPublishable: boolean,
    full: boolean,
  ): Panel {
    const panel = toPanel(breakdown(rows, { totalPublishable: registeredPublishable }))
    if (full) return panel
    return { ...panel, rows: panel.rows.slice(0, EVENT_ANALYTICS_CARD_SLOT_ROWS) }
  }

  return {
    async analytics(cleanupId, scope, viewer) {
      const clock = await deps.analytics.eventClock(cleanupId)
      if (clock === null) throw AppError.notFound("Cleanup not found")
      const at = now()
      const phase = analyticsPhaseOf(clock, at)
      const generation = await deps.cache.generationOf(cleanupId)
      return deps.cache.getOrSet(
        hostAnalyticsCacheKey({
          endpoint: "event-analytics",
          scope: cleanupId,
          range: `${scope}:${phase}`,
          viewerScope: `${viewer.viewerScope}:${viewer.userId}`,
          generation,
        }),
        () => compute(cleanupId, scope, viewer, clock, phase, at),
      )
    },
  }
}
